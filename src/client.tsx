/**
 * Browser half: a "Vibe" chip in the composer tool row while the session is a
 * director. It reads the host-folded `vibe` projection and leaves the mode
 * through the `/vibe off` command channel (mirrors dsh-client-ui-plan).
 */
import { useEffect, useRef, useState } from 'react'

interface VibeView {
  active: boolean
  workers: number
}

interface CommandResult {
  ok: boolean
  error?: { message: string; code: string }
  value?: unknown
}

interface ClientContext {
  effect(fn: () => () => void, label?: string): void
  locale: { register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void }
  slots: {
    inject(name: string, fn: () => () => void): void
    register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  }
  remote: { commands: { execute(sessionId: string, line: string, attachments: unknown[]): Promise<CommandResult> } }
}

interface ChipProps {
  sessionId: string
  useProjection(key: 'vibe'): VibeView | undefined
  exitVibe(sessionId: string): Promise<string | null>
  t(key: string): string
}

const NS = 'vibe'

const en = {
  'chip.label': 'Vibe',
  'chip.aria': 'Vibe mode on, press to turn off',
  'chip.title': 'Vibe mode on: this session directs background workers. Click to turn off (/vibe off)',
  'chip.exitFailed': 'Failed to leave vibe mode',
}

const zh = {
  'chip.label': 'Vibe',
  'chip.aria': 'vibe mode 已开启，按下关闭',
  'chip.title': 'vibe mode 已开启：本会话正在指挥后台 worker。点击关闭（/vibe off）',
  'chip.exitFailed': '退出 vibe mode 失败',
}

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  border: 'none',
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  cursor: 'pointer',
  background: 'var(--dsw-alias-state-info-tertiary, rgba(99, 102, 241, 0.14))',
  color: 'var(--dsw-alias-state-info-label, #4f46e5)',
} as const

function VibeChip({ sessionId, useProjection, exitVibe, t }: ChipProps) {
  const vibe = useProjection('vibe')
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  if (vibe === undefined || !vibe.active) return null
  const off = () => {
    setLeaving(true)
    setError(null)
    exitVibe(sessionId).then((failure) => {
      if (!alive.current) return
      setLeaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!alive.current) return
      setLeaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" style={{ ...chipStyle, opacity: leaving ? 0.6 : 1 }} aria-label={t('chip.aria')}
        title={t('chip.title')} disabled={leaving} onClick={off}>
        {t('chip.label')}
        {vibe.workers > 0 && <span style={{ opacity: 0.75 }}>· {vibe.workers}</span>}
        <span aria-hidden="true" style={{ opacity: 0.7 }}>×</span>
      </button>
      {error !== null && (
        <span role="status" title={error} style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #dc2626)' }}>
          {t('chip.exitFailed')}
        </span>
      )}
    </span>
  )
}

export const inject = ['slots', 'remote', 'remote.commands', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vibe-mode: dictionaries')
  const exitVibe = async (sessionId: string): Promise<string | null> => {
    const result = await ctx.remote.commands.execute(sessionId, '/vibe off', [])
    if (!result.ok) return `${result.error?.message ?? 'error'} (${result.error?.code ?? 'unknown'})`
    if (result.value === undefined) return 'unknown command: /vibe off'
    return null
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'vibe-mode',
    order: 50,
    locale: NS,
    inject: () => ({ exitVibe }),
  }, VibeChip as (props: never) => unknown))
}
