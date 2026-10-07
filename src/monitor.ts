/**
 * Read-only system status sampling for macOS hosts. Every probe degrades to
 * an empty result instead of failing the snapshot: monitoring must not hard-fail
 * because one subcommand is missing. Pure parsers are exported for unit tests.
 * @module @deepseek-ai/dsh-pc-manager
 */

import { execFile } from 'node:child_process'
import { hostname, loadavg, cpus, freemem, platform, totalmem, uptime } from 'node:os'
import type { CpuInfo } from 'node:os'
import { promisify } from 'node:util'
import type {
  BatteryStatus, DiskUsage, NetworkInterface, ProcessInfo, ProcessSort, SystemStatus,
} from './types.ts'

const run = promisify(execFile)

/** Default row cap for `topProcesses`. */
export const DEFAULT_TOP_PROCESSES = 10

/** Upper bound on process rows any caller (dashboard query param included) may request. */
export const MAX_PROCESS_LIMIT = 50

const EXEC_TIMEOUT_MS = 5_000

/** Minimum window between the two `os.cpus()` samples used for utilization. */
const CPU_SAMPLE_MS = 250

/** Clamp to one decimal, mapping unparseable input to 0 (percent fields never null). */
function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0
}

/**
 * Parse `df -k` stdout into byte-level disk usage. Virtual filesystems
 * (devfs, map_*) are dropped; macOS snapshot mounts keep only real volumes.
 */
export function parseDf(stdout: string): DiskUsage[] {
  const disks: DiskUsage[] = []
  for (const line of stdout.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 9) continue
    const [filesystem, kbTotal, kbUsed, kbFree] = fields
    const mount = fields.slice(8).join(' ')
    if (filesystem.startsWith('devfs') || filesystem.startsWith('map ')) continue
    if (!mount.startsWith('/')) continue
    const total = Number(kbTotal) * 1024
    if (!Number.isFinite(total) || total <= 0) continue
    disks.push({
      mount,
      filesystem,
      totalBytes: total,
      usedBytes: Number(kbUsed) * 1024,
      freeBytes: Number(kbFree) * 1024,
    })
  }
  return disks
}

/**
 * Parse `ps -Ao pid,pcpu,pmem,rss,comm` stdout into rows in input order;
 * ranking happens in {@link sortProcesses}. Network/GPU/disk fields start null
 * and are filled by {@link mergeProcesses} where data exists.
 */
export function parsePs(stdout: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of stdout.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    const pid = Number(fields[0])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const rssKb = Number(fields[3])
    rows.push({
      pid,
      cpuPercent: round1(Number(fields[1])),
      memPercent: round1(Number(fields[2])),
      rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
      command: fields.slice(4).join(' '),
      netRxBytes: null,
      netTxBytes: null,
      gpuPercent: null,
      diskReadBytes: null,
      diskWrittenBytes: null,
    })
  }
  return rows
}

/**
 * Whole-system CPU utilization 0–100 from two `os.cpus()` samples; null when
 * the counter window is empty (e.g. zero elapsed ticks).
 */
export function cpuUsagePercent(prev: readonly CpuInfo[], cur: readonly CpuInfo[]): number | null {
  let busyDelta = 0
  let totalDelta = 0
  for (let index = 0; index < Math.min(prev.length, cur.length); index += 1) {
    const before = prev[index]?.times
    const after = cur[index]?.times
    if (before === undefined || after === undefined) continue
    const beforeTotal = before.user + before.nice + before.sys + before.idle + before.irq
    const afterTotal = after.user + after.nice + after.sys + after.idle + after.irq
    busyDelta += (afterTotal - after.idle) - (beforeTotal - before.idle)
    totalDelta += afterTotal - beforeTotal
  }
  if (totalDelta <= 0) return null
  return round1(Math.min(100, Math.max(0, busyDelta / totalDelta * 100)))
}

/** Page-level memory face derived from one `vm_stat` run, in bytes. */
export interface VmStatUsage {
  freeBytes: number
  activeBytes: number
  inactiveBytes: number
  speculativeBytes: number
  wiredBytes: number
  purgeableBytes: number
  compressedBytes: number
}

