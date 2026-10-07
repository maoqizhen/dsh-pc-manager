/**
 * The dashboard's shared data base: ONE EventSource over the host's
 * `/pc-manager/stream` pump feeds every consumer (dashboard tab, floating
 * widget, future surfaces). The store reference-counts live consumers — the
 * connection opens with the first and closes with the last, so a fully hidden
 * dashboard costs the server nothing. Rates arrive server-derived in each
 * frame, so even the first frame is usable.
 */
import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import type { ProcessInfo, ProcessSort, SystemStatus } from '../types.ts'

/** Fallback poll interval until the first frame names the pump's interval. */
export const DEFAULT_POLL_MS = 2_000

/** Poll intervals below this are refused client-side (mirrors the host clamp). */
export const MIN_POLL_MS = 500

/** Samples kept per sparkline. */
export const HISTORY_LIMIT = 60

/** One dashboard frame off the stream: snapshot plus server-derived rates. */
export interface DashboardFrameWire {
  status: SystemStatus
  netRates: Record<string, { rxPerSec: number, txPerSec: number }>
  processRates: Record<string, { rxPerSec: number, txPerSec: number }>
  topByNetwork: ProcessInfo[]
  pollMs: number
}

/** One store sample: the wire frame plus summed interface rates. */
export interface DashboardSample {
  readonly status: SystemStatus
  /** Bytes/sec per interface name. */
  readonly netRates: ReadonlyMap<string, { rxPerSec: number, txPerSec: number }>
  /** Bytes/sec per pid (string keys), over each process's own window; may be empty. */
  readonly processRates: ReadonlyMap<number, { rxPerSec: number, txPerSec: number }>
  /** Rows ranked by live network rate, straight from the pump (first frame: cumulative). */
  readonly topByNetwork: readonly ProcessInfo[]
  /** Summed receive/send rates across interfaces, bytes/sec. */
  readonly rxPerSec: number
  readonly txPerSec: number
}

/** Ring-buffer histories per sparkline. */
export interface HistoryBuffers {
  readonly cpu: readonly number[]
  readonly diskIo: readonly number[]
  readonly netRx: readonly number[]
  readonly netTx: readonly number[]
}

interface StoreState {
  readonly sample: DashboardSample | null
  readonly history: HistoryBuffers
  readonly pollMs: number
  readonly error: string | null
  readonly stale: boolean
  readonly connected: boolean
}

const EMPTY_HISTORY: HistoryBuffers = { cpu: [], diskIo: [], netRx: [], netTx: [] }

let state: StoreState = {
  sample: null,
  history: EMPTY_HISTORY,
  pollMs: DEFAULT_POLL_MS,
  error: null,
  stale: false,
  connected: false,
}

const history: { cpu: number[], diskIo: number[], netRx: number[], netTx: number[] } = {
  cpu: [], diskIo: [], netRx: [], netTx: [],
}

const listeners = new Set<() => void>()
let source: EventSource | undefined
let refCount = 0
let lastFrameAt = 0
let watchdog: ReturnType<typeof setInterval> | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let lastReconnectAt = 0

/** Force a reconnect no closer than this to the previous one (retry storm guard). */
const RECONNECT_FLOOR_MS = 2_000

/** A connection this long without a frame is dead weight even if open. */
const FRAME_TIMEOUT_MS = 15_000

function clearReconnectTimer(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
}

function scheduleReconnect(): void {
  clearReconnectTimer()
  if (refCount === 0) return
  const waited = Date.now() - lastReconnectAt
  const delay = Math.max(0, RECONNECT_FLOOR_MS - waited)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    if (refCount > 0) openStream()
  }, delay)
}

function stopWatchdog(): void {
  if (watchdog !== undefined) clearInterval(watchdog)
  watchdog = undefined
}

