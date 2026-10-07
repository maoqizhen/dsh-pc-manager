/**
 * Read-only system status sampling for macOS and Linux hosts. macOS probes
 * shell out to system subcommands; Linux reads /proc and /sys directly (zero
 * dependencies, zero privileges). Every probe degrades to an empty result
 * instead of failing the snapshot: monitoring must not hard-fail because one
 * source is missing. Pure parsers are exported for unit tests.
 * @module @deepseek-ai/dsh-pc-manager
 */

import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { hostname, loadavg, cpus, freemem, platform, totalmem, uptime } from 'node:os'
import type { CpuInfo } from 'node:os'
import { join } from 'node:path'
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

/**
 * Linux sampling window: the /proc probes are instant file reads, so the
 * window is padded to give the /proc/diskstats differential (and the CPU
 * average) a full second — matching what macOS's `iostat -c 2` spans on its
 * own clock.
 */
const DISKSTAT_SAMPLE_MS = 1_000

/** Clamp to one decimal, mapping unparseable input to 0 (percent fields never null). */
function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0
}

/**
 * Linux pseudo filesystems `df -k` reports that are not reclaimable volumes.
 * `overlay`/`squashfs` are absent from the set: they are handled specially —
 * a container's overlay root at `/` IS its real disk, while snap squashfs
 * mounts and nested overlay mounts are artifacts.
 */
const PSEUDO_FILESYSTEMS: ReadonlySet<string> = new Set([
  'tmpfs', 'devtmpfs', 'udev', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'mqueue',
  'hugetlbfs', 'fusectl', 'securityfs', 'debugfs', 'tracefs', 'pstore', 'bpf', 'configfs',
  'autofs', 'binfmt_misc', 'ramfs', 'efivarfs', 'erofs', 'iso9660', 'nsfs', 'rpc_pipefs',
  'cramfs', 'fusectlfs',
])

/** Kernel-owned mount points whose contents are never user-reclaimable volumes. */
const PSEUDO_MOUNT_PREFIXES: readonly string[] = ['/dev', '/proc', '/sys', '/run', '/snap']

/**
 * Parse `df -k` stdout into byte-level disk usage. Virtual filesystems are
 * dropped: macOS devfs/map_* snapshots, and Linux pseudo filesystems plus
 * kernel mount points (overlay/squashfs keep only a `/` root).
 */