const VMSTAT_KEYS: ReadonlyArray<readonly [label: string, field: keyof VmStatUsage]> = [
  ['Pages free', 'freeBytes'],
  ['Pages active', 'activeBytes'],
  ['Pages inactive', 'inactiveBytes'],
  ['Pages speculative', 'speculativeBytes'],
  ['Pages wired down', 'wiredBytes'],
  ['Pages purgeable', 'purgeableBytes'],
  ['Pages occupied by compressor', 'compressedBytes'],
]

/**
 * Parse `vm_stat` stdout (page size read from its header, counts carry a
 * trailing dot); null when the page size is absent or unusable.
 */
export function parseVmStat(stdout: string): VmStatUsage | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const usage: VmStatUsage = {
    freeBytes: 0, activeBytes: 0, inactiveBytes: 0, speculativeBytes: 0,
    wiredBytes: 0, purgeableBytes: 0, compressedBytes: 0,
  }
  for (const line of stdout.split('\n')) {
    const match = /^([^:]+):\s+(\d+)\.?\s*$/.exec(line.trim())
    if (match === null) continue
    const key = VMSTAT_KEYS.find(([label]) => label === match[1])
    if (key === undefined) continue
    usage[key[1]] = Number(match[2]) * pageSize
  }
  return usage
}

/** Binary multiples `sysctl vm.swapusage` reports sizes in. */
const SWAP_UNITS: Readonly<Record<string, number>> = {
  B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4,
}

/** One `total = 12.00M used = ...` triplet member scaled to bytes. */
function swapMember(text: string, key: string): number | null {
  const match = new RegExp(`${key}\\s*=\\s*([\\d.]+)\\s*([BKMGT])`).exec(text)
  if (match === null) return null
  const value = Number(match[1])
  const unit = SWAP_UNITS[match[2] as string]
  return Number.isFinite(value) && unit !== undefined ? value * unit : null
}

/** Parse `sysctl -n vm.swapusage`; null when the line shape is unrecognized. */
export function parseSwapUsage(stdout: string): { totalBytes: number, usedBytes: number, freeBytes: number } | null {
  const totalBytes = swapMember(stdout, 'total')
  const usedBytes = swapMember(stdout, 'used')
  if (totalBytes === null || usedBytes === null) return null
  const freeBytes = swapMember(stdout, 'free')
  return { totalBytes, usedBytes, freeBytes: freeBytes ?? Math.max(0, totalBytes - usedBytes) }
}

/** The pmset-derived members of {@link BatteryStatus}. */
export interface PmsetBatterySample {
  percent: number | null
  charging: boolean
  powerSource: string | null
  timeRemainingMinutes: number | null
}

/**
 * Parse `pmset -g batt`; null when no InternalBattery row appears (desktops),
 * which is the signal that the host has no battery to report.
 */
export function parsePmsetBatt(stdout: string): PmsetBatterySample | null {
  const line = stdout.split('\n').find(candidate => candidate.includes('InternalBattery'))
  if (line === undefined) return null
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(line)
  const remaining = /(\d+):(\d+)\s*remaining/.exec(line)
  const state = line.split(';')[1]?.trim() ?? ''
  return {
    percent: percent === null ? null : Number(percent[1]),
    charging: state === 'charging' || state === 'finishing charge',
    powerSource: /Now drawing from '([^']+)'/.exec(stdout)?.[1] ?? null,
    timeRemainingMinutes: remaining === null ? null : Number(remaining[1]) * 60 + Number(remaining[2]),
  }
}

/** The ioreg-derived members of {@link BatteryStatus}. */
export interface IoregBatterySample {
  cycleCount: number | null
  healthPercent: number | null
}

/** One quoted ioreg integer property. */
function ioregNumber(text: string, key: string): number | null {
  const match = new RegExp(`"${key}"\\s*=\\s*(\\d+)`).exec(text)
  return match === null ? null : Number(match[1])
}

/**
 * Parse `ioreg -rn AppleSmartBattery` into cycle count and health (full over
 * design capacity); null when the node carries no battery evidence at all —
 * desktops expose the node with zeroed capacities.
 */
