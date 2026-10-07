/**
 * The dashboard tab's body: metric cards over a polled status snapshot, drawn
 * with hand-rolled SVG (usage bars and sparklines — the shell shares no chart
 * library). Pure presentation: every value comes from the hook, every label
 * from the locale dictionary. Color keeps the zero-palette discipline — every
 * hue derives from currentColor, except the semantic state tones that come
 * from the host's own tokens when it exposes them.
 */
import { useEffect, useState } from 'react'
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type {
  PropsLocale, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ProcessInfo, ProcessSort, SystemStatus } from '../types.ts'
import {
  DEFAULT_POLL_MS, fetchProcessRows, formatBytes, formatLoad, formatMinutes, formatRate, formatUptime, usePcStatus,
} from './face.ts'
import type { DashboardSample, HistoryBuffers } from './face.ts'
import { getFloatState, setFloatState, subscribeFloat } from './float.tsx'
import { ensureStyles } from './styles.ts'

/** The body's composed props: the tab it draws and its copy. */
export type DashboardBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'pcManager'>

/**
 * Card corners and rhythm; opacity-based fills adapt to both color schemes.
 * Semantic tones come from the host's state tokens with a currentColor
 * fallback, so a shell without them degrades to the monochrome ladder.
 * Layout: the body is a size container — cards snap to a two-column grid on
 * wide panes, and optional table columns drop below 420px instead of
 * overflowing.
 */

