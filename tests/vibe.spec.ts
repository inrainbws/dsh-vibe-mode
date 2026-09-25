import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import * as vibePlugin from '../src/index.ts'
import { applyVibeEvent, initVibeState, type VibeUnitState } from '../src/projection.ts'

type Loose = (...args: unknown[]) => unknown
const emit = (ctx: Context, name: string, payload: unknown) => (ctx.emit as unknown as Loose).call(ctx, name, payload)
const append = (session: Session, type: string, data: unknown, options?: unknown) =>
  (session.append as unknown as Loose).call(session, type, data, ...options === undefined ? [] : [options])

type TestAgent = Agent & { session: Session; injected: UserMessage[]; steer: ReturnType<typeof vi.fn> }

/** Minimal stand-in for ctx.subagents that records calls and emits lifecycle events. */
class FakeSubagents {
  started: { provider: string; label: string; childId: string; request: Record<string, unknown> }[] = []
  sent: { id: string; text: string }[] = []
  interrupted: string[] = []
  drained: string[][] = []
  children: { kind: string; id: string }[] = []
  constructor(private readonly ctx: Context) {}

  startContinuable(spec: { provider: string; label: string; childId: string; request: { parent: Agent } & Record<string, unknown> }) {
    const id = String(spec.childId)
    this.started.push({ provider: spec.provider, label: spec.label, childId: id, request: spec.request })
    append(spec.request.parent.session, 'subagent/catalog', { version: 1, childId: id, childCreatedAt: 0, mode: 'continuable', label: spec.label })
    emit(this.ctx, 'subagent/start', { runId: `run-${id}`, provider: spec.provider, id, local: true })
    return Promise.resolve({ childId: spec.childId, messageId: `msg-${id}` })
  }

  sendMessage(_sender: Agent, id: string, content: { text: string }[]) {
    this.sent.push({ id: String(id), text: content.map(block => block.text).join('') })
    return Promise.resolve('msg-send')
  }

  interrupt(id: string) {
    this.interrupted.push(String(id))
  }

  drainContinuableChildren(_parent: Agent, ids: string[]) {
    this.drained.push(ids.map(String))
    return Promise.resolve()
  }

  listChildren() {
    return Promise.resolve(this.children)
  }

  begin(id: string) {
    emit(this.ctx, 'subagent/start', { runId: `run-${id}-n`, provider: 'spawn', id, local: true })
  }

  finish(id: string, text: string, stopReason = 'completed') {
    emit(this.ctx, 'subagent/end', {
      runId: `run-${id}`, provider: 'spawn', id, local: true, stopReason,
      lastAssistantMessage: [{ type: 'text', text }],
    })
  }
}

const ALL_TOOLS = ['read', 'read_image', 'todo_write', 'write', 'bash', 'send_message']

function registerNamedTools(ctx: Context, names: string[]): void {
  for (const name of names) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
}

async function setup(options: { tools?: string[]; config?: Record<string, unknown>; plan?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  if (options.plan === true) {
    ctx.sessionProjections.register({
      key: 'plan' as never,
      stateVersion: 1,
      stateSchema: { parse: (value: unknown) => value } as never,
      init: () => ({ active: true, wanted: null }) as never,
      apply: (state: never) => state,
    } as never)
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  const subagents = new FakeSubagents(ctx)
  ctx.provide('subagents', subagents)
  registerNamedTools(ctx, options.tools ?? ALL_TOOLS)
  await ctx.plugin(vibePlugin, (options.config ?? {}) as never)
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, subagents }
}

async function makeAgent(ctx: Context, id: string, seed?: (session: Session) => void): Promise<TestAgent> {
  const session = Session.create(SessionId(id))
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    injected: [] as UserMessage[],
    steer: vi.fn(),
    inject(this: { injected: UserMessage[] }, message: UserMessage) { this.injected.push(message) },
  } as unknown as TestAgent
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, { inject: ['tools'] }))
  ;(agent as { ctx?: Context }).ctx = scoped
  seed?.(session)
  await (ctx.serial as unknown as (...args: unknown[]) => Promise<unknown>).call(ctx, 'agent/created', { agent, source: 'startup' })
  return agent
}

const signal = new AbortController().signal
let calls = 0

async function tool(ctx: Context, agent: Agent, name: string, args: Record<string, unknown> = {}) {
  const result = await ctx.tools.execute({ callId: ToolCallId(`call-${++calls}`), name, arguments: args, signal, agent })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return String(result.value)
}

function toolNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

