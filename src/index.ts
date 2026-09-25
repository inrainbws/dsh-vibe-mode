/**
 * `dsh-vibe-mode`: omp's vibe mode (https://omp.sh/docs/vibe) for the
 * DeepSeek Harness. `/vibe` turns the session into a director with a
 * read-only toolset plus five worker-control tools; persistent `fast` and
 * `good` worker subagents do the editing, searching, running, and building.
 *
 * @module dsh-vibe-mode
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type VibeModeConfig } from './config.ts'
import { VibeController } from './controller.ts'

export const name = 'vibe-mode'

export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'subagents']

export { Config }
export type { VibeModeConfig, WorkerAgentOptions, Tier } from './config.ts'
export { VibeController } from './controller.ts'
export { DIRECTOR_SECTION } from './prompts.ts'
export { applyVibeEvent, initVibeState, parseWorkerLabel, vibeProjectionDefinition } from './projection.ts'
export type { VibeProjection, VibeUnitState, VibeWorkerEntry } from './projection.ts'

export function apply(ctx: Context, config: VibeModeConfig): void {
  new VibeController(ctx, config)
}