export function parseIoregBattery(stdout: string): IoregBatterySample | null {
  const cycleCount = ioregNumber(stdout, 'Cycle Count')
  const fullCapacity = ioregNumber(stdout, 'NominalChargeCapacity') ?? ioregNumber(stdout, 'MaxCapacity')
  const designCapacity = ioregNumber(stdout, 'DesignCapacity')
  const healthPercent = fullCapacity !== null && designCapacity !== null && designCapacity > 0
    ? Math.min(100, Math.round(fullCapacity / designCapacity * 100))
    : null
  if (healthPercent === null && (cycleCount ?? 0) === 0) return null
  return { cycleCount, healthPercent }
}

/**
 * Parse `ioreg -r -d 1 -c IOAccelerator` for the GPU's `Device Utilization %`,
 * taking the busiest of several GPUs; null when the key is absent (VMs, and
 * macOS versions that drop it).
 */
export function parseIoregGpu(stdout: string): number | null {
  let best: number | null = null
  for (const match of stdout.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && (best === null || value > best)) best = value
  }
  return best === null ? null : Math.min(100, best)
}

/**
 * Parse `iostat -d -c 2` and return the last (instantaneous) sample's total
 * throughput summed across disks, in bytes/sec. Each disk contributes a
 * `KB/t tps MB/s` triple; MB/s is treated as a binary multiple (1024²).
 */
export function parseIostat(stdout: string): number | null {
  let last: number[] | null = null
  for (const line of stdout.split('\n')) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 3 || tokens.length % 3 !== 0) continue
    if (!tokens.every(token => /^\d+(\.\d+)?$/.test(token))) continue
    last = tokens.map(Number)
  }
  if (last === null) return null
  let mbPerSec = 0
  for (let index = 2; index < last.length; index += 3) {
    const value = last[index]
    if (value !== undefined) mbPerSec += value
  }
  return mbPerSec * 1024 * 1024
}

/**
 * Parse `netstat -ib` into one row per interface, keeping only the `<Link#>`
 * row of each name (address rows repeat the counters). Loopback and down
 * interfaces (`*` suffix) are dropped.
 */
export function parseNetstatIb(stdout: string): NetworkInterface[] {
  const interfaces = new Map<string, NetworkInterface>()
  for (const line of stdout.split('\n').slice(1)) {
    if (!line.includes('<Link#')) continue
    const fields = line.trim().split(/\s+/)
    const name = fields[0]
    if (name === undefined || name.startsWith('lo') || name.endsWith('*')) continue
    // A `<Link#N>` row is `name mtu <Link#N> [mac] Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll`:
    // eight trailing tokens with a MAC address, seven without.
    const linkIndex = fields.findIndex(field => field.startsWith('<Link#'))
    const after = fields.slice(linkIndex + 1)
    const counters = after.length === 8 ? after.slice(1) : after
    const rxBytes = Number(counters[2])
    const txBytes = Number(counters[5])
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    if (!interfaces.has(name)) interfaces.set(name, { interface: name, rxBytes, txBytes })
  }
  return [...interfaces.values()]
}

/** Per-process cumulative byte counters from `nettop`. */
export interface ProcessNetCounters {
  rxBytes: number
  txBytes: number
}

/** `name.pid` → pid (the part after the last dot; names may contain dots/spaces). */
function pidFromKey(key: string): number | null {
  const match = /^(.*)\.(\d+)\s*$/.exec(key)
  if (match === null) return null
  const pid = Number(match[2])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Parse `nettop -P -L 1 -J bytes_in,bytes_out`. macOS 26+ prints CSV
 * (`name.pid,in,out,` rows, warnings mixed into stdout); older releases print
 * a JSON object — both are accepted, garbage lines are skipped.
 */
export function parseNettop(stdout: string): Map<number, ProcessNetCounters> {
  const rows = new Map<number, ProcessNetCounters>()
  const trimmed = stdout.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { processes?: Record<string, { bytes_in?: number, bytes_out?: number }> }
      for (const [key, value] of Object.entries(parsed.processes ?? {})) {
        const pid = pidFromKey(key)
        if (pid === null || value.bytes_in === undefined || value.bytes_out === undefined) continue
        rows.set(pid, { rxBytes: value.bytes_in, txBytes: value.bytes_out })
      }
    } catch {
      // Unparseable JSON degrades to an empty map; probes never throw.
    }
    return rows
  }
  for (const line of trimmed.split('\n')) {
    const parts = line.split(',')
    const pid = pidFromKey(parts[0] ?? '')
    const rxBytes = Number(parts[1])
    const txBytes = Number(parts[2])
    if (pid === null || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    rows.set(pid, { rxBytes, txBytes })
  }
  return rows
}