async function command(ctx: Context, agent: Agent, line: string) {
  return (await ctx.commands.execute(agent, line, [], signal))?.result
}

function settledNotice(id: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `Background subagent ${id} finished.` }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: id } as never,
  }) as UserMessage
}

async function preStep(ctx: Context, agent: Agent, messages: UserMessage[], step = 1) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

function textOf(message: UserMessage): string {
  return message.content.map(block => (block as { text?: string }).text ?? '').join('')
}

function vibeState(ctx: Context, agent: TestAgent): VibeUnitState {
  return ctx.sessionProjections.stateOf(agent.session, 'vibe')!
}

describe('vibe projection', () => {
  const run = (commandId: string, args: string) => ({ type: 'command/run', data: { commandId, name: 'vibe', args } })
  const done = (commandId: string, kind = 'success') => ({ type: 'command/done', data: { commandId, kind } })
  const fold = (events: { type: string; data: unknown }[]) =>
    events.reduce((state, event) => applyVibeEvent(state, event as never), initVibeState())

  it('toggles on bare /vibe, honors off, and ignores failed invocations', () => {
    expect(fold([run('1', ''), done('1')]).active).toBe(true)
    expect(fold([run('1', ''), done('1'), run('2', ''), done('2')]).active).toBe(false)
    expect(fold([run('1', ' fix the tests '), done('1'), run('2', 'fix more'), done('2')]).active).toBe(true)
    expect(fold([run('1', ''), done('1', 'error')]).active).toBe(false)
    expect(fold([run('1', 'off'), done('1')]).active).toBe(false)
  })

  it('records vibe workers from the catalog, marks kills, and clears the roster on exit', () => {
    const catalog = (childId: string, label: string) => ({ type: 'subagent/catalog', data: { childId, mode: 'continuable', label } })
    const state = fold([
      catalog('before', 'fast:ignored'),
      run('1', ''), done('1'),
      catalog('w1', 'fast:rename'),
      catalog('w2', 'good:design'),
      catalog('other', 'unrelated label'),
      { type: 'tool/call', data: { callId: 'k1', name: 'vibe_kill', arguments: JSON.stringify({ session: 'w1' }) } },
      { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'k1', content: [] }] } } },
    ])
    expect(state.workers).toEqual([
      { id: 'w1', tier: 'fast', name: 'rename', killed: true },
      { id: 'w2', tier: 'good', name: 'design', killed: false },
    ])
    expect(fold([run('1', ''), done('1'), catalog('w1', 'fast:x'), run('2', 'off'), done('2')]).workers).toEqual([])
  })
})

describe('/vibe', () => {
  it('reduces the director toolset, injects the policy, and restores everything on exit', async () => {
    const { ctx } = await setup()
    const agent = await makeAgent(ctx, 'director-1')
    expect(toolNames(ctx, agent)).toEqual([...ALL_TOOLS].sort())

    expect(await command(ctx, agent, '/vibe')).toMatchObject({ kind: 'success' })
    expect(vibeState(ctx, agent).active).toBe(true)
    expect(toolNames(ctx, agent)).toEqual(['read', 'read_image', 'todo_write', 'vibe_kill', 'vibe_list', 'vibe_send', 'vibe_spawn', 'vibe_wait'])
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const policy = assembly.sections.find(section => section.name === 'vibe:policy')?.text ?? ''
    expect(policy).toContain('You are the DIRECTOR')
    expect(policy).toContain('`todo_write`')
    expect(agent.injected.at(-1) && textOf(agent.injected.at(-1)!)).toContain('switched this session to vibe mode')

    expect(await command(ctx, agent, '/vibe')).toEqual({ kind: 'success', text: 'Vibe mode off.' })
    expect(vibeState(ctx, agent).active).toBe(false)
    expect(toolNames(ctx, agent)).toEqual([...ALL_TOOLS].sort())
    const after = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(after.sections.find(section => section.name === 'vibe:policy')?.text ?? '').toBe('')
    expect(await command(ctx, agent, '/vibe off')).toEqual({ kind: 'success', text: 'Vibe mode is already off.' })
  })

  it('submits an inline directive to the director', async () => {
    const { ctx } = await setup()
    const agent = await makeAgent(ctx, 'director-2')
    await command(ctx, agent, '/vibe   split the migration  ')
    expect(agent.steer).toHaveBeenCalledOnce()
    expect(agent.steer.mock.calls[0][0]).toMatchObject({ content: [{ type: 'text', text: 'split the migration' }], source: { kind: 'user' } })
    expect(await command(ctx, agent, '/vibe and review it')).toMatchObject({ text: expect.stringContaining('already on') })
    expect(vibeState(ctx, agent).active).toBe(true)
  })

  it('keeps only the read tools a preset actually has, and refuses without `read`', async () => {
    const minimal = await setup({ tools: ['read', 'bash'] })
    const agent = await makeAgent(minimal.ctx, 'minimal')
    await command(minimal.ctx, agent, '/vibe')
    expect(toolNames(minimal.ctx, agent)).toEqual(['read', 'vibe_kill', 'vibe_list', 'vibe_send', 'vibe_spawn', 'vibe_wait'])

    const bare = await setup({ tools: ['bash'] })
    const other = await makeAgent(bare.ctx, 'no-read')
    expect(await command(bare.ctx, other, '/vibe')).toMatchObject({ kind: 'error' })
    expect(vibeState(bare.ctx, other).active).toBe(false)
    expect(toolNames(bare.ctx, other)).toEqual(['bash'])
  })

  it('is refused while plan mode is on', async () => {
    const { ctx } = await setup({ plan: true })
    const agent = await makeAgent(ctx, 'planning')
    expect(await command(ctx, agent, '/vibe')).toEqual({ kind: 'error', text: expect.stringContaining('plan mode') })
    expect(vibeState(ctx, agent).active).toBe(false)
  })
})