export function parseDf(stdout: string): DiskUsage[] {
  const disks: DiskUsage[] = []
  for (const line of stdout.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6) continue
    const [filesystem, kbTotal, kbUsed, kbFree] = fields
    // macOS `df -k` carries iused/ifree/%iused between the sizes and the
    // mount (9+ columns); Linux stops at Use% (6 columns). The mount point
    // is the tail in both layouts.
    const mount = fields.slice(fields.length >= 9 ? 8 : 5).join(' ')
    if (filesystem.startsWith('devfs') || filesystem.startsWith('map ')) continue
    if (filesystem === 'overlay' || filesystem === 'squashfs') {
      if (mount !== '/') continue
    } else if (PSEUDO_FILESYSTEMS.has(filesystem)) {
      continue
    }
    if (PSEUDO_MOUNT_PREFIXES.some(prefix => mount === prefix || mount.startsWith(`${prefix}/`))) continue
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

/** Swap totals as both platforms report them. */
export interface SwapUsage {
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

/** Parse `sysctl -n vm.swapusage`; null when the line shape is unrecognized. */
export function parseSwapUsage(stdout: string): SwapUsage | null {
  const totalBytes = swapMember(stdout, 'total')
  const usedBytes = swapMember(stdout, 'used')
  if (totalBytes === null || usedBytes === null) return null
  const freeBytes = swapMember(stdout, 'free')
  return { totalBytes, usedBytes, freeBytes: freeBytes ?? Math.max(0, totalBytes - usedBytes) }
}

/** One /proc/meminfo snapshot scaled to bytes. */
export interface MeminfoUsage {
  totalBytes: number
  freeBytes: number
  /** MemAvailable (kernel 3.14+); null lets the fallback usedBytes apply. */
  availableBytes: number | null
  /** Buffers + Cached + SReclaimable — the page-cache face ("cached files"). */
  cachedBytes: number
  /** Anonymous memory — the "app memory" analog. */
  anonPagesBytes: number
  /** Unreclaimable kernel slab — the closest "wired" analog; null when absent. */
  sUnreclaimBytes: number | null
  swapTotalBytes: number
  swapFreeBytes: number
  /** MemTotal − MemAvailable (fallback: total − free − buffers − cached), floored at 0. */
  usedBytes: number
}

/**
 * Parse `/proc/meminfo` (`MemTotal:  16380760 kB` lines, always kB); null
 * when the MemTotal/MemFree anchors are missing.
 */
export function parseMeminfo(stdout: string): MeminfoUsage | null {
  const values = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s*kB\s*$/.exec(line)
    if (match !== null) values.set(match[1], Number(match[2]) * 1024)
  }
  const totalBytes = values.get('MemTotal')
  const freeBytes = values.get('MemFree')
  if (totalBytes === undefined || freeBytes === undefined) return null
  const buffers = values.get('Buffers') ?? 0
  const cached = values.get('Cached') ?? 0
  const sreclaimable = values.get('SReclaimable') ?? 0
  const availableBytes = values.get('MemAvailable') ?? null
  return {
    totalBytes,
    freeBytes,
    availableBytes,
    cachedBytes: buffers + cached + sreclaimable,
    anonPagesBytes: values.get('AnonPages') ?? 0,
    sUnreclaimBytes: values.get('SUnreclaim') ?? null,
    swapTotalBytes: values.get('SwapTotal') ?? 0,
    swapFreeBytes: values.get('SwapFree') ?? 0,
    usedBytes: availableBytes !== null
      ? Math.max(0, totalBytes - availableBytes)
      : Math.max(0, totalBytes - freeBytes - buffers - cached),
  }
}

/**
 * Parse `/etc/os-release` into the osVersion face: PRETTY_NAME when present
 * (it names the distro itself, e.g. `Debian GNU/Linux 12 (bookworm)`), else
 * NAME + VERSION_ID; null with neither.
 */
export function parseOsRelease(stdout: string): string | null {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/.exec(line)
    if (match !== null) values.set(match[1], match[2] ?? match[3] ?? match[4] ?? '')
  }
  const pretty = values.get('PRETTY_NAME')
  if (pretty !== undefined && pretty.length > 0) return pretty
  const name = values.get('NAME')
  if (name === undefined || name.length === 0) return null
  const version = values.get('VERSION_ID')
  return version === undefined || version.length === 0 ? name : `${name} ${version}`
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

/** The sysfs-derived members of {@link BatteryStatus} off one `BAT*` uevent. */
export interface PowerSupplySample {
  percent: number | null
  charging: boolean | null
  powerSource: string | null
  timeRemainingMinutes: number | null
  cycleCount: number | null
  healthPercent: number | null
}

/**
 * Parse the `uevent` of one `BAT*` supply under /sys/class/power_supply
 * (`POWER_SUPPLY_KEY=value` lines). `acOnline` comes from the adapter
 * `online` files: true/false pins the power source, null derives it from
 * STATUS. Null overall when the node is not a present battery (an AC
 * adapter's uevent, or `PRESENT=0`).
 */
export function parseBatteryUevent(text: string, acOnline: boolean | null): PowerSupplySample | null {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim())
  }
  if (values.get('POWER_SUPPLY_PRESENT') === '0') return null
  if (values.get('POWER_SUPPLY_TYPE') !== 'Battery') return null
  const status = values.get('POWER_SUPPLY_STATUS') ?? null
  const charging = status === null ? null : status === 'Charging'
  const capacityField = Number(values.get('POWER_SUPPLY_CAPACITY'))
  const now = Number(values.get('POWER_SUPPLY_ENERGY_NOW') ?? values.get('POWER_SUPPLY_CHARGE_NOW'))
  const full = Number(values.get('POWER_SUPPLY_ENERGY_FULL') ?? values.get('POWER_SUPPLY_CHARGE_FULL'))
  const design = Number(values.get('POWER_SUPPLY_ENERGY_FULL_DESIGN') ?? values.get('POWER_SUPPLY_CHARGE_FULL_DESIGN'))
  const percent = Number.isFinite(capacityField)
    ? capacityField
    : Number.isFinite(now) && Number.isFinite(full) && full > 0 ? Math.round(now / full * 100) : null
  const healthPercent = Number.isFinite(full) && Number.isFinite(design) && design > 0
    ? Math.min(100, Math.round(full / design * 100))
    : null
  const cycleField = Number(values.get('POWER_SUPPLY_CYCLE_COUNT'))
  const minutesField = Number(values.get(charging === false ? 'POWER_SUPPLY_TIME_TO_EMPTY_NOW' : 'POWER_SUPPLY_TIME_TO_FULL_NOW'))
  const powerSource = acOnline === true
    ? 'AC Power'
    : acOnline === false
      ? 'Battery Power'
      : status === 'Discharging'
        ? 'Battery Power'
        : status !== null && status !== 'Unknown' ? 'AC Power' : null
  return {
    percent,
    charging,
    powerSource,
    timeRemainingMinutes: Number.isFinite(minutesField) ? minutesField : null,
    cycleCount: Number.isFinite(cycleField) ? cycleField : null,
    healthPercent,
  }
}