/** Attach per-process network counters to ps rows by pid. */
export function mergeProcesses(
  psRows: readonly ProcessInfo[],
  netRows: ReadonlyMap<number, ProcessNetCounters>,
): ProcessInfo[] {
  return psRows.map(row => {
    const net = netRows.get(row.pid)
    return net === undefined ? row : { ...row, netRxBytes: net.rxBytes, netTxBytes: net.txBytes }
  })
}

/**
 * Per-interface byte rates derived from two consecutive snapshots (their
 * `sampledAt` stamps provide the window). Missing interfaces, counter resets
 * (reboot), and empty windows yield no entry — never a negative or bogus rate.
 */
export function diffNetRates(
  prev: SystemStatus | null,
  cur: SystemStatus,
): Map<string, { rxPerSec: number, txPerSec: number }> {
  const rates = new Map<string, { rxPerSec: number, txPerSec: number }>()
  if (prev === null) return rates
  const dtSeconds = (Date.parse(cur.sampledAt) - Date.parse(prev.sampledAt)) / 1000
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return rates
  for (const iface of cur.network) {
    const before = prev.network.find(candidate => candidate.interface === iface.interface)
    if (before === undefined || iface.rxBytes < before.rxBytes || iface.txBytes < before.txBytes) continue
    rates.set(iface.interface, {
      rxPerSec: (iface.rxBytes - before.rxBytes) / dtSeconds,
      txPerSec: (iface.txBytes - before.txBytes) / dtSeconds,
    })
  }
  return rates
}

/** The pump's memory of one process's counters at the last frame it appeared in. */
export interface ProcessRateState {
  at: number
  rxBytes: number
  txBytes: number
}

/**
 * Per-process network rates from cumulative counters, each pid differenced
 * over its OWN window since it last appeared in a frame — a process that
 * dropped off a list and returned is not undercounted the way a fixed
 * frame-to-frame dt would. A pid with no history, a counter reset (process
 * restart reusing the pid), or an empty window yields no rate, never a fake
 * one. `nextLastSeen` is the state to carry into the next call.
 */
export function diffProcessRates(
  lastSeen: ReadonlyMap<number, ProcessRateState>,
  rows: readonly ProcessInfo[],
  sampledAt: string,
): { rates: Map<number, { rxPerSec: number, txPerSec: number }>, nextLastSeen: Map<number, ProcessRateState> } {
  const at = Date.parse(sampledAt)
  const rates = new Map<number, { rxPerSec: number, txPerSec: number }>()
  const nextLastSeen = new Map<number, ProcessRateState>()
  if (!Number.isFinite(at)) return { rates, nextLastSeen }
  for (const row of rows) {
    if (row.netRxBytes === null || row.netTxBytes === null) continue
    nextLastSeen.set(row.pid, { at, rxBytes: row.netRxBytes, txBytes: row.netTxBytes })
    const before = lastSeen.get(row.pid)
    if (before === undefined) continue
    const dtSeconds = (at - before.at) / 1000
    if (dtSeconds <= 0 || row.netRxBytes < before.rxBytes || row.netTxBytes < before.txBytes) continue
    rates.set(row.pid, {
      rxPerSec: (row.netRxBytes - before.rxBytes) / dtSeconds,
      txPerSec: (row.netTxBytes - before.txBytes) / dtSeconds,
    })
  }
  return { rates, nextLastSeen }
}

/** Rank rows by the requested key and keep at most `limit`. */
export function sortProcesses(rows: readonly ProcessInfo[], sort: ProcessSort, limit: number): ProcessInfo[] {
  const weight = (row: ProcessInfo): number => {
    switch (sort) {
      case 'mem': return row.rssBytes
      case 'network': return (row.netRxBytes ?? 0) + (row.netTxBytes ?? 0)
      default: return row.cpuPercent
    }
  }
  return [...rows].sort((left, right) => weight(right) - weight(left)).slice(0, Math.max(0, limit))
}