function notify(patch: Partial<StoreState>): void {
  // Replace, never mutate: useSyncExternalStore compares snapshots with
  // Object.is, so an in-place update would never re-render the consumers.
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function push(key: keyof typeof history, value: number): void {
  const buffer = history[key]
  buffer.push(value)
  if (buffer.length > HISTORY_LIMIT) buffer.splice(0, buffer.length - HISTORY_LIMIT)
}

function ingest(frame: DashboardFrameWire): void {
  lastFrameAt = Date.now()
  const netRates = new Map(Object.entries(frame.netRates))
  const processRates = new Map(Object.entries(frame.processRates ?? {}).map(([pid, rate]) => [Number(pid), rate]))
  let rxPerSec = 0
  let txPerSec = 0
  for (const rate of netRates.values()) {
    rxPerSec += rate.rxPerSec
    txPerSec += rate.txPerSec
  }
  push('cpu', frame.status.cpu.usagePercent ?? 0)
  push('diskIo', frame.status.diskIo.totalBytesPerSec ?? 0)
  push('netRx', rxPerSec)
  push('netTx', txPerSec)
  notify({
    sample: { status: frame.status, netRates, processRates, topByNetwork: frame.topByNetwork ?? [], rxPerSec, txPerSec },
    history: { cpu: [...history.cpu], diskIo: [...history.diskIo], netRx: [...history.netRx], netTx: [...history.netTx] },
    pollMs: Math.max(MIN_POLL_MS, frame.pollMs),
    error: null,
    stale: false,
  })
}

function openStream(): void {
  // A fresh EventSource is also the reconnect path: closing and reopening
  // clears any dead connection state without touching the ref count.
  source?.close()
  stopWatchdog()
  lastReconnectAt = Date.now()
  const stream = new EventSource('/pc-manager/stream')
  source = stream
  stream.onopen = () => notify({ connected: true, error: null })
  stream.onmessage = (event: MessageEvent<string>) => {
    try {
      ingest(JSON.parse(event.data) as DashboardFrameWire)
    } catch (error: unknown) {
      notify({ error: error instanceof Error ? error.message : String(error), stale: true })
    }
  }
  stream.onerror = () => {
    // EventSource retries network errors itself, but a non-200 answer (a
    // restarting host, auth not yet ready) makes it give up for good — take
    // over the retry instead of freezing on the last frame.
    notify({ connected: false, stale: state.sample !== null, error: null })
    if (stream.readyState === EventSource.CLOSED) {
      source = undefined
      scheduleReconnect()
      return
    }
    // CONNECTING: its own retry may land; the watchdog below covers a stall.
  }
  // Frame watchdog: a stream can sit open yet silent (half-dead TCP, a stuck
  // pump). No frame for the timeout window → rebuild the connection.
  watchdog = setInterval(() => {
    if (refCount === 0 || lastFrameAt === 0) return
    if (Date.now() - lastFrameAt > FRAME_TIMEOUT_MS) openStream()
  }, 5_000)
}

function acquire(): () => void {
  refCount += 1
  if (refCount === 1) {
    lastFrameAt = 0
    openStream()
  }
  return () => {
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0) {
      clearReconnectTimer()
      stopWatchdog()
      source?.close()
      source = undefined
      notify({ connected: false, stale: false })
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getStoreState(): StoreState {
  return state
}

/** Force a reconnect (the retry affordance on the error banner). */
export function refetchStream(): void {
  if (refCount > 0) openStream()
}

/**
 * Fetch a non-default process ranking over the fallback HTTP route. Only the
 * memory ranking needs this (full-table ranking, no cross-frame state); the
 * network-by-rate ranking rides in every stream frame (`topByNetwork`),
 * because only the pump can difference per-pid windows.
 */
export function fetchProcessRows(sort: ProcessSort, signal: AbortSignal): Promise<ProcessInfo[]> {
  return fetch(`/pc-manager/status?processSort=${encodeURIComponent(sort)}`, { signal })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<SystemStatus>
    })
    .then(status => status.topProcesses)
}

/** One plan-card item: the scan item plus the UI-only preset verdict. */
export interface JunkPlanItem {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly path: string
  readonly sizeBytes: number
  readonly fileCount: number
  readonly safeToClean: boolean
  readonly rationale: string
  readonly lastModifiedAt: string | null
  readonly recommendedDefault: boolean
}

/** Group-header metadata the host dedupes out of the registry. */
export interface JunkKindMeta {
  readonly kind: string
  readonly label: string
  readonly safeToClean: boolean
  readonly rationale: string
  /** False = safe but non-regenerable (plan shows it unchecked) or not directly cleanable. */
  readonly recommended: boolean
}

/** Response of GET /pc-manager/junk/scan (§16.8). */
export interface JunkPlanResponse {
  readonly items: readonly JunkPlanItem[]
  readonly kindMeta: readonly JunkKindMeta[]
  readonly totalBytes: number
  readonly skipped: ReadonlyArray<{ path: string, reason: string }>
  readonly scannedAt: string
  /** Derived destination for the confirm strip's copy (trash = recoverable). */
  readonly moveToTrash: boolean
}

/** One-shot read-only junk scan for the plan card; caller owns the abort. */
export function fetchJunkPlan(signal: AbortSignal): Promise<JunkPlanResponse> {
  return fetch('/pc-manager/junk/scan', { signal })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<JunkPlanResponse>
    })
}

