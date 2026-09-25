/**
 * The `vibe` session projection. It folds only event types the harness
 * already knows, so a vibe session always reloads:
 *
 * - `command/run` / `command/done` of `/vibe` decide the logged mode (the same
 *   pairing dsh-plan-mode folds);
 * - `subagent/catalog` rows labelled `fast:<name>` / `good:<name>` while the
 *   mode is on record the worker roster and each worker's tier;
 * - a successful `vibe_kill` tool call marks its worker terminal;
 * - leaving the mode clears the roster, so workers never outlive the mode.
 */
import { z as zod } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Tier } from './config.ts'

export const VIBE_COMMAND = 'vibe'
export const KILL_TOOL = 'vibe_kill'

export interface VibeWorkerEntry {
  id: string
  tier: Tier
  name: string
  killed: boolean
}

export interface VibeUnitState {
  active: boolean
  running: { commandId: string; wanted: boolean } | null
  workers: VibeWorkerEntry[]
  /** `vibe_kill` tool calls awaiting their result: callId → worker id. */
  pendingKills: Record<string, string>
}

export interface VibeProjection {
  active: boolean
  workers: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    vibe: VibeUnitState
  }
  interface SessionProjectionMap {
    vibe: VibeProjection
  }
}

/** Parse the persisted `tier:name` subagent label; undefined for non-vibe children. */
export function parseWorkerLabel(label: string | undefined): { tier: Tier; name: string } | undefined {
  const match = label === undefined ? null : /^(fast|good):(.+)$/.exec(label)
  return match === null ? undefined : { tier: match[1] as Tier, name: match[2] }
}

export function workerLabel(tier: Tier, name: string): string {
  return `${tier}:${name}`
}

/** What a `/vibe` invocation asks for, given the logged mode when it ran. */
export function wantedFor(args: string, active: boolean): boolean {
  const input = args.trim()
  if (input === 'off' || input === 'stop') return false
  if (input === '') return !active
  return true
}

const workerSchema = zod.object({
  id: zod.string(),
  tier: zod.enum(['fast', 'good']),
  name: zod.string(),
  killed: zod.boolean(),
}).strict()

const stateSchema = zod.object({
  active: zod.boolean(),
  running: zod.object({ commandId: zod.string(), wanted: zod.boolean() }).strict().nullable(),
  workers: zod.array(workerSchema),
  pendingKills: zod.record(zod.string(), zod.string()),
}).strict()

const viewSchema = zod.object({ active: zod.boolean(), workers: zod.number() })

type Loose = Record<string, unknown>

export function initVibeState(): VibeUnitState {
  return { active: false, running: null, workers: [], pendingKills: {} }
}

export function applyVibeEvent(state: VibeUnitState, event: SessionEvent): VibeUnitState {
  const data = event.data as Loose
  switch (event.type as string) {
    case 'command/run': {
      if (data.name !== VIBE_COMMAND || typeof data.args !== 'string') return state
      return { ...state, running: { commandId: String(data.commandId), wanted: wantedFor(data.args, state.active) } }
    }
    case 'command/done': {
      if (state.running === null || data.commandId !== state.running.commandId) return state
      if (data.kind !== 'success') return { ...state, running: null }
      const active = state.running.wanted
      return active
        ? { ...state, active, running: null }
        : { active, running: null, workers: [], pendingKills: {} }
    }
    case 'subagent/catalog': {
      if (!state.active || data.mode !== 'continuable') return state
      const parsed = parseWorkerLabel(typeof data.label === 'string' ? data.label : undefined)
      const id = String(data.childId)
      if (parsed === undefined || state.workers.some(worker => worker.id === id)) return state
      return { ...state, workers: [...state.workers, { id, ...parsed, killed: false }] }
    }
    case 'tool/call': {
      if (!state.active || data.name !== KILL_TOOL) return state
      let target: unknown
      try {
        target = (JSON.parse(String(data.arguments)) as Loose).session
      } catch {
        return state
      }
      if (typeof target !== 'string') return state
      return { ...state, pendingKills: { ...state.pendingKills, [String(data.callId)]: target } }
    }
    case 'tool/result': {
      const block = ((data.message as Loose | undefined)?.content as Loose[] | undefined)?.[0]
      const callId = block === undefined ? undefined : String(block.toolCallId)
      if (callId === undefined || !(callId in state.pendingKills)) return state
      const { [callId]: target, ...pendingKills } = state.pendingKills
      const failed = block?.isError === true || data.error !== undefined
      return {
        ...state,
        pendingKills,
        workers: failed
          ? state.workers
          : state.workers.map(worker => worker.id === target || worker.name === target ? { ...worker, killed: true } : worker),
      }
    }
    default:
      return state
  }
}

export const vibeProjectionDefinition = {
  key: 'vibe' as const,
  stateVersion: 1,
  stateSchema,
  init: initVibeState,
  apply: applyVibeEvent,
  wire: {
    viewSchema,
    view: (state: VibeUnitState): VibeProjection => ({
      active: state.active,
      workers: state.workers.filter(worker => !worker.killed).length,
    }),
  },
}