/**
 * Read the first present battery under /sys/class/power_supply into a
 * {@link BatteryStatus}, pinning the power source from any adapter `online`
 * file; null on desktops/servers (no supply subsystem or no battery).
 */
async function readLinuxBattery(): Promise<BatteryStatus | null> {
  const supplyDir = '/sys/class/power_supply'
  let entries: Dirent[]
  try {
    entries = await readdir(supplyDir, { withFileTypes: true })
  } catch {
    return null
  }
  let acOnline: boolean | null = null
  for (const entry of entries) {
    if (!/^A/i.test(entry.name)) continue
    try {
      const online = (await readFile(join(supplyDir, entry.name, 'online'), 'utf8')).trim() === '1'
      acOnline = acOnline === true ? true : online
    } catch {
      // Not an AC adapter after all; leave the verdict untouched.
    }
  }
  for (const entry of entries) {
    if (!/^B/i.test(entry.name)) continue
    const uevent = await readFile(join(supplyDir, entry.name, 'uevent'), 'utf8').catch(() => null)
    if (uevent === null) continue
    const sample = parseBatteryUevent(uevent, acOnline)
    if (sample !== null) {
      return {
        percent: sample.percent,
        charging: sample.charging,
        powerSource: sample.powerSource,
        timeRemainingMinutes: sample.timeRemainingMinutes,
        cycleCount: sample.cycleCount,
        healthPercent: sample.healthPercent,
      }
    }
  }
  return null
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
 * Parse `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`
 * (one integer line per GPU), taking the busiest; null when no line parses
 * (no NVIDIA hardware, `[Not Supported]` rows, command absent).
 */
export function parseNvidiaSmiGpu(stdout: string): number | null {
  let best: number | null = null
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s*$/.exec(line)
    if (match === null) continue
    const value = Number(match[1])
    if (best === null || value > best) best = value
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

/** Physical whole-disk names; partitions, loop/dm/md devices are excluded so
 * partitions do not double-count against their parent disk. */
const PHYSICAL_DISK_PATTERN = /^(?:sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+|mmcblk\d+)$/

/** One /proc/diskstats snapshot: wall clock plus 512-byte sectors (reads +
 * writes) summed over physical whole disks. */
export interface DiskstatSample {
  at: number
  sectors: number
}

/**
 * Parse `/proc/diskstats` (`major minor name rd_ios rd_merges rd_sectors
 * rd_ms wr_ios wr_merges wr_sectors …`); non-physical or malformed rows are
 * skipped, never summed as garbage.
 */
export function parseDiskstats(stdout: string, at: number = Date.now()): DiskstatSample {
  let sectors = 0
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    if (!PHYSICAL_DISK_PATTERN.test(fields[2] ?? '')) continue
    const read = Number(fields[5])
    const written = Number(fields[9])
    if (!Number.isFinite(read) || !Number.isFinite(written)) continue
    sectors += read + written
  }
  return { at, sectors }
}

/** Whole-disk throughput (bytes/sec) from two /proc/diskstats samples; null
 * on an empty window or a counter reset (never a negative rate). */
export function diskstatRate(prev: DiskstatSample, cur: DiskstatSample): number | null {
  const dtSeconds = (cur.at - prev.at) / 1000
  if (dtSeconds <= 0 || cur.sectors < prev.sectors) return null
  return (cur.sectors - prev.sectors) * 512 / dtSeconds
}

/** Read one /proc/diskstats snapshot (the Linux iostat equivalent). */
async function readDiskstats(): Promise<DiskstatSample> {
  return parseDiskstats(await readFile('/proc/diskstats', 'utf8'))
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

/**
 * Parse `/proc/net/dev` (`iface: rx_bytes … tx_bytes …`, 8 counter fields per
 * direction); loopback excluded. The Linux counterpart of `netstat -ib`.
 */
export function parseProcNetDev(stdout: string): NetworkInterface[] {
  const interfaces: NetworkInterface[] = []
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    if (name === 'lo') continue
    const fields = line.slice(separator + 1).trim().split(/\s+/)
    const rxBytes = Number(fields[0])
    const txBytes = Number(fields[8])
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    interfaces.push({ interface: name, rxBytes, txBytes })
  }
  return interfaces
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

/** One probe round of the full process table: ps rows merged with nettop
 * counters (nettop is macOS-only; Linux has no unprivileged per-process
 * byte counters, so its rows carry null network fields). */
export async function mergeProcessTable(): Promise<ProcessInfo[]> {
  // Linux `comm` truncates to 15 chars; `args` gives the full command line.
  const psColumns = platform() === 'linux' ? 'pid,pcpu,pmem,rss,args' : 'pid,pcpu,pmem,rss,comm'
  const onDarwin = platform() === 'darwin'
  const [psRows, netRows] = await Promise.all([
    probe('ps', [] as ProcessInfo[], async () => {
      const { stdout } = await run('ps', ['-Ao', psColumns], { timeout: EXEC_TIMEOUT_MS })
      return parsePs(stdout)
    }),
    onDarwin
      ? probe('nettop', new Map<number, ProcessNetCounters>(), async () => {
          const { stdout } = await run('nettop', ['-P', '-L', '1', '-n', '-J', 'bytes_in,bytes_out'], { timeout: EXEC_TIMEOUT_MS })
          return parseNettop(stdout)
        })
      : Promise.resolve(new Map<number, ProcessNetCounters>()),
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
 * Collect one system snapshot. Probes run concurrently and are dispatched by
 * platform: macOS shells out (vm_stat/sysctl/pmset/ioreg/iostat/netstat/
 * sw_vers), Linux reads /proc and /sys. Memory uses the platform's own
 * decomposition (macOS: active+wired+compressed over vm_stat; Linux:
 * MemTotal−MemAvailable over /proc/meminfo) with total−free as the
 * documented fallback, so a missing probe degrades instead of failing. The
 * Linux sampling window is padded to a full second for the /proc/diskstats
 * differential.
 */
export async function collectStatus(
  maxTop = DEFAULT_TOP_PROCESSES,
  sort: ProcessSort = 'cpu',
  extras?: CollectExtras,
): Promise<SystemStatus> {
  const onLinux = platform() === 'linux'
  const cpuStart = cpus()
  const startedAt = Date.now()
  // The first diskstats read precedes every probe so the differential spans
  // the whole sampling window.
  const diskstatsStart = onLinux
    ? await probe('diskstats', null as DiskstatSample | null, readDiskstats)
    : null
  const [disks, processTable, network, gpuPercent, iostatPerSec, pmsetBattery, ioregBattery, swap, vmstat, osVersion, meminfo, linuxBattery] =
    await Promise.all([
      probe('df', [] as DiskUsage[], async () => {
        const { stdout } = await run('df', ['-k'], { timeout: EXEC_TIMEOUT_MS })
        return parseDf(stdout)
      }),
      mergeProcessTable(),
      onLinux
        ? probe('netdev', [] as NetworkInterface[], async () => parseProcNetDev(await readFile('/proc/net/dev', 'utf8')))
        : probe('netstat', [] as NetworkInterface[], async () => {
            const { stdout } = await run('netstat', ['-ib'], { timeout: EXEC_TIMEOUT_MS })
            return parseNetstatIb(stdout)
          }),
      onLinux
        ? probe('gpu nvidia-smi', null as number | null, async () => {
            const { stdout } = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: EXEC_TIMEOUT_MS })
            return parseNvidiaSmiGpu(stdout)
          })
        : probe('gpu ioreg', null as number | null, async () => {
            const { stdout } = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeout: EXEC_TIMEOUT_MS })
            return parseIoregGpu(stdout)
          }),
      onLinux
        ? Promise.resolve(null as number | null)
        : probe('iostat', null as number | null, async () => {
            const { stdout } = await run('iostat', ['-d', '-c', '2'], { timeout: EXEC_TIMEOUT_MS })
            return parseIostat(stdout)
          }),
      onLinux
        ? Promise.resolve(null as PmsetBatterySample | null)
        : probe('pmset', null as PmsetBatterySample | null, async () => {
            const { stdout } = await run('pmset', ['-g', 'batt'], { timeout: EXEC_TIMEOUT_MS })
            return parsePmsetBatt(stdout)
          }),
      onLinux
        ? Promise.resolve(null as IoregBatterySample | null)
        : probe('battery ioreg', null as IoregBatterySample | null, async () => {
            const { stdout } = await run('ioreg', ['-rn', 'AppleSmartBattery'], { timeout: EXEC_TIMEOUT_MS })
            return parseIoregBattery(stdout)
          }),
      onLinux
        ? Promise.resolve(null as SwapUsage | null)
        : probe('swapusage', null as SwapUsage | null, async () => {
            const { stdout } = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: EXEC_TIMEOUT_MS })
            return parseSwapUsage(stdout)
          }),
      onLinux
        ? Promise.resolve(null as VmStatUsage | null)
        : probe('vm_stat', null as VmStatUsage | null, async () => {
            const { stdout } = await run('vm_stat', [], { timeout: EXEC_TIMEOUT_MS })
            return parseVmStat(stdout)
          }),
      onLinux
        ? probe('os-release', null as string | null, async () => parseOsRelease(await readFile('/etc/os-release', 'utf8')))
        : probe('sw_vers', null as string | null, async () => {
            const { stdout } = await run('sw_vers', ['-productVersion'], { timeout: EXEC_TIMEOUT_MS })
            const version = stdout.trim()
            return version.length > 0 ? version : null
          }),
      onLinux
        ? probe('meminfo', null as MeminfoUsage | null, async () => parseMeminfo(await readFile('/proc/meminfo', 'utf8')))
        : Promise.resolve(null as MeminfoUsage | null),
      onLinux
        ? probe('power_supply', null as BatteryStatus | null, readLinuxBattery)
        : Promise.resolve(null as BatteryStatus | null),
    ])

  // The macOS iostat probe already spans ~1s on its own clock; Linux's probes
  // are instant file reads, so its window is padded for the diskstats
  // differential (and a steadier CPU average).
  const elapsed = Date.now() - startedAt
  const minWindowMs = onLinux ? DISKSTAT_SAMPLE_MS : CPU_SAMPLE_MS
  if (elapsed < minWindowMs) await delay(minWindowMs - elapsed)
  const cpuEnd = cpus()

  let diskIoPerSec = iostatPerSec
  if (onLinux && diskstatsStart !== null) {
    const end = await probe('diskstats end', null as DiskstatSample | null, readDiskstats)
    if (end !== null) diskIoPerSec = diskstatRate(diskstatsStart, end)
  }

  const total = totalmem()
  const fallbackUsed = total - freemem()
  let usedBytes = fallbackUsed
  let appMemoryBytes = 0
  let wiredBytes: number | null = null
  let compressedBytes: number | null = null
  let cachedBytes: number | null = null
  let purgeableBytes: number | null = null
  let swapTotalBytes: number | null = null
  let swapUsedBytes: number | null = null
  if (vmstat !== null) {
    const vmUsed = vmstat.activeBytes + vmstat.wiredBytes + vmstat.compressedBytes
    usedBytes = vmUsed > 0 ? Math.min(vmUsed, total) : fallbackUsed
    appMemoryBytes = vmstat.activeBytes
    wiredBytes = vmstat.wiredBytes
    compressedBytes = vmstat.compressedBytes
    cachedBytes = vmstat.inactiveBytes + vmstat.speculativeBytes
    purgeableBytes = vmstat.purgeableBytes
    swapTotalBytes = swap?.totalBytes ?? null
    swapUsedBytes = swap?.usedBytes ?? null
  }
  if (meminfo !== null) {
    usedBytes = meminfo.usedBytes
    appMemoryBytes = meminfo.anonPagesBytes
    wiredBytes = meminfo.sUnreclaimBytes
    // Linux exposes no compressed-page counter in /proc/meminfo (zram setups
    // account differently) and no purgeable concept; both stay null.
    compressedBytes = null
    cachedBytes = meminfo.cachedBytes
    swapTotalBytes = meminfo.swapTotalBytes
    swapUsedBytes = meminfo.swapTotalBytes > 0
      ? meminfo.swapTotalBytes - meminfo.swapFreeBytes
      : 0
  }

  const battery: BatteryStatus | null = onLinux
    ? linuxBattery
    : pmsetBattery === null && ioregBattery === null ? null : {
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
      swapTotalBytes,
      swapUsedBytes,
    },
    diskIo: { totalBytesPerSec: diskIoPerSec },
    disks,
    battery,
    network,
    topProcesses: sortProcesses(processTable, sort, maxTop),
    sampledAt: new Date().toISOString(),
  }
}
