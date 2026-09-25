/**
 * The five director-scoped worker-control tools. They are registered into one
 * director agent's scope while vibe mode is applied, so they survive the
 * director's `restrict({ allow })` and never reach workers.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { KILL_DESCRIPTION, LIST_DESCRIPTION, SEND_DESCRIPTION, SPAWN_DESCRIPTION, WAIT_DESCRIPTION } from './prompts.ts'
import type { Tier } from './config.ts'

/** What the tools need from the controller, keyed by the calling director agent. */
export interface WorkerControl {
  spawn(director: Agent, tier: Tier, prompt: string, name: string | undefined, signal: AbortSignal): Promise<string>
  send(director: Agent, session: string, message: string, signal: AbortSignal): Promise<string>
  wait(director: Agent, sessions: string[] | undefined, timeoutSeconds: number | undefined, signal: AbortSignal): Promise<string>
  kill(director: Agent, session: string): Promise<string>
  list(director: Agent): string
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
} as const

function caller(exec: { agent?: Agent }, tool: string): Agent {
  if (exec.agent === undefined) throw new Error(`${tool} requires a calling agent`)
  return exec.agent
}

export function createWorkerTools(control: WorkerControl): ToolDefinition[] {
  return [
    defineTool({
      name: 'vibe_spawn',
      description: SPAWN_DESCRIPTION,
      parameters: {
        cli: { type: 'string', required: true, enum: ['fast', 'good'], description: 'Worker tier: `fast` (mechanical) or `good` (judgment).' },
        prompt: { type: 'string', required: true, description: 'Complete self-contained first brief: files, constraints, acceptance criteria, non-goals.' },
        name: { type: 'string', description: 'Optional short name for the workstream (sanitized, max 48 characters).' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => control.spawn(caller(exec, 'vibe_spawn'), args.cli as Tier, args.prompt, args.name, exec.signal),
    }),
    defineTool({
      name: 'vibe_send',
      description: SEND_DESCRIPTION,
      parameters: {
        session: { type: 'string', required: true, description: 'Worker session id (or its name) from vibe_spawn / vibe_list.' },
        message: { type: 'string', required: true, description: 'Correction, next step, or review request.' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => control.send(caller(exec, 'vibe_send'), args.session, args.message, exec.signal),
    }),
    defineTool({
      name: 'vibe_wait',
      description: WAIT_DESCRIPTION,
      parameters: {
        sessions: { type: 'array', items: { type: 'string' }, description: 'Worker session ids (or names) to watch; omit for all running workers.' },
        timeout: { type: 'integer', description: 'Seconds to wait before giving up (default 30).' },
      },
      output: textOutput,
      execute: (args, exec) => control.wait(caller(exec, 'vibe_wait'), args.sessions, args.timeout, exec.signal),
    }),
    defineTool({
      name: 'vibe_kill',
      description: KILL_DESCRIPTION,
      parameters: {
        session: { type: 'string', required: true, description: 'Worker session id (or its name) to stop.' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => control.kill(caller(exec, 'vibe_kill'), args.session),
    }),
    defineTool({
      name: 'vibe_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: (_args, exec) => Promise.resolve(control.list(caller(exec, 'vibe_list'))),
    }),
  ]
}
