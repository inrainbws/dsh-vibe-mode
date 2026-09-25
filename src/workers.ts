/**
 * In-memory worker records for one director session, plus the `<vibe-turn>`
 * result block (omp's `vibe-turn-result.md` shape).
 */
import type { Tier } from './config.ts'

/**
 * `running`: a turn is in flight. `idle`: parked between turns, keeps its
 * conversation. `killed`: stopped by vibe_kill or mode exit (terminal).
 * `dead`: its child session can no longer be resolved (terminal).
 */
export type WorkerState = 'running' | 'idle' | 'killed' | 'dead'

export interface TurnActivity {
  number: number
  startedAt: number
  trace: string[]
  toolCount: number
  requests: number
}

export interface TurnResult {
  turn: number
  status: string
  durationMs: number
  model?: string
  trace: string[]
  toolCount: number
  requests: number
  response: string
  error?: string
  /** Returned inline by vibe_wait; its settlement notice collapses to a pointer. */
  acked: boolean
  /** Its settlement notice already entered the director conversation. */
  delivered: boolean
}

export interface WorkerRecord {
  id: string
  tier: Tier
  name: string
  state: WorkerState
  spawnedAt: number
  /** Turns started so far (activations). */
  turns: number
  /** Messages sent while a turn was in flight, not yet consumed by a new turn. */
  queued: number
  model?: string
  current?: TurnActivity
  results: TurnResult[]
  killRequested: boolean
  waiters: Set<() => void>
}

export function createWorker(id: string, tier: Tier, name: string, state: WorkerState): WorkerRecord {
  return { id, tier, name, state, spawnedAt: Date.now(), turns: 0, queued: 0, results: [], killRequested: false, waiters: new Set() }
}

export function notifyWaiters(worker: WorkerRecord): void {
  const waiters = [...worker.waiters]
  worker.waiters.clear()
  for (const wake of waiters) wake()
}

/** Normalize a model-supplied worker name to a short slug (omp caps at 48 chars). */
export function sanitizeName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const slug = raw.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  return slug === '' ? undefined : slug
}

/** Human status word for a subagent stop reason. */
export function statusFor(stopReason: string): string {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'error': return 'failed'
    case 'max-tokens': return 'max-tokens'
    case 'refusal': return 'refused'
    default: return stopReason
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** One-line summary of a tool call's arguments for the activity trace. */
export function summarizeCall(name: string, args: unknown): string {
  if (args === null || typeof args !== 'object') return name
  const record = args as Record<string, unknown>
  const preferred = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'description']
  const key = preferred.find(candidate => typeof record[candidate] === 'string')
    ?? Object.keys(record).find(candidate => typeof record[candidate] === 'string')
  if (key === undefined) return name
  const value = String(record[key]).replace(/\s+/g, ' ').trim()
  return `${name} ${value.length > 80 ? `${value.slice(0, 77)}...` : value}`
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

export interface RenderOptions {
  previewChars: number
  traceLimit: number
}

/** Render one settled worker turn as the `<vibe-turn>` block the director reads. */
export function renderTurn(worker: WorkerRecord, result: TurnResult, options: RenderOptions): string {
  const attrs = [
    `session="${escapeAttr(worker.id)}"`,
    `name="${escapeAttr(worker.name)}"`,
    `cli="${worker.tier}"`,
    `turn="${result.turn}"`,
    `status="${result.status}"`,
    `duration="${formatDuration(result.durationMs)}"`,
    ...result.model === undefined ? [] : [`model="${escapeAttr(result.model)}"`],
  ]
  const shown = result.trace.slice(-options.traceLimit)
  const overflow = result.trace.length - shown.length
  const lines = [`<vibe-turn ${attrs.join(' ')}>`]
  lines.push(`<activity tool-calls="${result.toolCount}" requests="${result.requests}">`)
  if (overflow > 0) lines.push(`- … ${overflow} earlier tool call(s) not shown`)
  for (const entry of shown) lines.push(`- ${entry}`)
  lines.push('</activity>')
  const truncated = result.response.length > options.previewChars
  const response = truncated ? `${result.response.slice(0, options.previewChars)}…` : result.response
  lines.push(truncated
    ? `<response truncated="true" full-output="child session ${escapeAttr(worker.id)}">`
    : '<response>')
  lines.push(response === '' ? '(no closing message)' : response)
  lines.push('</response>')
  if (result.error !== undefined) lines.push(`<error>${result.error}</error>`)
  if (worker.state === 'idle') {
    lines.push(`Session \`${worker.id}\` is idle and keeps this conversation — continue it with vibe_send.`)
  } else if (worker.state === 'killed') {
    lines.push(`Session \`${worker.id}\` was killed.`)
  }
  lines.push('</vibe-turn>')
  return lines.join('\n')
}

/** One roster line (plus recent activity) for vibe_list. */
export function renderRosterEntry(worker: WorkerRecord): string {
  const parts = [
    `- ${worker.id} "${worker.name}" [${worker.tier}] ${worker.state}`,
    `turns ${worker.turns}`,
    `queued ${worker.queued}`,
    `model ${worker.model ?? 'unresolved'}`,
  ]
  const lines = [parts.join(' · ')]
  if (worker.state === 'running' && worker.current !== undefined) {
    const elapsed = formatDuration(Date.now() - worker.current.startedAt)
    lines.push(`    turn ${worker.current.number} running for ${elapsed}, ${worker.current.toolCount} tool call(s)`)
    for (const entry of worker.current.trace.slice(-3)) lines.push(`    · ${entry}`)
  } else {
    const last = worker.results.at(-1)
    if (last !== undefined) {
      lines.push(`    last turn ${last.turn}: ${last.status} in ${formatDuration(last.durationMs)}, ${last.toolCount} tool call(s)`)
    }
  }
  return lines.join('\n')
}