/**
 * The rows a rate-ranked view needs: the CPU top-N plus every process with a
 * network socket that fell outside it, so per-pid rate windows survive a
 * process bouncing between views. Socket rows are few (tens), so no cap beyond
 * a defensive one.
 */
export function unionProcessRows(rows: readonly ProcessInfo[], cpuLimit: number): ProcessInfo[] {
  const cpuTop = sortProcesses(rows, 'cpu', cpuLimit)
  const inTop = new Set(cpuTop.map(row => row.pid))
  const socketRows = rows
    .filter(row => !inTop.has(row.pid) && (row.netRxBytes !== null || row.netTxBytes !== null))
    .slice(0, 100)
  return [...cpuTop, ...socketRows]
}

/**
 * Rank by live network rate (server-derived). Rows without a rate window —
 * the first frame, or a just-appeared pid — rank as zero, NOT by their
 * cumulative counters: mixing a lifetime total into a rate ranking is exactly
 * the misordering this function exists to prevent. A zero-rate frame keeps
 * the union's incoming (CPU) order via sort stability.
 */
export function sortByNetworkRate(
  rows: readonly ProcessInfo[],
  rates: ReadonlyMap<number, { rxPerSec: number, txPerSec: number }>,
  limit: number,
): ProcessInfo[] {
  const weight = (row: ProcessInfo): number => {
    const rate = rates.get(row.pid)
    return rate === undefined ? 0 : rate.rxPerSec + rate.txPerSec
  }
  return [...rows].sort((left, right) => weight(right) - weight(left)).slice(0, Math.max(0, limit))
}