/** Per-item outcome of one clean run (wire shape of the domain outcome). */
export interface JunkCleanOutcomeWire {
  readonly id: string
  readonly reclaimedBytes: number
  readonly error?: string
}

/** Wire shape of the domain JunkCleanResult. */
export interface JunkCleanResultWire {
  readonly outcomes: readonly JunkCleanOutcomeWire[]
  readonly totalReclaimedBytes: number
  readonly mode: 'trash' | 'delete'
  readonly cleanedAt: string
}

/** Wire error from the direct-clean endpoint (closed union member). */
export interface JunkCleanError {
  readonly code: string
  readonly message: string
}

/**
 * Execute the checked ids directly from the plan card — no LLM involved. The
 * host applies the same config gate and validation chain as the tool path.
 * Resolves with the per-item outcomes; rejects with a code-tagged Error.
 */
export function postJunkClean(ids: readonly string[], signal: AbortSignal): Promise<JunkCleanResultWire> {
  return fetch('/pc-manager/junk/clean', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
    signal,
  }).then(async response => {
    const payload = await response.json() as JunkCleanResultWire | JunkCleanError
    if (!response.ok) {
      const err = payload as JunkCleanError
      throw Object.assign(new Error(err.message !== undefined ? err.message : `HTTP ${response.status}`), { code: err.code ?? 'internal_error' })
    }
    return payload as JunkCleanResultWire
  })
}

export interface PcStatusOptions {
  /** Whether this consumer currently wants data; false releases its reference. */
  visible: boolean
  /** Ignored for live data (the stream sets the pace); kept for API stability. */
  pollMs: number
  /** Ignored: the stream carries the default ranking; kept for API stability.
   * The dashboard's own non-default sorts still use the HTTP route. */
  sort: ProcessSort
}

export interface PcStatusResult {
  sample: DashboardSample | null
  history: HistoryBuffers
  /** The pump's interval as named by the last frame. */
  pollMs: number
  /** Last stream failure message; null while frames are landing. */
  error: string | null
  /** True while no frame has landed yet (the loading state). */
  loading: boolean
  /** The last frame predates the latest connection trouble. */
  stale: boolean
  /** Trigger an immediate reconnect. */
  refetch: () => void
}

/**
 * Subscribe this component to the shared stream base. Every mounted consumer
 * with `visible: true` holds one reference; the underlying EventSource opens
 * with the first and closes with the last. All consumers see the same frames.
 */
export function usePcStatus({ visible }: PcStatusOptions): PcStatusResult {
  const snapshot = useSyncExternalStore(subscribe, getStoreState)
  useEffect(() => (visible ? acquire() : undefined), [visible])
  return {
    sample: snapshot.sample,
    history: snapshot.history,
    pollMs: snapshot.pollMs,
    error: snapshot.error,
    loading: snapshot.sample === null,
    stale: snapshot.stale,
    refetch: refetchStream,
  }
}

/** 1024-based byte size with a unit suffix (`10.9 GB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

/** Byte rate with a per-second suffix (`1.2 MB/s`). */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** Load-average style two-decimal rendering (`2.54`). */
export function formatLoad(value: number): string {
  return Number.isFinite(value) ? (Math.round(value * 100) / 100).toString() : '—'
}

/** Uptime as a compact `2d 3h` / `3h 12m` / `45m` string. */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Battery estimate as `3:12`. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return '—'
  return `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, '0')}`
}
