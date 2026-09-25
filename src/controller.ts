/**
 * The vibe-mode controller: logged mode state, per-director effects (reduced
 * toolset plus scoped worker tools), worker lifecycle tracking, and
 * `<vibe-turn>` result delivery into the director conversation.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { Tier, VibeModeConfig, WorkerAgentOptions } from './config.ts'
import { DIRECTOR_SECTION, renderDirectorSection } from './prompts.ts'
import { initVibeState, VIBE_COMMAND, vibeProjectionDefinition, wantedFor, workerLabel, type VibeUnitState } from './projection.ts'
import { createWorkerTools, type WorkerControl } from './tools.ts'
import {
  createWorker, notifyWaiters, renderRosterEntry, renderTurn, sanitizeName, statusFor, summarizeCall,
  type TurnResult, type WorkerRecord,
} from './workers.ts'

const READ_TOOL = 'read'
const READ_IMAGE_TOOL = 'read_image'
const TODO_TOOL = 'todo_write'
const PLUGIN = 'vibe-mode'

/** One session driven as a director. */
interface Director {
  agent: Agent
  applied: boolean
  effects: (() => void)[]
  tools: { readImage: boolean; todo: boolean }
  /** Tools denied to workers, captured from the director's view before restriction. */
  workerDeny: string[]
  workers: Map<string, WorkerRecord>
  /** Workers stopped by vibe_kill or mode exit whose settlement notices are swallowed. */
  retired: Set<string>
}

function textOf(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .map(block => (block as { type: string; text?: string }).type === 'text' ? (block as { text: string }).text : '')
    .filter(text => text !== '')
    .join('\n')
    .trim()
}

function notice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: text },
  } as Parameters<typeof createUserMessage>[0]) as UserMessage
}

export class VibeController implements WorkerControl {
  private readonly directors = new Map<string, Director>()
  /** Worker session id → owning director session id. */
  private readonly owners = new Map<string, string>()