/** Percent with one decimal everywhere, matching the process table. */
function percentLabel(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

/** Semantic load tone: glance-readable without reading the number. */
function toneOf(percent: number | null): 'ok' | 'warn' | 'critical' {
  if (percent === null) return 'ok'
  if (percent >= 95) return 'critical'
  if (percent >= 85) return 'warn'
  return 'ok'
}

/** Battery tone is inverted by nature: a high charge is healthy, a low one
 * is the warning — the load thresholds must not leak in here. */
function batteryTone(percent: number | null): 'ok' | 'warn' | 'critical' {
  if (percent === null) return 'ok'
  if (percent <= 20) return 'critical'
  if (percent <= 35) return 'warn'
  return 'ok'
}

/** One usage bar with its 0–100 fill; doubles as a progressbar for assistive
 * tech. `tone` overrides the load-derived tone (battery semantics differ). */
function UsageBar({ percent, label, tone }: {
  percent: number | null
  label: string
  tone?: 'ok' | 'warn' | 'critical'
}): ReactNode {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent))
  return (
    <div
      className='pc-manager-bar'
      role='progressbar'
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(clamped)}
    >
      <div
        className='pc-manager-bar-fill'
        data-tone={tone ?? toneOf(percent)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** Filled sparkline over the sample history; scales to the window's (shared) max. */
function Sparkline({ values, max }: { values: readonly number[], max?: number }): ReactNode {
  if (values.length < 2) return null
  const top = Math.max(...values, max ?? 1)
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100
    const y = 24 - (value / top) * 21
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return (
    <svg className='pc-manager-spark' viewBox='0 0 100 24' preserveAspectRatio='none' aria-hidden>
      <polyline points={points} fill='none' stroke='currentColor' strokeWidth={1.4}
        vectorEffect='non-scaling-stroke' />
    </svg>
  )
}

function cardHeading(label: string, value: ReactNode, tone?: 'ok' | 'warn' | 'critical'): ReactNode {
  return (
    <div className='pc-manager-row'>
      <span className='pc-manager-label'>{label}</span>
      <span className='pc-manager-value' data-tone={tone === 'critical' ? 'critical' : undefined}>{value}</span>
    </div>
  )
}

/** The interface worth headlining: busiest by lifetime traffic, so an idle
 * moment does not promote a dead interface over the one carrying history. */
function topInterface(sample: DashboardSample): { name: string, rxPerSec: number, txPerSec: number } | null {
  let best: { name: string, rxPerSec: number, txPerSec: number, lifetime: number } | null = null
  for (const iface of sample.status.network) {
    const rate = sample.netRates.get(iface.interface)
    if (rate === undefined) continue
    const lifetime = iface.rxBytes + iface.txBytes
    if (best === null || lifetime > best.lifetime) {
      best = { name: iface.interface, rxPerSec: rate.rxPerSec, txPerSec: rate.txPerSec, lifetime }
    }
  }
  return best === null ? null : { name: best.name, rxPerSec: best.rxPerSec, txPerSec: best.txPerSec }
}

/** Volume rows worth a dashboard card: the boot volume, its Data overlay, and
 * user data mounts. Recovery is a frozen system volume; the domain snapshot
 * keeps every volume for the model. */
function dashboardVolumes(disks: SystemStatus['disks']): SystemStatus['disks'] {
  return disks.filter(disk =>
    disk.mount === '/' || disk.mount === '/System/Volumes/Data'
    || (disk.mount.startsWith('/Volumes/') && disk.mount !== '/Volumes/Recovery'))
}

function CpuCard({ status, history, t }: {
  status: SystemStatus
  history: HistoryBuffers
  t: TranslateNS<'pcManager'>
}): ReactNode {
  const usage = status.cpu.usagePercent
  return (
    <section className='pc-manager-card'>
      {cardHeading(t('card.cpu'), percentLabel(usage), toneOf(usage))}
      <UsageBar percent={usage} label={t('card.cpu')} />
      <Sparkline values={history.cpu} />
      <div className='pc-manager-sub'>
        <span className='pc-manager-muted'>{t('cpu.loadavg', {
          one: formatLoad(status.cpu.loadavg[0]),
          five: formatLoad(status.cpu.loadavg[1]),
          fifteen: formatLoad(status.cpu.loadavg[2]),
        })}</span>
        <span className='pc-manager-muted'>{t('cpu.cores', { cores: status.cpu.cores })}</span>
      </div>
    </section>
  )
}

function MemoryCard({ status, t }: { status: SystemStatus, t: TranslateNS<'pcManager'> }): ReactNode {
  const { memory } = status
  const percent = memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes * 100 : null
  return (
    <section className='pc-manager-card'>
      {cardHeading(t('card.memory'),
        `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
        toneOf(percent))}
      <UsageBar percent={percent} label={t('card.memory')} />
      {memory.swapTotalBytes !== null && memory.swapTotalBytes > 0 && (
        <div className='pc-manager-row'>
          <span className='pc-manager-muted'>{t('memory.swap', {
            used: formatBytes(memory.swapUsedBytes ?? 0),
            total: formatBytes(memory.swapTotalBytes),
          })}</span>
        </div>
      )}
      <div className='pc-manager-wrap'>
        <span className='pc-manager-muted'>{t('memory.detail', {
          app: formatBytes(memory.appMemoryBytes),
          wired: formatBytes(memory.wiredBytes ?? 0),
          compressed: formatBytes(memory.compressedBytes ?? 0),
          cached: formatBytes(memory.cachedBytes ?? 0),
        })}</span>
      </div>
    </section>
  )
}

function DisksCard({ status, t }: { status: SystemStatus, t: TranslateNS<'pcManager'> }): ReactNode {
  const io = status.diskIo.totalBytesPerSec
  return (
    <section className='pc-manager-card'>
      {cardHeading(t('card.disks'), io === null ? '—' : `I/O ${formatRate(io)}`)}
      {dashboardVolumes(status.disks).map(disk => {
        const percent = disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes * 100 : null
        return (
          <div key={disk.mount} className='pc-manager-vol'>
            <div className='pc-manager-row'>
              <span className='pc-manager-muted'>{disk.mount === '/' ? 'macOS' : disk.mount}</span>
              <span className='pc-manager-muted'>
                {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
              </span>
            </div>
            <UsageBar percent={percent} label={disk.mount === '/' ? 'macOS' : disk.mount} />
          </div>
        )
      })}
    </section>
  )
}

function BatteryCard({ status, t }: { status: SystemStatus, t: TranslateNS<'pcManager'> }): ReactNode {
  const battery = status.battery
  if (battery === null) return null
  const state = battery.charging === true
    ? t('battery.state.charging')
    : battery.powerSource === 'AC Power'
      ? t('battery.state.ac')
      : t('battery.state.discharging')
  const facts = [
    battery.healthPercent !== null ? t('battery.health', { health: battery.healthPercent.toFixed(1) }) : null,
    battery.cycleCount !== null ? t('battery.cycles', { cycles: battery.cycleCount }) : null,
  ].filter((fact): fact is string => fact !== null)
  return (
    <section className='pc-manager-card'>
      {cardHeading(t('card.battery'),
        `${battery.percent === null ? '—' : battery.percent.toFixed(1)}% · ${state}`)}
      <UsageBar percent={battery.percent} tone={batteryTone(battery.percent)} label={t('card.battery')} />
      <div className='pc-manager-sub'>
        {facts.length > 0 ? <span className='pc-manager-muted'>{facts.join(' · ')}</span> : <span />}
        {battery.timeRemainingMinutes !== null && (
          <span className='pc-manager-muted'>
            {t('battery.remaining', { time: formatMinutes(battery.timeRemainingMinutes) })}
          </span>
        )}
      </div>
    </section>
  )
}

function NetworkCard({ sample, history, t }: {
  sample: DashboardSample
  history: HistoryBuffers
  t: TranslateNS<'pcManager'>
}): ReactNode {
  const top = topInterface(sample)
  // One shared scale so rx and tx are actually comparable with each other.
  const sharedMax = Math.max(...history.netRx, ...history.netTx, 1)
  return (
    <section className='pc-manager-card'>
      {cardHeading(t('card.network'),
        top === null
          ? t('network.noData')
          : `${top.name} ↓${formatRate(top.rxPerSec)} ↑${formatRate(top.txPerSec)}`)}
      <div className='pc-manager-netrow'>
        <span className='pc-manager-netlabel'>{t('network.rxLabel')}</span>
        <Sparkline values={history.netRx} max={sharedMax} />
      </div>
      <div className='pc-manager-netrow'>
        <span className='pc-manager-netlabel'>{t('network.txLabel')}</span>
        <Sparkline values={history.netTx} max={sharedMax} />
      </div>
      <span className='pc-manager-sr'>{t('network.trendSr')}</span>
    </section>
  )
}

/** Process basename for the table (the full command stays in the title tooltip). */
function shortCommand(command: string): string {
  return command.includes('/') ? command.split('/').pop() ?? command : command
}

/** Sortable table headers: the server-ranked metrics plus pid (client-ranked). */
export type TableSortKey = ProcessSort | 'pid'

/** Process-table sort direction; the server always returns best-N descending. */
export type ProcessSortDir = 'desc' | 'asc'

/** The column header label of a sort key, reused by aria-labels and the region name. */
function sortKeyLabel(key: TableSortKey, t: TranslateNS<'pcManager'>): string {
  return t(key === 'pid' ? 'process.column.pid'
    : key === 'mem' ? 'process.column.mem'
      : key === 'network' ? 'process.column.net'
        : 'process.column.cpu')
}

function ProcessCard({ rows, sort, dir, onSortChange, loading, processRates, t }: {
  rows: readonly ProcessInfo[]
  sort: TableSortKey
  dir: ProcessSortDir
  onSortChange: (sort: TableSortKey, dir: ProcessSortDir) => void
  loading: boolean
  processRates: ReadonlyMap<number, { rxPerSec: number, txPerSec: number }>
  t: TranslateNS<'pcManager'>
}): ReactNode {
  // A column whose metric has no data at all does not render — a wall of "—"
  // is noise. The schema keeps the fields, so a future data source brings the
  // column back automatically.
  const hasNet = rows.some(row => row.netRxBytes !== null || row.netTxBytes !== null)
  const hasGpu = rows.some(row => row.gpuPercent !== null)
  const hasDisk = rows.some(row => row.diskReadBytes !== null || row.diskWrittenBytes !== null)
  const tableLabel = t('process.tableLabel', { sort: sortKeyLabel(sort, t) })
  // Metric columns rank server-side (descending best-N; ascending reverses the
  // same selection). Pid ranks client-side within the fetched rows.
  const display = sort === 'pid'
    ? [...rows].sort((left, right) => dir === 'desc' ? right.pid - left.pid : left.pid - right.pid)
    : dir === 'desc' ? rows : [...rows].reverse()
  const ariaSort = (key: TableSortKey): 'ascending' | 'descending' | undefined =>
    sort === key ? (dir === 'desc' ? 'descending' : 'ascending') : undefined
  const sortButton = (key: TableSortKey, label: string): ReactNode => {
    const active = sort === key
    return (
      <button
        type='button'
        className='pc-manager-thbtn'
        data-active={active}
        aria-label={t('process.sortBy', { sort: label })}
        onClick={() => onSortChange(key, active && dir === 'desc' ? 'asc' : 'desc')}
      >
        {label}{active ? (dir === 'desc' ? ' ▾' : ' ▴') : ''}
      </button>
    )
  }
  return (
    <section className='pc-manager-card'>
      <div className='pc-manager-row'>
        <span className='pc-manager-label'>{t('card.processes')}</span>
      </div>
      {rows.length === 0
        ? <div className='pc-manager-muted'>{t('process.empty')}</div>
        : (
            <div
              className='pc-manager-tablewrap'
              role='region'
              aria-label={tableLabel}
              tabIndex={0}
              aria-busy={loading}
              data-loading={loading}
            >
              <table className='pc-manager-table'>
                <thead>
                  <tr>
                    <th scope='col' className='pc-manager-left'>{t('process.column.command')}</th>
                    <th scope='col' aria-sort={ariaSort('pid')}>{sortButton('pid', t('process.column.pid'))}</th>
                    <th scope='col' aria-sort={ariaSort('cpu')}>{sortButton('cpu', t('process.column.cpu'))}</th>
                    <th scope='col' aria-sort={ariaSort('mem')}>{sortButton('mem', t('process.column.mem'))}</th>
                    {hasNet && (
                      <th scope='col' className='pc-manager-col-optional' aria-sort={ariaSort('network')}>
                        {sortButton('network', t('process.column.net'))}
                      </th>
                    )}
                    {hasGpu && <th scope='col' className='pc-manager-col-optional'>{t('process.column.gpu')}</th>}
                    {hasDisk && <th scope='col' className='pc-manager-col-optional'>{t('process.column.disk')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {display.map(row => (
                    <tr key={row.pid}>
                      <td className='pc-manager-left pc-manager-cmd' title={row.command}>{shortCommand(row.command)}</td>
                      <td>{row.pid}</td>
                      <td>{row.cpuPercent.toFixed(1)}%</td>
                      <td>{formatBytes(row.rssBytes)}</td>
                      {hasNet && (
                        <td className='pc-manager-col-optional'>
                          {(() => {
                            // Live rate over the process's own window (server-derived);
                            // '—' when no window exists yet — cumulative counters
                            // without context would masquerade as a rate.
                            const rate = processRates.get(row.pid)
                            return rate === undefined ? t('process.unavailable')
                              : `↓${formatRate(rate.rxPerSec)} ↑${formatRate(rate.txPerSec)}`
                          })()}
                        </td>
                      )}
                      {hasGpu && (
                        <td className='pc-manager-col-optional'>
                          {row.gpuPercent === null ? t('process.unavailable') : `${row.gpuPercent}%`}
                        </td>
                      )}
                      {hasDisk && (
                        <td className='pc-manager-col-optional'>
                          {row.diskReadBytes === null ? t('process.unavailable') : formatBytes(row.diskReadBytes)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </section>
  )
}

/** Loading placeholder mirroring the card rhythm, so arrival does not jump. */
function SkeletonBody({ error, onRetry, loading, t }: {
  error: string | null
  onRetry: () => void
  loading: boolean
  t: TranslateNS<'pcManager'>
}): ReactNode {
  return (
    <div className='pc-manager-body'>
      {error !== null && <ErrorBanner error={error} stale={false} onRetry={onRetry} loading={loading} t={t} />}
      <div className='pc-manager-cards' aria-hidden>
        <div className='pc-manager-card pc-manager-sk' />
        <div className='pc-manager-card pc-manager-sk' />
        <div className='pc-manager-card pc-manager-sk' />
        <div className='pc-manager-card pc-manager-sk pc-manager-sk-wide' />
      </div>
      <div className='pc-manager-state' role='status'>{t('loading')}</div>
    </div>
  )
}

function ErrorBanner({ error, stale, onRetry, loading, t }: {
  error: string
  stale: boolean
  onRetry: () => void
  loading: boolean
  t: TranslateNS<'pcManager'>
}): ReactNode {
  return (
    <div className='pc-manager-error' role='alert'>
      <span>
        {t('error.unavailable', { message: error })}
        {stale ? ` ${t('error.stale')}` : ''}
      </span>
      <button type='button' onClick={onRetry} disabled={loading}>{t('error.retry')}</button>
    </div>
  )
}

/** The keyed tab body: poll, then draw each metric card. */
export function DashboardBody(props: DashboardBodyProps): ReactNode {
  const { useTabInfo, t } = props
  ensureStyles()
  const { tab } = useTabInfo()
  const [sort, setSort] = useState<TableSortKey>('cpu')
  const [dir, setDir] = useState<ProcessSortDir>('desc')
  const floatVisible = useSyncExternalStore(subscribeFloat, getFloatState).visible
  // Pid ranks client-side; the server still fetches a metric-ranked best-N.
  const fetchSort: ProcessSort = sort === 'pid' ? 'cpu' : sort
  const { sample, history, error, loading, stale, refetch } =
    usePcStatus({ visible: tab.visible, pollMs: DEFAULT_POLL_MS, sort: fetchSort })
  // The stream carries the default (CPU) ranking; a memory or network view
  // refreshes its rows once per landed frame over the fallback HTTP route.
  const [rankedRows, setRankedRows] = useState<ProcessInfo[] | null>(null)
  const frameAt = sample?.status.sampledAt ?? ''
  useEffect(() => {
    // Only the memory ranking needs the fallback HTTP route: its rows come
    // from the full table and need no cross-frame state. The network ranking
    // lives in every frame (topByNetwork) because only the pump can difference
    // per-pid windows.
    if (sort !== 'mem') {
      setRankedRows(null)
      return
    }
    const controller = new AbortController()
    void fetchProcessRows(sort, controller.signal)
      .then(rows => setRankedRows(rows))
      .catch(() => undefined)
    return () => controller.abort()
  }, [sort, frameAt])

  /** Header click: a new column starts descending; the active column flips. */
  const onSortChange = (next: TableSortKey, nextDir: ProcessSortDir): void => {
    setSort(next)
    setDir(nextDir)
  }

  if (sample === null) {
    return <SkeletonBody error={error} onRetry={refetch} loading={loading} t={t} />
  }

  const { status } = sample
  return (
    <div className='pc-manager-body' data-stale={stale}>
      {error !== null && <ErrorBanner error={error} stale={stale} onRetry={refetch} loading={loading} t={t} />}
      <div className='pc-manager-header'>
        <span className='pc-manager-host'>
          {status.hostname}
          {status.osVersion !== null ? ` · macOS ${status.osVersion}` : ''}
        </span>
        <span className='pc-manager-header-right'>
          <span className='pc-manager-uptime'>{t('uptime.label', { time: formatUptime(status.uptimeSeconds) })}</span>
          <button
            type='button'
            className='pc-manager-float-toggle'
            aria-pressed={floatVisible}
            data-active={floatVisible}
            onClick={() => setFloatState({ visible: !floatVisible })}
          >
            {t('float.toggle')}
          </button>
        </span>
      </div>
      {/* Metric cards flow in a balanced masonry; the process table stays a
          full-width sibling below it — it cannot cross the columns container. */}
      <div className='pc-manager-cards'>
        <CpuCard status={status} history={history} t={t} />
        {status.gpu.usagePercent !== null && (
          <section className='pc-manager-card'>
            {cardHeading(t('card.gpu'), percentLabel(status.gpu.usagePercent), toneOf(status.gpu.usagePercent))}
            <UsageBar percent={status.gpu.usagePercent} label={t('card.gpu')} />
          </section>
        )}
        <MemoryCard status={status} t={t} />
        <DisksCard status={status} t={t} />
        <BatteryCard status={status} t={t} />
        <NetworkCard sample={sample} history={history} t={t} />
      </div>
      <ProcessCard
        rows={sort === 'network' ? sample.topByNetwork : (rankedRows ?? status.topProcesses)}
        sort={sort} dir={dir} onSortChange={onSortChange} loading={loading}
        processRates={sample.processRates} t={t}
      />
    </div>
  )
}
