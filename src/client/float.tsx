/**
 * The floating monitor: a small translucent, draggable overlay with the four
 * headline metrics (CPU, GPU, memory, network rates), registered into the
 * shell's overlay layer. Visibility and position live in a module store
 * persisted to localStorage and shared with the dashboard's toggle button;
 * the widget polls the status route on its own while visible and stops when
 * hidden or closed.
 */
import { useEffect, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { openJunkCleanup } from './cleanup.ts'
import { DEFAULT_POLL_MS, formatBytes, formatRate, usePcStatus } from './face.ts'

/** Persisted widget state: on/off plus the last viewport position. */
export interface FloatState {
  readonly visible: boolean
  readonly x: number
  readonly y: number
}

const STORAGE_KEY = 'pc-manager.float.v1'

/** Approximate widget box for viewport clamping; generous beats clipping.
 * Four metric rows plus the hairline-separated cleanup action row. */
const FLOAT_WIDTH = 200
const FLOAT_HEIGHT = 178
const FLOAT_MARGIN = 8

/** First-run corner: bottom-left, above the left rail's Settings button. */
function initialPosition(): { x: number, y: number } {
  return {
    x: FLOAT_MARGIN,
    y: Math.max(FLOAT_MARGIN, window.innerHeight - FLOAT_HEIGHT - 76),
  }
}

function clampToViewport(x: number, y: number): { x: number, y: number } {
  return {
    x: Math.min(Math.max(FLOAT_MARGIN, x), Math.max(FLOAT_MARGIN, window.innerWidth - FLOAT_WIDTH - FLOAT_MARGIN)),
    y: Math.min(Math.max(FLOAT_MARGIN, y), Math.max(FLOAT_MARGIN, window.innerHeight - FLOAT_HEIGHT - FLOAT_MARGIN)),
  }
}

function load(): FloatState {
  if (typeof window === 'undefined') return { visible: false, x: 0, y: 0 }
  const fallback = { visible: false, ...initialPosition() }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as Partial<FloatState>
    const position = clampToViewport(
      typeof parsed.x === 'number' ? parsed.x : fallback.x,
      typeof parsed.y === 'number' ? parsed.y : fallback.y,
    )
    return { visible: parsed.visible === true, ...position }
  } catch {
    return fallback
  }
}

let state: FloatState = load()
const listeners = new Set<() => void>()

/** The dashboard toggle and the widget both read/write through this store. */
export function subscribeFloat(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFloatState(): FloatState {
  return state
}

export function setFloatState(patch: Partial<FloatState>): void {
  const next = { ...state, ...patch }
  state = typeof patch.x === 'number' || typeof patch.y === 'number'
    ? { ...next, ...clampToViewport(next.x, next.y) }
    : next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A full storage area costs persistence, never the widget itself.
  }
  for (const listener of listeners) listener()
}

/** One metric line: muted label left, tabular value right. */
function FloatRow({ label, value }: { label: string, value: string }): ReactNode {
  return (
    <div className='pc-float-row'>
      <span className='pc-float-label'>{label}</span>
      <span className='pc-float-value'>{value}</span>
    </div>
  )
}

interface DragState {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly origX: number
  readonly origY: number
}

/**
 * The widget body registered in `shell.overlay`: renders nothing while hidden,
 * so its poller (keyed on visibility) is dormant too. The whole card is the
 * drag handle except the close button; pointercancel, lost capture, and
 * pointerup all end the drag so an interrupted gesture never sticks.
 */
export function FloatingMonitor({ t }: PropsLocale<'pcManager'>): ReactNode {
  const { visible } = useSyncExternalStore(subscribeFloat, getFloatState)
  const { sample, error, stale } = usePcStatus({ visible, pollMs: DEFAULT_POLL_MS, sort: 'cpu' })
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)

  // A resize can strand a persisted position off-screen; re-clamp in place.
  useEffect(() => {
    const onResize = (): void => {
      const { x, y } = getFloatState()
      setFloatState(clampToViewport(x, y))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Capture already gone — the drag is over either way.
    }
  }

  if (!visible) return null
  const { x, y } = getFloatState()
  const status = sample?.status ?? null
  // Honesty on a tiny canvas: a failed stream shows '—' instead of frozen
  // numbers, and a stale frame dims the whole window (same 0.55 as the
  // dashboard) rather than posing as live.
  const value = (readable: string | null): string => error !== null ? '—' : readable ?? '…'
  return (
    <div
      className='pc-float'
      data-dragging={dragging}
      data-stale={stale}
      role='complementary'
      aria-label={t('float.aria')}
      style={{ left: x, top: y }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button') !== null) return
        const position = getFloatState()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origX: position.x,
          origY: position.y,
        }
        setDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        setFloatState({
          x: drag.origX + event.clientX - drag.startX,
          y: drag.origY + event.clientY - drag.startY,
        })
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <button type='button' className='pc-float-close' aria-label={t('float.close')}
        onClick={() => setFloatState({ visible: false })}>✕</button>
      <FloatRow label={t('card.cpu')}
        value={value(status === null ? null : `${status.cpu.usagePercent?.toFixed(1) ?? '—'}%`)} />
      <FloatRow label={t('card.gpu')}
        value={value(status === null ? null : `${status.gpu.usagePercent?.toFixed(1) ?? '—'}%`)} />
      <FloatRow label={t('card.memory')}
        value={value(status === null ? null
          : `${formatBytes(status.memory.usedBytes)} / ${formatBytes(status.memory.totalBytes)}`)} />
      <FloatRow label={t('card.network')}
        value={value(sample === null ? null : `↓${formatRate(sample.rxPerSec)} ↑${formatRate(sample.txPerSec)}`)} />
      {/* The one action the quiet widget carries: the cleanup trigger sits
          behind its button, so it neither joins the drag surface nor disturbs
          the readings above. */}
      <div className='pc-float-action'>
        <span className='pc-float-label'>{t('cleanup.label')}</span>
        <button type='button' className='pc-action-pill' onClick={() => openJunkCleanup()}>{t('cleanup.scan')}</button>
      </div>
    </div>
  )
}

export type { TranslateNS }
