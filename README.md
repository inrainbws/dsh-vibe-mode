# dsh-vibe-mode

Context management is everything.

[omp's vibe mode](https://omp.sh/docs/vibe) for DeepSeek Harness. `/vibe` turns the
session into a **director**. The director only reads and supervises. Persistent
`fast` and `good` worker subagents do the editing, searching, running and building,
and each worker's turn result comes back to the director to verify.

## Usage

```text
/vibe                      enter vibe mode (run again to leave)
/vibe <directive>          enter vibe mode and send <directive> to the director
/vibe off                  leave vibe mode
```

While vibe mode is on:

- The director's toolset is cut down to `read` (plus `read_image` and `todo_write`
  when the preset has them) and five worker tools:

  | Tool | Input | Behavior |
  | --- | --- | --- |
  | `vibe_spawn` | `{ cli: fast\|good, prompt, name? }` | Starts a persistent worker with a self-contained brief. Returns immediately. |
  | `vibe_send` | `{ session, message }` | Steers a running worker, or starts the next turn of an idle one. |
  | `vibe_wait` | `{ sessions?, timeout? }` | Blocks until the first watched turn finishes (default 30 s). Returns that result, which is then not delivered again. |
  | `vibe_kill` | `{ session }` | Cancels the worker's turn and releases it. Its transcript stays in its child session. |
  | `vibe_list` | `{}` | Roster: tier, state, turn and queue counts, model, recent activity. |

- When a worker finishes a turn, its result arrives in the director's conversation
  as a `<vibe-turn session name cli turn status duration model>` block. The block
  holds the worker's tool-call trace and its closing message, trimmed to
  `resultPreviewChars`.
- Leaving vibe mode restores the director's tools and stops every worker.
- Vibe mode won't start while plan mode is on or a goal is active or paused.
- The web composer shows a **Vibe** chip with the live worker count. Clicking it
  runs `/vibe off`.

## Configuration

Override any option on the bundle's row in your profile's `cordis.patch.yml`:

```yaml
- id: vibe-mode
  config:
    fastAgentOptions: { provider: llm-serve, model: qwen3.8-flash-next }
    goodAgentOptions: { provider: llm-serve, model: DeepSeek-v4.1-Flash-EXL3, reasoningEffort: high }
```

| Option | Default | Meaning |
| --- | --- | --- |
| `fastAgentOptions` / `goodAgentOptions` | inherit | Model route for each tier (`provider`, `model`, `reasoningEffort`, `maxTokens`). Any field left unset is inherited from the director's route. |
| `fastProvider` / `goodProvider` | `spawn` | Subagent provider for each tier. |
| `fastPersona` / `goodPersona` | none | Persona for each tier's workers. |
| `includeTodo` | `true` | Keep `todo_write` in the director's toolset. |
| `workerToolDeny` | `[send_message]` | Tools taken away from workers, so results come back as turn results instead of relayed messages. |
| `waitTimeoutSeconds` | `30` | Default `vibe_wait` timeout. |
| `resultPreviewChars` | `4000` | How much of a worker's closing message goes into a `<vibe-turn>` block. |
| `traceLimit` | `12` | Tool calls listed in a `<vibe-turn>` block. |
| `section` | built-in | Replaces the director's instructions. |

## Persistence

Mode state and the worker roster are folded only from events the harness already
knows, so a vibe session always reloads:

- `/vibe` itself is logged as `command/run` / `command/done`.
- Workers are the `subagent/catalog` rows labelled `fast:<name>` / `good:<name>`.
- A worker counts as killed after a successful `vibe_kill` call.

On resume, the director role comes back automatically, and workers return idle
with their tiers. Workers that were killed, or stopped when the mode ended, stay
stopped.

## Development

```sh
pnpm install
pnpm test          # vitest, against the real dsh services
pnpm typecheck
pnpm build         # lib/index.js (host) + lib/client.js (web chip)
dsh plugin --profile web add /path/to/this/repo
```