describe('worker tools', () => {
  async function director(config?: Record<string, unknown>) {
    const env = await setup({ config })
    const agent = await makeAgent(env.ctx, 'director')
    await command(env.ctx, agent, '/vibe')
    return { ...env, agent }
  }

  it('spawns a tiered worker with a persisted label, worker tool filter, and route override', async () => {
    const { ctx, agent, subagents } = await director({ fastAgentOptions: { model: 'small-model' } })
    const text = await tool(ctx, agent, 'vibe_spawn', { cli: 'fast', prompt: 'Rename foo to bar in src/', name: 'Rename Foo!' })
    expect(text).toContain('Spawned fast worker "rename-foo"')
    const [started] = subagents.started
    expect(started.label).toBe('fast:rename-foo')
    expect(started.request.toolFilter).toEqual({ deny: ['send_message'] })
    expect(started.request.agentOptions).toEqual({ model: 'small-model' })
    expect(vibeState(ctx, agent).workers).toEqual([{ id: started.childId, tier: 'fast', name: 'rename-foo', killed: false }])

    await tool(ctx, agent, 'vibe_spawn', { cli: 'good', prompt: 'Design it' })
    expect(subagents.started[1].label).toBe('good:good-2')
    expect(subagents.started[1].request.agentOptions).toBeUndefined()
    const roster = await tool(ctx, agent, 'vibe_list')
    expect(roster).toContain('"rename-foo" [fast] running')
    expect(roster).toContain('"good-2" [good] running')
  })

  it('delivers a settled turn as a <vibe-turn> block with its activity trace', async () => {
    const { ctx, agent, subagents } = await director()
    await tool(ctx, agent, 'vibe_spawn', { cli: 'good', prompt: 'Fix the race', name: 'race' })
    const id = subagents.started[0].childId
    const worker = { id: SessionId(id), session: agent.session } as unknown as Agent
    await tool(ctx, worker, 'bash', { command: 'pnpm test' })
    subagents.finish(id, 'Fixed the race in src/queue.ts; tests pass.')

    const decision = await preStep(ctx, agent, [settledNotice(id)])
    expect(decision.kind).toBe('enter')
    const text = textOf((decision as { messages: UserMessage[] }).messages[0])
    expect(text).toContain(`<vibe-turn session="${id}" name="race" cli="good" turn="1" status="completed"`)
    expect(text).toContain('<activity tool-calls="1" requests="0">')
    expect(text).toContain('- bash')
    expect(text).toContain('Fixed the race in src/queue.ts; tests pass.')
    expect(text).toContain('is idle and keeps this conversation')
    expect(await tool(ctx, agent, 'vibe_list')).toContain('[good] idle · turns 1')
  })

  it('vibe_wait returns the first settled result once and collapses its later notice', async () => {
    const { ctx, agent, subagents } = await director()
    await tool(ctx, agent, 'vibe_spawn', { cli: 'fast', prompt: 'Do it', name: 'w' })
    const id = subagents.started[0].childId
    const waiting = tool(ctx, agent, 'vibe_wait', { timeout: 5 })
    await new Promise(resolve => setImmediate(resolve))
    subagents.finish(id, 'done!')
    const result = await waiting
    expect(result).toContain('status="completed"')
    expect(result).toContain('done!')

    // The same result is not returned twice, and its notice alone does not wake the model.
    expect(await tool(ctx, agent, 'vibe_wait', { timeout: 1 })).toContain('No watched worker is running')
    expect(await preStep(ctx, agent, [settledNotice(id)])).toEqual({ kind: 'reject' })
  })

  it('vibe_wait times out while workers keep running', async () => {
    const { ctx, agent } = await director({ waitTimeoutSeconds: 1 })
    await tool(ctx, agent, 'vibe_spawn', { cli: 'fast', prompt: 'Slow task', name: 'slow' })
    expect(await tool(ctx, agent, 'vibe_wait')).toContain('Timed out after 1s; still running: "slow"')
  })

  it('steers a running worker, restarts an idle one, and stops killed workers for good', async () => {
    const { ctx, agent, subagents } = await director()
    await tool(ctx, agent, 'vibe_spawn', { cli: 'fast', prompt: 'Task', name: 'w' })
    const id = subagents.started[0].childId
    expect(await tool(ctx, agent, 'vibe_send', { session: id, message: 'keep the error code' })).toContain('Steering "w"')
    subagents.finish(id, 'ok')
    expect(await tool(ctx, agent, 'vibe_send', { session: 'w', message: 'next step' })).toContain('Started turn 2 of "w"')
    expect(subagents.sent.map(entry => entry.text)).toEqual(['keep the error code', 'next step'])

    expect(await tool(ctx, agent, 'vibe_kill', { session: 'w' })).toContain('Stopped vibe worker "w" (its in-flight turn was cancelled)')
    expect(subagents.interrupted).toEqual([id])
    expect(subagents.drained).toEqual([[id]])
    await expect(tool(ctx, agent, 'vibe_send', { session: id, message: 'hi' })).rejects.toThrow('is killed')
    expect(await tool(ctx, agent, 'vibe_list')).toContain('[fast] killed')
    await expect(tool(ctx, agent, 'vibe_send', { session: 'nobody', message: 'x' })).rejects.toThrow('unknown vibe worker')
  })

  it('stops every worker when the mode exits and swallows their final notices', async () => {
    const { ctx, agent, subagents } = await director()
    await tool(ctx, agent, 'vibe_spawn', { cli: 'fast', prompt: 'A', name: 'a' })
    await tool(ctx, agent, 'vibe_spawn', { cli: 'good', prompt: 'B', name: 'b' })
    const ids = subagents.started.map(entry => entry.childId)
    expect(await command(ctx, agent, '/vibe off')).toEqual({ kind: 'success', text: 'Vibe mode off. Stopped 2 worker(s).' })
    expect(subagents.drained).toEqual([ids])
    expect(vibeState(ctx, agent).workers).toEqual([])
    expect(await preStep(ctx, agent, ids.map(settledNotice))).toEqual({ kind: 'reject' })
    await expect(tool(ctx, agent, 'vibe_list')).rejects.toThrow()
  })
})