  constructor(private readonly ctx: Context, private readonly config: VibeModeConfig) {
    ctx.sessionProjections.register(vibeProjectionDefinition)

    ctx.systemPrompt.section({
      name: 'vibe:policy',
      order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 20,
      text: (context) => {
        const agent = context.agent as Agent | undefined
        const director = agent === undefined ? undefined : this.directors.get(String(agent.session.id))
        if (director === undefined || !director.applied) return ''
        return renderDirectorSection(config.section ?? DIRECTOR_SECTION, director.tools)
      },
    })

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: VIBE_COMMAND,
        description: 'Enter or leave vibe mode (director + fast/good background workers)',
        input: { hint: '[off|<directive>]' },
        handler: ({ agent, rawInput }) => this.runCommand(agent, rawInput),
      })
    })

    // Rehydrate the director role when a vibe session's agent is published (resume).
    ctx.on('agent/created', ({ agent }) => {
      try {
        this.rehydrate(agent)
      } catch (error) {
        ctx.logger.warn('vibe-mode: failed to rehydrate director %s: %o', String(agent.id), error)
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const director = this.directors.get(String(agent.session.id))
      if (director?.agent === agent) {
        this.uninstall(director)
        director.applied = false
      }
    })

    // Worker lifecycle: one activation per worker turn.
    ctx.on('subagent/start', (info) => {
      const worker = this.workerById(String(info.id))
      if (worker === undefined || worker.state === 'killed') return
      worker.state = 'running'
      worker.turns += 1
      worker.queued = 0
      worker.current = { number: worker.turns, startedAt: Date.now(), trace: [], toolCount: 0, requests: 0 }
    })
    ctx.on('subagent/end', (info) => {
      const worker = this.workerById(String(info.id))
      if (worker === undefined) return
      this.settle(worker, String(info.stopReason), info.lastAssistantMessage)
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      const worker = exec.agent === undefined ? undefined : this.workerById(String(exec.agent.id))
      if (worker?.current !== undefined) {
        worker.current.toolCount += 1
        worker.current.trace.push(summarizeCall(exec.name, exec.arguments))
      }
      return decision
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      const worker = this.workerById(String(agent.id))
      if (worker !== undefined) {
        worker.model = `${config.provider}/${config.model}`
        if (worker.current !== undefined) worker.current.requests += 1
      }
      return config
    })

    // Deliver worker results as <vibe-turn> blocks in place of the runtime's generic notice.
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      const decision = await next()
      const director = this.directors.get(String(agent.session.id))
      if (decision.kind !== 'enter' || director === undefined || director.agent !== agent) return decision
      let collapsed = 0
      let rewritten = false
      const messages = decision.messages.map((message) => {
        const replacement = this.rewriteSettlement(director, message)
        if (replacement === undefined) return message
        rewritten = true
        if (replacement.collapse) collapsed += 1
        return { ...message, content: [{ type: 'text' as const, text: replacement.text }] } as UserMessage
      })
      if (!rewritten) return decision
      // A turn woken only by already-handled notices has nothing new for the model.
      if (step === 1 && collapsed === messages.length) return { kind: 'reject' }
      return { ...decision, messages }
    })
  }

  // ── mode ──────────────────────────────────────────────────────────────

  private vibeState(session: Session): VibeUnitState {
    return this.ctx.sessionProjections.stateOf(session, 'vibe') ?? initVibeState()
  }

  /** Whether the director role is applied to this agent right now. */
  isDirector(agent: Agent): boolean {
    return this.directors.get(String(agent.session.id))?.applied === true
  }

  private director(agent: Agent): Director {
    const key = String(agent.session.id)
    let director = this.directors.get(key)
    if (director === undefined) {
      director = { agent, applied: false, effects: [], tools: { readImage: false, todo: false }, workerDeny: [], workers: new Map(), retired: new Set() }
      this.directors.set(key, director)
    } else if (director.agent !== agent) {
      // A resumed session gets a fresh agent; effects on the old one are gone with its scope.
      director.effects = []
      director.applied = false
      director.agent = agent
    }
    return director
  }

  private requireDirector(agent: Agent): Director {
    const director = this.directors.get(String(agent.session.id))
    if (director === undefined || !director.applied || director.agent !== agent) {
      throw new Error('vibe mode is not active for this session; run /vibe first')
    }
    return director
  }

  /** Reduce the director's toolset and add its scoped worker tools. */
  private install(director: Director): void {
    const { agent } = director
    const tools = agent.ctx.tools
    const visible = (name: string) => tools.get(name, agent) !== undefined
    if (!visible(READ_TOOL)) {
      throw new Error('vibe mode needs the `read` tool, which this session does not have')
    }
    director.tools = { readImage: visible(READ_IMAGE_TOOL), todo: this.config.includeTodo && visible(TODO_TOOL) }
    director.workerDeny = this.config.workerToolDeny.filter(visible)
    const allow = [READ_TOOL, ...director.tools.readImage ? [READ_IMAGE_TOOL] : [], ...director.tools.todo ? [TODO_TOOL] : []]
    const effects: (() => void)[] = []
    try {
      effects.push(tools.restrict({ allow }))
      for (const definition of createWorkerTools(this)) effects.push(tools.register(definition))
    } catch (error) {
      for (const dispose of effects.reverse()) dispose()
      throw error
    }
    director.effects = effects
  }

  private uninstall(director: Director): void {
    const effects = director.effects.reverse()
    director.effects = []
    for (const dispose of effects) {
      try {
        dispose()
      } catch (error) {
        this.ctx.logger.warn('vibe-mode: failed to dispose a director effect: %o', error)
      }
    }
  }

  /** Enter or leave the director role; leaving stops every worker. Returns the number stopped. */
  async setMode(agent: Agent, active: boolean): Promise<number> {
    const director = this.director(agent)
    if (director.applied === active) return 0
    if (active) {
      this.install(director)
      director.applied = true
      agent.inject(notice('The user switched this session to vibe mode: you are now the director of background workers.'))
      return 0
    }
    this.uninstall(director)
    director.applied = false
    const stopped = await this.killAll(director)
    agent.inject(notice('The user left vibe mode: your normal tools are restored and all vibe workers were stopped.'))
    return stopped
  }

  private refusal(session: Session): string | undefined {
    const plan = this.ctx.sessionProjections.stateOf(session, 'plan' as never) as { active?: boolean; wanted?: boolean | null } | undefined
    if (plan?.active === true || plan?.wanted === true) {
      return 'Vibe mode cannot start while plan mode is on. Leave plan mode first (/plan off).'
    }
    const goal = this.ctx.sessionProjections.stateOf(session, 'goal' as never) as { current?: { goal?: { phase?: string } } | null } | undefined
    const phase = goal?.current?.goal?.phase
    if (phase !== undefined && phase !== 'complete') {
      return `Vibe mode cannot start while a goal is ${phase}. Finish or clear the goal first.`
    }
    return undefined
  }

  private async runCommand(agent: Agent, rawInput: string) {
    const state = this.vibeState(agent.session)
    // `command/run` is already logged, so the projection holds this invocation's intent.
    const wanted = state.running?.wanted ?? wantedFor(rawInput, state.active)
    const directive = rawInput.trim()
    if (!wanted) {
      if (!this.isDirector(agent)) return { kind: 'success' as const, text: 'Vibe mode is already off.' }
      const stopped = await this.setMode(agent, false)
      return { kind: 'success' as const, text: stopped > 0 ? `Vibe mode off. Stopped ${stopped} worker(s).` : 'Vibe mode off.' }
    }
    const entering = !this.isDirector(agent)
    if (entering) {
      const refusal = this.refusal(agent.session)
      if (refusal !== undefined) return { kind: 'error' as const, text: refusal }
      try {
        await this.setMode(agent, true)
      } catch (error) {
        return { kind: 'error' as const, text: `Could not enter vibe mode: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (directive !== '') {
      agent.steer(createUserMessage({ content: [{ type: 'text', text: directive }], source: { kind: 'user' } }) as UserMessage)
    }
    return {
      kind: 'success' as const,
      text: entering
        ? 'Vibe mode on: this session now directs fast/good workers. Run /vibe again to leave.'
        : 'Vibe mode is already on; directive sent to the director.',
    }
  }

  /** Restore the director role and roster for a resumed vibe session. */
  private rehydrate(agent: Agent): void {
    const state = this.vibeState(agent.session)
    if (!state.active) return
    const director = this.director(agent)
    for (const entry of state.workers) {
      if (director.workers.has(entry.id)) continue
      const worker = createWorker(entry.id, entry.tier, entry.name, entry.killed ? 'killed' : 'idle')
      director.workers.set(entry.id, worker)
      if (entry.killed) director.retired.add(entry.id)
      else this.owners.set(entry.id, String(agent.session.id))
    }
    if (!director.applied) {
      this.install(director)
      director.applied = true
    }
    void this.markUnresolvable(director)
  }

  /** Mark workers whose child sessions the catalog can no longer resolve as dead. */
  private async markUnresolvable(director: Director): Promise<void> {
    try {
      const entries = await this.ctx.subagents.listChildren(director.agent.session.id)
      for (const entry of entries) {
        const worker = director.workers.get(String(entry.id))
        if (worker !== undefined && entry.kind === 'diagnostic' && worker.state !== 'killed') worker.state = 'dead'
      }
    } catch (error) {
      this.ctx.logger.warn('vibe-mode: could not list workers for %s: %o', String(director.agent.session.id), error)
    }
  }

  // ── workers ───────────────────────────────────────────────────────────

  private workerById(id: string): WorkerRecord | undefined {
    const owner = this.owners.get(id)
    return owner === undefined ? undefined : this.directors.get(owner)?.workers.get(id)
  }

  private resolveWorker(director: Director, session: string): WorkerRecord {
    const key = session.trim()
    const worker = director.workers.get(key)
      ?? [...director.workers.values()].find(candidate => candidate.name === sanitizeName(key))
    if (worker === undefined) throw new Error(`unknown vibe worker "${session}"; call vibe_list for your roster`)
    return worker
  }

  private settle(worker: WorkerRecord, stopReason: string, output: readonly ContentBlock[] | undefined): void {
    const turn = worker.current ?? { number: Math.max(worker.turns, 1), startedAt: Date.now(), trace: [], toolCount: 0, requests: 0 }
    worker.current = undefined
    if (worker.state !== 'killed' && worker.state !== 'dead') worker.state = 'idle'
    const status = worker.killRequested ? 'killed' : statusFor(stopReason)
    const result: TurnResult = {
      turn: turn.number,
      status,
      durationMs: Date.now() - turn.startedAt,
      model: worker.model,
      trace: turn.trace,
      toolCount: turn.toolCount,
      requests: turn.requests,
      response: textOf(output),
      error: stopReason === 'error' ? 'The worker failed before finishing; it is idle and can be sent a retry.' : undefined,
      acked: false,
      delivered: false,
    }
    worker.results.push(result)
    notifyWaiters(worker)
  }

  /** Replacement text for a settlement notice from one of this director's workers. */
  private rewriteSettlement(director: Director, message: UserMessage): { text: string; collapse: boolean } | undefined {
    const source = message.source as { kind: string; senderSessionId?: string }
    if (source.kind !== 'subagent-settled' || source.senderSessionId === undefined) return undefined
    const id = String(source.senderSessionId)
    if (director.retired.has(id)) {
      return { text: `(vibe worker ${id} was stopped; its final notice is suppressed)`, collapse: true }
    }
    const worker = director.workers.get(id)
    const result = worker?.results.find(candidate => !candidate.delivered)
    if (worker === undefined || result === undefined) return undefined
    result.delivered = true
    if (result.acked) {
      return { text: `(vibe worker ${worker.name} turn ${result.turn} result was already returned by vibe_wait)`, collapse: true }
    }
    return { text: renderTurn(worker, result, this.renderOptions()), collapse: false }
  }

  private renderOptions() {
    return { previewChars: this.config.resultPreviewChars, traceLimit: this.config.traceLimit }
  }

  private tierOptions(tier: Tier): { provider: string; agentOptions?: WorkerAgentOptions; persona?: string } {
    const raw = tier === 'fast' ? this.config.fastAgentOptions : this.config.goodAgentOptions
    // Keep only the fields actually set, so unset ones inherit the director route.
    const entries = Object.entries(raw ?? {}).filter(([, value]) => value !== undefined && value !== '')
    const persona = tier === 'fast' ? this.config.fastPersona : this.config.goodPersona
    return {
      provider: tier === 'fast' ? this.config.fastProvider : this.config.goodProvider,
      agentOptions: entries.length === 0 ? undefined : Object.fromEntries(entries) as WorkerAgentOptions,
      persona: persona === undefined || persona.trim() === '' ? undefined : persona,
    }
  }

  private async killAll(director: Director): Promise<number> {
    const targets = [...director.workers.values()].filter(worker => worker.state !== 'killed' && worker.state !== 'dead')
    await this.stop(director, targets)
    for (const worker of director.workers.values()) this.owners.delete(worker.id)
    director.workers.clear()
    return targets.length
  }

  private async stop(director: Director, workers: WorkerRecord[]): Promise<void> {
    if (workers.length === 0) return
    for (const worker of workers) {
      worker.killRequested = true
      director.retired.add(worker.id)
      if (worker.state === 'running') {
        try {
          this.ctx.subagents.interrupt(SessionId(worker.id), { kind: 'ancestor', agent: director.agent })
        } catch (error) {
          this.ctx.logger.warn('vibe-mode: failed to interrupt worker %s: %o', worker.id, error)
        }
      }
    }
    try {
      await this.ctx.subagents.drainContinuableChildren(director.agent, workers.map(worker => SessionId(worker.id)))
    } catch (error) {
      this.ctx.logger.warn('vibe-mode: failed to release workers: %o', error)
    }
    for (const worker of workers) {
      worker.state = 'killed'
      worker.queued = 0
      notifyWaiters(worker)
    }
  }

  // ── WorkerControl (the vibe_* tools) ──────────────────────────────────

  async spawn(agent: Agent, tier: Tier, prompt: string, rawName: string | undefined, signal: AbortSignal): Promise<string> {
    const director = this.requireDirector(agent)
    if (prompt.trim() === '') throw new Error('vibe_spawn needs a non-empty brief')
    const taken = new Set([...director.workers.values()].map(worker => worker.name))
    const base = sanitizeName(rawName) ?? `${tier}-${director.workers.size + 1}`
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 44)}-${n}`
    const id = randomUUID()
    const worker = createWorker(id, tier, name, 'running')
    // Register before starting so the child's first lifecycle events find the record.
    director.workers.set(id, worker)
    this.owners.set(id, String(agent.session.id))
    const options = this.tierOptions(tier)
    try {
      await this.ctx.subagents.startContinuable({
        provider: options.provider,
        label: workerLabel(tier, name),
        childId: SessionId(id),
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions as never },
          ...options.persona === undefined ? {} : { persona: options.persona },
          ...director.workerDeny.length === 0 ? {} : { toolFilter: { deny: director.workerDeny } },
        },
        signal,
      })
    } catch (error) {
      director.workers.delete(id)
      this.owners.delete(id)
      throw error
    }
    return `Spawned ${tier} worker "${name}" (session ${id}). It is working now; its result arrives as a <vibe-turn> message when the turn ends.`
  }

  async send(agent: Agent, session: string, message: string, signal: AbortSignal): Promise<string> {
    const director = this.requireDirector(agent)
    const worker = this.resolveWorker(director, session)
    if (worker.state === 'killed' || worker.state === 'dead') {
      throw new Error(`vibe worker "${worker.name}" is ${worker.state}; spawn a new worker instead`)
    }
    const wasRunning = worker.state === 'running'
    await this.ctx.subagents.sendMessage(agent, SessionId(worker.id), [{ type: 'text', text: message }], { signal })
    if (wasRunning) {
      worker.queued += 1
      return `Steering "${worker.name}": the message reaches it at its next step (${worker.queued} queued).`
    }
    worker.state = 'running'
    return `Started turn ${worker.turns + 1} of "${worker.name}"; its result arrives as a <vibe-turn> message.`
  }

  async wait(agent: Agent, sessions: string[] | undefined, timeoutSeconds: number | undefined, signal: AbortSignal): Promise<string> {
    const director = this.requireDirector(agent)
    const watched = sessions === undefined || sessions.length === 0
      ? [...director.workers.values()]
      : sessions.map(session => this.resolveWorker(director, session))
    const collect = () => {
      const blocks: string[] = []
      for (const worker of watched) {
        for (const result of worker.results) {
          if (result.acked || result.delivered) continue
          result.acked = true
          blocks.push(renderTurn(worker, result, this.renderOptions()))
        }
      }
      return blocks
    }
    const ready = collect()
    if (ready.length > 0) return ready.join('\n\n')
    const running = watched.filter(worker => worker.state === 'running')
    if (running.length === 0) return 'No watched worker is running and no undelivered result is pending.'
    const seconds = Math.min(Math.max(timeoutSeconds ?? this.config.waitTimeoutSeconds, 1), 600)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const wakes: (() => void)[] = []
    const outcome = await new Promise<'settled' | 'timeout' | 'aborted'>((resolve) => {
      for (const worker of running) {
        const wake = () => resolve('settled')
        wakes.push(wake)
        worker.waiters.add(wake)
      }
      timer = setTimeout(() => resolve('timeout'), seconds * 1000)
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    for (const worker of running) for (const wake of wakes) worker.waiters.delete(wake)
    if (outcome === 'aborted') throw new Error('vibe_wait was cancelled')
    const settled = collect()
    if (settled.length > 0) return settled.join('\n\n')
    const still = watched.filter(worker => worker.state === 'running').map(worker => `"${worker.name}"`)
    return outcome === 'timeout'
      ? `Timed out after ${seconds}s; still running: ${still.join(', ') || 'none'}. Keep directing other work or wait again.`
      : `The watched worker stopped without a new result; still running: ${still.join(', ') || 'none'}.`
  }

  async kill(agent: Agent, session: string): Promise<string> {
    const director = this.requireDirector(agent)
    const worker = this.resolveWorker(director, session)
    if (worker.state === 'killed') return `Vibe worker "${worker.name}" is already stopped.`
    const wasRunning = worker.state === 'running'
    await this.stop(director, [worker])
    this.owners.delete(worker.id)
    return `Stopped vibe worker "${worker.name}"${wasRunning ? ' (its in-flight turn was cancelled)' : ''}. Its transcript stays in child session ${worker.id}.`
  }

  list(agent: Agent): string {
    const director = this.requireDirector(agent)
    if (director.workers.size === 0) return 'No vibe workers yet. Start one with vibe_spawn.'
    return [...director.workers.values()].map(renderRosterEntry).join('\n')
  }
}
