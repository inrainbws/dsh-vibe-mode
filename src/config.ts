import Schema from '@deepseek-ai/schemastery'

/** Worker tiers, named after omp's `cli` values. */
export type Tier = 'fast' | 'good'

export const TIERS: readonly Tier[] = ['fast', 'good']

/** Child route override merged over the director's route; unset fields inherit. */
export interface WorkerAgentOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface VibeModeConfig {
  /** Replace the director instructions (supports `{{readImage}}`, `{{todo}}`, `{{todoStep}}`). */
  section?: string
  /** Keep the parent `todo_write` tool in the director's reduced toolset. */
  includeTodo: boolean
  fastProvider: string
  goodProvider: string
  fastAgentOptions?: WorkerAgentOptions
  goodAgentOptions?: WorkerAgentOptions
  fastPersona?: string
  goodPersona?: string
  /** Tools removed from workers when present (default: `send_message`, so results arrive as turn results). */
  workerToolDeny: string[]
  /** Default `vibe_wait` timeout in seconds. */
  waitTimeoutSeconds: number
  /** Characters of a worker's closing message shown in a `<vibe-turn>` result. */
  resultPreviewChars: number
  /** Tool calls listed in a `<vibe-turn>` activity trace. */
  traceLimit: number
}

const AgentOptions = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  reasoningEffort: Schema.string(),
  maxTokens: Schema.natural(),
}).description('Child route override; omitted fields inherit the director route.')

export const Config: Schema<VibeModeConfig> = Schema.object({
  section: Schema.string().description('Director instructions override.'),
  includeTodo: Schema.boolean().default(true),
  fastProvider: Schema.string().default('spawn'),
  goodProvider: Schema.string().default('spawn'),
  fastAgentOptions: AgentOptions,
  goodAgentOptions: AgentOptions,
  fastPersona: Schema.string(),
  goodPersona: Schema.string(),
  workerToolDeny: Schema.array(Schema.string()).default(['send_message']),
  waitTimeoutSeconds: Schema.natural().min(1).default(30),
  resultPreviewChars: Schema.natural().min(200).default(4000),
  traceLimit: Schema.natural().min(1).default(12),
}) as Schema<VibeModeConfig>