/** Probe one subcommand, degrading to `fallback` on any failure. */
async function probe<T>(label: string, fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error: unknown) {
    console.warn(`[pc-manager] ${label} probe failed: ${String(error)}`)
    return fallback
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One probe round of the full process table: ps rows merged with nettop counters. */
export async function mergeProcessTable(): Promise<ProcessInfo[]> {
  const [psRows, netRows] = await Promise.all([
    probe('ps', [] as ProcessInfo[], async () => {
      const { stdout } = await run('ps', ['-Ao', 'pid,pcpu,pmem,rss,comm'], { timeout: EXEC_TIMEOUT_MS })
      return parsePs(stdout)
    }),
    probe('nettop', new Map<number, ProcessNetCounters>(), async () => {
      const { stdout } = await run('nettop', ['-P', '-L', '1', '-n', '-J', 'bytes_in,bytes_out'], { timeout: EXEC_TIMEOUT_MS })
      return parseNettop(stdout)
    }),
  ])
  return mergeProcesses(psRows, netRows)
}

/** Full process table ranked and capped (the pc_status / HTTP fallback path). */
export async function listProcesses(sort: ProcessSort = 'cpu', limit = DEFAULT_TOP_PROCESSES): Promise<ProcessInfo[]> {
  return sortProcesses(await mergeProcessTable(), sort, limit)
}

/** Optional extras for {@link collectStatus} callers that live across frames (the pump). */
export interface CollectExtras {
  /** Receives the full merged process table of this round, before ranking. */
  onProcessTable?: (rows: readonly ProcessInfo[]) => void
}

/**
 * Collect one system snapshot. Probes run concurrently; memory uses the
 * vm_stat decomposition (active + wired + compressed) with total−free as the
 * documented fallback, so a missing probe degrades instead of failing.
 */
export async function collectStatus(
  maxTop = DEFAULT_TOP_PROCESSES,
  sort: ProcessSort = 'cpu',
  extras?: CollectExtras,
): Promise<SystemStatus> {
  const cpuStart = cpus()
  const startedAt = Date.now()
  const [disks, processTable, network, gpuPercent, diskIoPerSec, pmsetBattery, ioregBattery, swap, vmstat, osVersion] =
    await Promise.all([
      probe('df', [] as DiskUsage[], async () => {
        const { stdout } = await run('df', ['-k'], { timeout: EXEC_TIMEOUT_MS })
        return parseDf(stdout)
      }),
      mergeProcessTable(),
      probe('netstat', [] as NetworkInterface[], async () => {
        const { stdout } = await run('netstat', ['-ib'], { timeout: EXEC_TIMEOUT_MS })
        return parseNetstatIb(stdout)
      }),
      probe('gpu ioreg', null as number | null, async () => {
        const { stdout } = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeout: EXEC_TIMEOUT_MS })
        return parseIoregGpu(stdout)
      }),
      probe('iostat', null as number | null, async () => {
        const { stdout } = await run('iostat', ['-d', '-c', '2'], { timeout: EXEC_TIMEOUT_MS })
        return parseIostat(stdout)
      }),
      probe('pmset', null as PmsetBatterySample | null, async () => {
        const { stdout } = await run('pmset', ['-g', 'batt'], { timeout: EXEC_TIMEOUT_MS })
        return parsePmsetBatt(stdout)
      }),
      probe('battery ioreg', null as IoregBatterySample | null, async () => {
        const { stdout } = await run('ioreg', ['-rn', 'AppleSmartBattery'], { timeout: EXEC_TIMEOUT_MS })
        return parseIoregBattery(stdout)
      }),
      probe('swapusage', null as { totalBytes: number, usedBytes: number, freeBytes: number } | null, async () => {
        const { stdout } = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: EXEC_TIMEOUT_MS })
        return parseSwapUsage(stdout)
      }),
      probe('vm_stat', null as VmStatUsage | null, async () => {
        const { stdout } = await run('vm_stat', [], { timeout: EXEC_TIMEOUT_MS })
        return parseVmStat(stdout)
      }),
      probe('sw_vers', null as string | null, async () => {
        const { stdout } = await run('sw_vers', ['-productVersion'], { timeout: EXEC_TIMEOUT_MS })
        const version = stdout.trim()
        return version.length > 0 ? version : null
      }),
    ])

  // The iostat probe already spans ~1s; only pad the window when everything
  // else finished faster than the minimum CPU sampling interval.
  const elapsed = Date.now() - startedAt
  if (elapsed < CPU_SAMPLE_MS) await delay(CPU_SAMPLE_MS - elapsed)
  const cpuEnd = cpus()

  const total = totalmem()
  const fallbackUsed = total - freemem()
  let usedBytes = fallbackUsed
  let appMemoryBytes = 0
  let wiredBytes: number | null = null
  let compressedBytes: number | null = null
  let cachedBytes: number | null = null
  let purgeableBytes: number | null = null
  if (vmstat !== null) {
    const vmUsed = vmstat.activeBytes + vmstat.wiredBytes + vmstat.compressedBytes
    usedBytes = vmUsed > 0 ? Math.min(vmUsed, total) : fallbackUsed
    appMemoryBytes = vmstat.activeBytes
    wiredBytes = vmstat.wiredBytes
    compressedBytes = vmstat.compressedBytes
    cachedBytes = vmstat.inactiveBytes + vmstat.speculativeBytes
    purgeableBytes = vmstat.purgeableBytes
  }

  const battery: BatteryStatus | null = pmsetBattery === null && ioregBattery === null ? null : {
    percent: pmsetBattery?.percent ?? null,
    charging: pmsetBattery?.charging ?? null,
    powerSource: pmsetBattery?.powerSource ?? null,
    timeRemainingMinutes: pmsetBattery?.timeRemainingMinutes ?? null,
    cycleCount: ioregBattery?.cycleCount ?? null,
    healthPercent: ioregBattery?.healthPercent ?? null,
  }

  extras?.onProcessTable?.(processTable)
  return {
    platform: platform(),
    hostname: hostname(),
    osVersion,
    uptimeSeconds: uptime(),
    cpu: {
      model: cpuEnd[0]?.model ?? 'unknown',
      cores: cpuEnd.length,
      usagePercent: cpuUsagePercent(cpuStart, cpuEnd),
      loadavg: [loadavg()[0], loadavg()[1], loadavg()[2]],
    },
    gpu: { usagePercent: gpuPercent },
    memory: {
      totalBytes: total,
      usedBytes,
      appMemoryBytes,
      wiredBytes,
      compressedBytes,
      cachedBytes,
      purgeableBytes,
      swapTotalBytes: swap?.totalBytes ?? null,
      swapUsedBytes: swap?.usedBytes ?? null,
    },
    diskIo: { totalBytesPerSec: diskIoPerSec },
    disks,
    battery,
    network,
    topProcesses: sortProcesses(processTable, sort, maxTop),
    sampledAt: new Date().toISOString(),
  }
}