describe('resume', () => {
  it('rehydrates the director role and roster from the logged session', async () => {
    const { ctx } = await setup()
    const agent = await makeAgent(ctx, 'resumed', (session) => {
      append(session, 'command/run', { commandId: 'c1', name: 'vibe', args: '' })
      append(session, 'command/done', { commandId: 'c1', kind: 'success' })
      append(session, 'subagent/catalog', { version: 1, childId: 'w1', childCreatedAt: 0, mode: 'continuable', label: 'fast:parser' })
      append(session, 'subagent/catalog', { version: 1, childId: 'w2', childCreatedAt: 0, mode: 'continuable', label: 'good:review' })
      append(session, 'tool/call', { turn: 1, step: 1, callId: 'k', name: 'vibe_kill', arguments: '{"session":"w2"}' })
      append(session, 'tool/result', {
        turn: 1, step: 1,
        message: createUserMessage({ content: [{ type: 'tool-result', toolCallId: 'k', content: [] }], source: { kind: 'tool' } } as never),
      }, { surfaceOp: 'append' })
    })
    expect(toolNames(ctx, agent)).toContain('vibe_spawn')
    const roster = await tool(ctx, agent, 'vibe_list')
    expect(roster).toContain('w1 "parser" [fast] idle')
    expect(roster).toContain('w2 "review" [good] killed')
  })
})
