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
import { access, constants as fsConstants, readFile, readdir } from 'node:fs/promises'
import { hostname, loadavg, cpus, freemem, networkInterfaces, platform, release, totalmem, uptime, version } from 'node:os'
import type { CpuInfo, NetworkInterfaceInfo } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type {
  BatteryStatus, DiskUsage, NetworkInterface, ProcessInfo, ProcessSort, PublicIpGeo, SystemStatus,
} from './types.ts'
import { asArray, asNumber, asRecord, asString, parsePowershellJson, PS_ARGV, PS_PREAMBLE, resolvePowershell } from './win32.ts'

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

/**
 * Windows probe timeout. One facts bundle or process table costs ~2.5 s on a
 * host with endpoint security (PowerShell startup dominates), so the 5 s
 * subcommand budget is too tight for a loaded machine — a slow round must
 * still return a snapshot rather than degrade every field.
 */
const WINDOWS_PS_TIMEOUT_MS = 20_000

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
 * Parse `nvidia-smi pmon -c 1` (`gpu pid type sm mem enc dec command` rows,
 * `#` comment headers, `-` placeholders) into per-pid SM utilization; the
 * busiest GPU wins when a pid spans several.
 */
export function parseNvidiaSmiPmon(stdout: string): Map<number, number> {
  const rows = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const trimmedLine = line.trim()
    if (trimmedLine.startsWith('#')) continue
    const fields = trimmedLine.split(/\s+/)
    if (fields.length < 5) continue
    const pid = Number(fields[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const sm = Number(fields[3])
    if (!Number.isFinite(sm)) continue
    const best = rows.get(pid)
    if (best === undefined || sm > best) rows.set(pid, Math.min(100, sm))
  }
  return rows
}

/** Cached nvidia-smi existence: probing must not spawn (and warn) every
 * round on hosts without NVIDIA hardware. */
let nvidiaSmiAvailable: boolean | null = null

/** Where nvidia-smi can live: the Linux toolchain paths, or on Windows the
 * driver's System32/NVSMI locations plus whatever is on PATH. */
function nvidiaSmiCandidates(): readonly string[] {
  if (platform() !== 'win32') return ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi']
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const onPath = (process.env.PATH ?? '')
    .split(';')
    .filter(entry => entry.trim().length > 0)
    .map(entry => win32.join(entry.trim(), 'nvidia-smi.exe'))
  return [
    win32.join(systemRoot, 'System32\\nvidia-smi.exe'),
    win32.join(programFiles, 'NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'),
    ...onPath,
  ]
}

async function hasNvidiaSmi(): Promise<boolean> {
  if (nvidiaSmiAvailable === null) {
    nvidiaSmiAvailable = false
    for (const bin of nvidiaSmiCandidates()) {
      if (await access(bin, fsConstants.X_OK).then(() => true, () => false)) {
        nvidiaSmiAvailable = true
        break
      }
    }
  }
  return nvidiaSmiAvailable
}

/** Attach per-process SM utilization (nvidia-smi pmon) to ps rows by pid. */
export function mergeGpuPercent(
  psRows: readonly ProcessInfo[],
  gpuRows: ReadonlyMap<number, number>,
): ProcessInfo[] {
  if (gpuRows.size === 0) return [...psRows]
  return psRows.map(row => {
    const gpu = gpuRows.get(row.pid)
    return gpu === undefined ? row : { ...row, gpuPercent: gpu }
  })
}

/** Chip names (hwmon `name` or thermal-zone `type`) whose reading counts as
 * the CPU package temperature. */
const CPU_TEMP_SOURCES = /^(?:coretemp|k\d+temp|zenpower|cpu|soc_thermal|soc_dts|acpitz|x86_pkg_temp)/i

/** True when a chip reading may headline as the CPU temperature. */
export function isCpuTempSource(name: string): boolean {
  return CPU_TEMP_SOURCES.test(name)
}

/**
 * The headline CPU temperature across candidate chips: per-core inputs
 * report per-core readings, so the max over the CPU-named chips is the
 * honest glance value. Null when no candidate chip contributed.
 */
export function pickCpuTempCelsius(chips: ReadonlyArray<{ name: string, celsius: readonly number[] }>): number | null {
  let best: number | null = null
  for (const chip of chips) {
    if (!isCpuTempSource(chip.name)) continue
    for (const celsius of chip.celsius) {
      if (Number.isFinite(celsius) && (best === null || celsius > best)) best = celsius
    }
  }
  return best === null ? null : round1(best)
}

/**
 * Linux CPU temperature: hwmon chips (`name` + `temp*_input`, millidegrees)
 * with a thermal_zone fallback (`type` + `temp`). Zero privileges needed —
 * but cloud VMs commonly expose no sensor at all, which reads as null.
 */
async function readLinuxCpuTemp(): Promise<number | null> {
  const chips: Array<{ name: string, celsius: number[] }> = []
  for (const base of ['/sys/class/hwmon', '/sys/class/thermal']) {
    let entries: Dirent[]
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const chip: { name: string, celsius: number[] } = { name: '', celsius: [] }
      if (base.endsWith('hwmon')) {
        if (!entry.name.startsWith('hwmon')) continue
        const dir = join(base, entry.name)
        chip.name = (await readFile(join(dir, 'name'), 'utf8').catch(() => '')).trim()
        for (const file of await readdir(dir).catch(() => [])) {
          if (/^temp\d+_input$/.test(file)) {
            const milli = Number((await readFile(join(dir, file), 'utf8').catch(() => '')).trim())
            if (Number.isFinite(milli)) chip.celsius.push(milli / 1000)
          }
        }
      } else {
        if (!entry.name.startsWith('thermal_zone')) continue
        const dir = join(base, entry.name)
        chip.name = (await readFile(join(dir, 'type'), 'utf8').catch(() => '')).trim()
        const milli = Number((await readFile(join(dir, 'temp'), 'utf8').catch(() => '')).trim())
        if (Number.isFinite(milli)) chip.celsius.push(milli / 1000)
      }
      chips.push(chip)
    }
  }
  return pickCpuTempCelsius(chips)
}

/* -------------------------------------------------------------------------
 * Windows probes.
 *
 * Windows has no /proc-style text interfaces, so everything the node builtins
 * cannot see comes from Windows PowerShell — batched into two scripts because
 * interpreter startup dominates the cost (~2.3 s cold on a host with endpoint
 * security), and split in two so the volume/network/battery half and the
 * process table degrade independently. The node builtins still carry the
 * hot fields (CPU, totals, uptime, OS name): a missing PowerShell leaves a
 * usable snapshot behind, not an empty one.
 * ---------------------------------------------------------------------- */

/** One Windows probe bundle: volumes, memory split, per-NIC counters,
 * whole-disk throughput, GPU engine utilization, battery, firmware thermal
 * zones, and the process table. Each field degrades to null/[] on its own — a
 * WMI class that needs elevation or does not exist on the board must not void
 * the bundle. `processes` already carries the per-pid GPU attribution from
 * this same bundle (see {@link parseWindowsBundle}). */
export interface WindowsBundle {
  osCaption: string | null
  volumes: DiskUsage[]
  network: NetworkInterface[]
  diskBytesPerSec: number | null
  gpu: WindowsGpuUsage
  availableBytes: number | null
  cacheBytes: number | null
  poolNonpagedBytes: number | null
  committedBytes: number | null
  pageFileTotalBytes: number | null
  pageFileUsedBytes: number | null
  battery: BatteryStatus | null
  temperatureCelsius: number | null
  processes: ProcessInfo[]
}

/** Utilization rows of one bundle, without the adapter name. */
export interface WindowsGpuUtilization {
  /** Busiest engine's utilization 0-100; null when the counter class is
   * unavailable on this host (as opposed to 0, which is a measured idle GPU). */
  totalPercent: number | null
  /** Per-pid utilization 0-100: every engine instance of that process summed,
   * which is the same reading Task Manager's per-process GPU column shows. */
  byPid: ReadonlyMap<number, number>
}

/** GPU face as the Windows GPU performance counters report it. */
export interface WindowsGpuUsage extends WindowsGpuUtilization {
  /** Adapter name from `Win32_VideoController` (e.g. `AMD Radeon(TM) Vega 8
   * Graphics`); null when the class is unreadable. With several adapters the
   * first installed one is named — the engine counters aggregate every LUID,
   * so the name is informational, not a partition of the percentages. */
  name: string | null
}

/**
 * The single Windows probe script. Everything rides in one PowerShell round
 * for two reasons: interpreter startup dominates every query (~2.3 s cold on
 * a host with endpoint security), and a second concurrent interpreter would
 * itself show up in the process table it is helping to collect — the script
 * reports its own `$PID` so the parser can drop that row.
 *
 * `ConvertTo-Json` is fed `-InputObject @(…)` because piping unrolls a
 * one-element array into an object and renders an empty list as an empty
 * string; field names are pre-flattened so the parser stays shallow.
 */
const WINDOWS_BUNDLE_SCRIPT = `${PS_PREAMBLE}
$volumes = @()
foreach ($disk in Get-CimInstance Win32_LogicalDisk) {
  if ($disk.DriveType -notin 2, 3, 4 -or $null -eq $disk.Size) { continue }
  $volumes += [pscustomobject]@{ deviceId = $disk.DeviceID; fileSystem = $disk.FileSystem; sizeBytes = [int64]$disk.Size; freeBytes = [int64]$disk.FreeSpace }
}
$network = @()
foreach ($nic in Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface) {
  if ($nic.Name -match 'Loopback|isatap|Teredo|Pseudo') { continue }
  $network += [pscustomobject]@{ name = $nic.Name; rxBytes = [int64]$nic.BytesReceivedPersec; txBytes = [int64]$nic.BytesSentPersec }
}
$diskPerf = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$pageFile = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1
$batteryRaw = Get-CimInstance Win32_Battery | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$thermal = $null
$readings = @()
foreach ($zone in Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature) {
  $celsius = [double]$zone.CurrentTemperature / 10.0 - 273.15
  if ($celsius -gt -50 -and $celsius -lt 200) { $readings += $celsius }
}
if ($readings.Count -gt 0) { $thermal = ($readings | Measure-Object -Maximum).Maximum }
$diskBytesPerSec = $null
if ($diskPerf) { $diskBytesPerSec = [double]$diskPerf.DiskBytesPersec }
$availableBytes = $null
$cacheBytes = $null
$poolNonpagedBytes = $null
$committedBytes = $null
if ($memory) {
  $availableBytes = [int64]$memory.AvailableBytes
  $cacheBytes = [int64]$memory.StandbyCacheNormalPriorityBytes
  $poolNonpagedBytes = [int64]$memory.PoolNonpagedBytes
  $committedBytes = [int64]$memory.CommittedBytes
}
$pageFileTotalBytes = $null
$pageFileUsedBytes = $null
if ($pageFile) {
  $pageFileTotalBytes = [int64]$pageFile.AllocatedBaseSize * 1MB
  $pageFileUsedBytes = [int64]$pageFile.CurrentUsage * 1MB
}
$battery = $null
if ($batteryRaw) {
  $battery = [pscustomobject]@{ percent = $batteryRaw.EstimatedChargeRemaining; status = $batteryRaw.BatteryStatus; runTimeMinutes = $batteryRaw.EstimatedRunTime }
}
$osCaption = $null
if ($os) { $osCaption = $os.Caption }
$gpuAvailable = $false
$gpuEngines = @()
try {
  $gpuRows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)
  $gpuAvailable = $true
  foreach ($engine in $gpuRows) {
    if ($engine.UtilizationPercentage -gt 0) {
      $gpuEngines += [pscustomobject]@{ name = $engine.Name; utilization = [double]$engine.UtilizationPercentage }
    }
  }
} catch { $gpuAvailable = $false }
$gpuAdapterName = $null
$controller = Get-CimInstance Win32_VideoController | Select-Object -First 1
if ($controller) { $gpuAdapterName = $controller.Name }
$now = Get-Date
$processes = @()
foreach ($process in Get-Process) {
  $cpuPercent = $null
  try {
    if ($process.StartTime -and $null -ne $process.CPU) {
      $elapsedSeconds = ($now - $process.StartTime).TotalSeconds
      if ($elapsedSeconds -gt 0.5) { $cpuPercent = [double]$process.CPU / $elapsedSeconds * 100 }
    }
  } catch { $cpuPercent = $null }
  $command = $null
  try { $command = $process.Path } catch { $command = $null }
  $processes += [pscustomobject]@{ pid = [int]$process.Id; name = $process.ProcessName; cpuPercent = $cpuPercent; rssBytes = [int64]$process.WorkingSet64; command = $command }
}
$bundle = [pscustomobject]@{
  samplerPid = $PID
  osCaption = $osCaption
  volumes = $volumes
  network = $network
  diskBytesPerSec = $diskBytesPerSec
  gpuCounterAvailable = $gpuAvailable
  gpuEngines = $gpuEngines
  gpuAdapterName = $gpuAdapterName
  availableBytes = $availableBytes
  cacheBytes = $cacheBytes
  poolNonpagedBytes = $poolNonpagedBytes
  committedBytes = $committedBytes
  pageFileTotalBytes = $pageFileTotalBytes
  pageFileUsedBytes = $pageFileUsedBytes
  battery = $battery
  temperatureCelsius = $thermal
  processes = $processes
}
ConvertTo-Json -InputObject $bundle -Compress -Depth 5`

/**
 * Project the volume rows of one facts bundle. `mount` is spelled the way
 * Windows spells it (`C:\`) and `filesystem` carries the real volume name
 * (NTFS/exFAT/FAT32) instead of a type code.
 */
export function parseWindowsVolumes(rows: readonly unknown[]): DiskUsage[] {
  const volumes: DiskUsage[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === null) continue
    const deviceId = asString(row.deviceId)
    const totalBytes = asNumber(row.sizeBytes)
    const freeBytes = asNumber(row.freeBytes)
    if (deviceId === null || totalBytes === null || freeBytes === null) continue
    if (totalBytes <= 0 || freeBytes < 0) continue
    volumes.push({
      mount: `${deviceId}\\`,
      filesystem: asString(row.fileSystem) ?? 'unknown',
      totalBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freeBytes,
    })
  }
  return volumes
}

/**
 * Project the per-NIC rows of one facts bundle. Windows keeps cumulative
 * counters in the raw performance class (its `…Persec` names are the
 * performance-counter convention, not a rate), so these are the same
 * since-boot totals `netstat -ib` and /proc/net/dev give on the other two
 * platforms; duplicate adapter instances keep their `_2` suffix.
 */
export function parseWindowsNetwork(rows: readonly unknown[]): NetworkInterface[] {
  const interfaces: NetworkInterface[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === null) continue
    const name = asString(row.name)
    const rxBytes = asNumber(row.rxBytes)
    const txBytes = asNumber(row.txBytes)
    if (name === null || rxBytes === null || txBytes === null) continue
    interfaces.push({ interface: name, rxBytes, txBytes })
  }
  return interfaces
}

/** Battery status codes Win32_Battery reports as "on wall power". */
const WINDOWS_AC_STATUS = new Set([2, 6, 7, 8, 9, 11])

/** …and the subset that means the pack is actively charging. */
const WINDOWS_CHARGING_STATUS = new Set([6, 7, 8, 9, 11])

/** Win32_Battery's "no estimate" sentinel for EstimatedRunTime. */
const WINDOWS_UNKNOWN_RUNTIME = 7_158_276

/**
 * Project the battery row. `powerSource` reuses the macOS/literal strings
 * (`AC Power` / `Battery Power`) so the dashboard's existing state mapping
 * keeps working; cycle count and health are not exposed by Win32_Battery
 * (they need vendor WMI or `powercfg /batteryreport`), so they stay null.
 */
export function parseWindowsBattery(row: unknown): BatteryStatus | null {
  const record = asRecord(row)
  if (record === null) return null
  const percent = asNumber(record.percent)
  const status = asNumber(record.status)
  if (percent === null && status === null) return null
  const onAc = status !== null && WINDOWS_AC_STATUS.has(status)
  const minutes = asNumber(record.runTimeMinutes)
  return {
    percent: percent === null ? null : Math.min(100, Math.max(0, Math.round(percent))),
    charging: status === null ? null : WINDOWS_CHARGING_STATUS.has(status),
    powerSource: status === null ? null : onAc ? 'AC Power' : 'Battery Power',
    timeRemainingMinutes: minutes === null || onAc || minutes >= WINDOWS_UNKNOWN_RUNTIME
      ? null
      : Math.round(minutes),
    cycleCount: null,
    healthPercent: null,
  }
}

/**
 * Project the GPU engine rows of one bundle.
 *
 * Windows reports utilization per engine instance, in the
 * `pid_<pid>_luid_<hi>_<lo>_phys_<n>_eng_<n>_engtype_<type>` naming of the GPU
 * performance counters, so both faces come out of one vendor-agnostic source
 * (AMD/Intel/NVIDIA alike — unlike `nvidia-smi`, which only speaks to one
 * vendor):
 *
 * - the headline is the **busiest engine** reading, i.e. the largest per-engine
 *   sum across processes, clamped to 100 — the same "3D vs Copy vs Video" scale
 *   Task Manager headlines, rather than a raw sum that would saturate;
 * - per process, that process's engine instances are summed and clamped, which
 *   is the reading Task Manager's per-process GPU column shows.
 *
 * `available` distinguishes "the counter class exists and the GPU is idle (0)"
 * from "this host has no such counters (null)": an idle GPU must render as 0%,
 * not as a missing card.
 */
export function parseWindowsGpuEngines(rows: readonly unknown[], available: boolean): WindowsGpuUtilization {
  const byPid = new Map<number, number>()
  const byEngine = new Map<string, number>()
  let sawRow = false
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === null) continue
    const name = asString(row.name)
    const utilization = asNumber(row.utilization)
    if (name === null || utilization === null || utilization <= 0) continue
    const pidMatch = /pid_(\d+)/.exec(name)
    if (pidMatch === null) continue
    const pid = Number(pidMatch[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    sawRow = true
    byPid.set(pid, (byPid.get(pid) ?? 0) + utilization)
    const engine = /engtype_(.+)$/.exec(name)?.[1] ?? 'unknown'
    byEngine.set(engine, (byEngine.get(engine) ?? 0) + utilization)
  }
  for (const [pid, value] of byPid) byPid.set(pid, Math.min(100, round1(value)))
  const busiest = sawRow ? Math.max(...byEngine.values()) : 0
  return {
    totalPercent: available ? Math.min(100, round1(busiest)) : null,
    byPid,
  }
}

/** Parse one probe bundle; null when the payload is not JSON at all. */
export function parseWindowsBundle(stdout: string, totalMemoryBytes: number): WindowsBundle | null {
  const root = asRecord(parsePowershellJson(stdout))
  if (root === null) return null
  const gpu = {
    ...parseWindowsGpuEngines(asArray(root.gpuEngines), root.gpuCounterAvailable === true),
    name: asString(root.gpuAdapterName),
  }
  return {
    osCaption: asString(root.osCaption),
    volumes: parseWindowsVolumes(asArray(root.volumes)),
    network: parseWindowsNetwork(asArray(root.network)),
    diskBytesPerSec: asNumber(root.diskBytesPerSec),
    gpu,
    availableBytes: asNumber(root.availableBytes),
    cacheBytes: asNumber(root.cacheBytes),
    poolNonpagedBytes: asNumber(root.poolNonpagedBytes),
    committedBytes: asNumber(root.committedBytes),
    pageFileTotalBytes: asNumber(root.pageFileTotalBytes),
    pageFileUsedBytes: asNumber(root.pageFileUsedBytes),
    battery: parseWindowsBattery(root.battery),
    temperatureCelsius: asNumber(root.temperatureCelsius),
    processes: mergeGpuPercent(parseWindowsProcesses(stdout, totalMemoryBytes), gpu.byPid),
  }
}

/**
 * Project the Windows process table. `cpuPercent` is the process's lifetime
 * average on the single-core scale — the same ps semantics macOS and Linux
 * report, so the ranking is comparable across platforms — and processes whose
 * `StartTime`/`CPU` are unreadable (protected system processes) read as 0.
 */
export function parseWindowsProcesses(stdout: string, totalMemoryBytes: number): ProcessInfo[] {
  const root = asRecord(parsePowershellJson(stdout))
  if (root === null) return []
  // The sampling PowerShell burns seconds of CPU per round and would headline
  // every framing of the table; its own `$PID` marks the row to drop.
  const samplerPid = asNumber(root.samplerPid)
  const rows: ProcessInfo[] = []
  for (const raw of asArray(root.processes)) {
    const row = asRecord(raw)
    if (row === null) continue
    const pid = asNumber(row.pid)
    if (pid === null || !Number.isInteger(pid) || pid <= 0) continue
    if (samplerPid !== null && pid === samplerPid) continue
    const rssBytes = asNumber(row.rssBytes) ?? 0
    const cpuPercent = asNumber(row.cpuPercent) ?? 0
    rows.push({
      pid,
      cpuPercent: round1(Math.max(0, cpuPercent)),
      memPercent: totalMemoryBytes > 0 ? round1(rssBytes / totalMemoryBytes * 100) : 0,
      rssBytes,
      command: asString(row.command) ?? asString(row.name) ?? `pid ${pid}`,
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
 * Windows OS name from the node builtins: `os.version()` carries the product
 * name ("Windows 11 Pro for Workstations") and `os.release()` the build
 * ("10.0.26300"). Together they are the same "which OS is this" answer
 * `sw_vers -productVersion` and `/etc/os-release` give on the other platforms
 * — and unlike the WMI caption they are available even when PowerShell is not.
 */
function windowsOsVersion(): string | null {
  const name = version()
  const build = release()
  if (name.length === 0) return build.length > 0 ? build : null
  return build.length === 0 ? name : `${name} ${build}`
}

/** Run one PowerShell script, returning its UTF-8 stdout. */
async function runPowershell(script: string): Promise<string> {
  const bin = await resolvePowershell()
  if (bin === null) throw new Error('Windows PowerShell not found')
  const { stdout } = await run(bin, [...PS_ARGV, script], { timeout: WINDOWS_PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/** Run the Windows probe bundle (null when PowerShell is missing or the
 * payload is unusable — the caller then keeps its node-builtin numbers). */
async function readWindowsBundle(totalMemoryBytes: number): Promise<WindowsBundle | null> {
  return parseWindowsBundle(await runPowershell(WINDOWS_BUNDLE_SCRIPT), totalMemoryBytes)
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

/**
 * Local IPv4 selection over `os.networkInterfaces()` — the one address source
 * that is identical on every platform (no subprocess involved). Internal
 * (loopback) entries and IPv4 link-local addresses (169.254.x.x, a DHCP miss)
 * are excluded; remaining addresses keep os order, deduplicated.
 */
export function pickLocalAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const seen = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      if (entry.address.startsWith('169.254.') || seen.has(entry.address)) continue
      seen.add(entry.address)
    }
  }
  return [...seen]
}

/**
 * Parse an ipwho.is-compatible lookup body
 * (`{"ip":"1.2.3.4","success":true,"city":…,"region":…,"country":…,"country_code":"CN"}`).
 * Missing place fields degrade to null; a body without a usable ip (or
 * `success:false`, or non-JSON) is null overall.
 */
export function parseIpWhoIs(json: string): PublicIpGeo | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.success === false) return null
  if (typeof record.ip !== 'string' || record.ip.length === 0) return null
  const text = (key: string): string | null => {
    const field = record[key]
    return typeof field === 'string' && field.length > 0 ? field : null
  }
  return {
    ip: record.ip,
    city: text('city'),
    region: text('region'),
    country: text('country'),
    countryCode: text('country_code'),
  }
}

/** Shared public-ip lookup handle: resolves the cached geo or null; never throws. */
export type IpGeoLookup = () => Promise<PublicIpGeo | null>

export interface IpGeoOptions {
  endpoint: string
  /** How long a successful lookup stays cached. */
  refreshMs: number
  /** Injectable seams so the cache logic stays unit-testable without network. */
  fetchImpl?: typeof fetch
  now?: () => number
}

const IP_GEO_TIMEOUT_MS = 5_000

/** Retry floor after a failed lookup — a dead endpoint must not be hit once
 * per snapshot round. */
const IP_GEO_FAILURE_RETRY_MS = 60_000

/**
 * Public-IP geolocation behind a TTL cache with single-flight. Successes stay
 * cached for `refreshMs`, failures for {@link IP_GEO_FAILURE_RETRY_MS}; the
 * dashboard pump samples every few seconds, so the outbound request rate is
 * bounded by the cache, not the poll. All errors degrade to null with one
 * warn per actual attempt — the lookup must never fail a snapshot.
 */
export function createIpGeoLookup(options: IpGeoOptions): IpGeoLookup {
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  let cached: PublicIpGeo | null = null
  let cachedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<PublicIpGeo | null> | null = null
  const fresh = (): boolean => {
    const ttl = cached === null ? IP_GEO_FAILURE_RETRY_MS : options.refreshMs
    return now() - cachedAt < ttl
  }
  const attempt = async (): Promise<PublicIpGeo | null> => {
    const response = await doFetch(options.endpoint, { signal: AbortSignal.timeout(IP_GEO_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    return parseIpWhoIs(await response.text())
  }
  return async () => {
    if (fresh()) return cached
    inflight ??= attempt()
      .then(value => {
        cached = value
        cachedAt = now()
        return value
      })
      .catch((error: unknown) => {
        console.warn(`[pc-manager] ip-geo lookup failed: ${String(error)}`)
        cached = null
        cachedAt = now()
        return null
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
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

/**
 * True when this process may attribute EVERY socket to its pid — `ss -p`
 * under a normal user only names its own sockets, which would read as
 * "nobody else uses the network". Root only; injected for tests.
 */
export function canAttributeSockets(uid: number | undefined = process.getuid?.()): boolean {
  return uid === 0
}

/**
 * Parse `ss -tinp`, the privileged Linux counterpart of nettop: each socket
 * row names its owning processes (`users:(("name",pid=1,fd=3))`) and the
 * indented info line that follows carries cumulative per-socket counters.
 * Bytes are summed per pid across sockets; tx prefers `bytes_sent` and falls
 * back to `bytes_acked` (older iproute2). TCP only — the counters live on
 * tcp_info. A socket shared by several pids credits each of them.
 */
export function parseSsTinp(stdout: string): Map<number, ProcessNetCounters> {
  const rows = new Map<number, ProcessNetCounters>()
  let pendingPids: number[] | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Info continuation of the preceding socket row.
      if (pendingPids === null) continue
      const rxRaw = /bytes_received:(\d+)/.exec(line)?.[1]
      const txRaw = /bytes_sent:(\d+)/.exec(line)?.[1] ?? /bytes_acked:(\d+)/.exec(line)?.[1]
      if (rxRaw !== undefined || txRaw !== undefined) {
        for (const pid of pendingPids) {
          const row = rows.get(pid) ?? { rxBytes: 0, txBytes: 0 }
          row.rxBytes += rxRaw === undefined ? 0 : Number(rxRaw)
          row.txBytes += txRaw === undefined ? 0 : Number(txRaw)
          rows.set(pid, row)
        }
      }
      pendingPids = null
      continue
    }
    const users = /users:\(\((.*)\)\)/.exec(line)?.[1]
    if (users === undefined) {
      pendingPids = null
      continue
    }
    pendingPids = [...users.matchAll(/pid=(\d+)/g)]
      .map(match => Number(match[1]))
      .filter(pid => Number.isInteger(pid) && pid > 0)
    if (pendingPids.length === 0) pendingPids = null
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

/** One probe round of the full process table. macOS shells out for ps plus
 * nettop (network); Linux reads /proc via ps plus the privileged `ss -tinp`
 * attribution (network, root-gated) and nvidia-smi pmon (GPU SM,
 * presence-gated). Windows takes the whole table from one bundle read, whose
 * own GPU engine counters supply the per-pid GPU attribution — and it must be
 * the only interpreter spawned this round, since a second concurrent
 * PowerShell would appear as a row in the very table it helps collect (each
 * script can only drop its own `$PID`). Capabilities absent → rows carry nulls
 * and the UI hides the column. */
export async function mergeProcessTable(): Promise<ProcessInfo[]> {
  if (platform() === 'win32') {
    const bundle = await probe('windows bundle', null as WindowsBundle | null, () => readWindowsBundle(totalmem()))
    return bundle?.processes ?? []
  }
  const onLinux = platform() === 'linux'
  // Linux `comm` truncates to 15 chars; `args` gives the full command line.
  const psColumns = onLinux ? 'pid,pcpu,pmem,rss,args' : 'pid,pcpu,pmem,rss,comm'
  const [psRows, netRows, gpuRows] = await Promise.all([
    probe('ps', [] as ProcessInfo[], async () => {
      const { stdout } = await run('ps', ['-Ao', psColumns], { timeout: EXEC_TIMEOUT_MS })
      return parsePs(stdout)
    }),
    platform() === 'darwin'
      ? probe('nettop', new Map<number, ProcessNetCounters>(), async () => {
          const { stdout } = await run('nettop', ['-P', '-L', '1', '-n', '-J', 'bytes_in,bytes_out'], { timeout: EXEC_TIMEOUT_MS })
          return parseNettop(stdout)
        })
      : onLinux && canAttributeSockets()
        ? probe('ss', new Map<number, ProcessNetCounters>(), async () => {
            const { stdout } = await run('ss', ['-tinp'], { timeout: EXEC_TIMEOUT_MS })
            return parseSsTinp(stdout)
          })
        : Promise.resolve(new Map<number, ProcessNetCounters>()),
    onLinux
      ? probe('nvidia pmon', new Map<number, number>(), async () => {
          if (!await hasNvidiaSmi()) return new Map<number, number>()
          const { stdout } = await run('nvidia-smi', ['pmon', '-c', '1'], { timeout: EXEC_TIMEOUT_MS })
          return parseNvidiaSmiPmon(stdout)
        })
      : Promise.resolve(new Map<number, number>()),
  ])
  return mergeGpuPercent(mergeProcesses(psRows, netRows), gpuRows)
}

/** Full process table ranked and capped (the pc_status / HTTP fallback path). */
export async function listProcesses(sort: ProcessSort = 'cpu', limit = DEFAULT_TOP_PROCESSES): Promise<ProcessInfo[]> {
  return sortProcesses(await mergeProcessTable(), sort, limit)
}

/** Optional extras for {@link collectStatus} callers that live across frames (the pump). */
export interface CollectExtras {
  /** Receives the full merged process table of this round, before ranking. */
  onProcessTable?: (rows: readonly ProcessInfo[]) => void
  /** Shared TTL-cached public-ip lookup; omitted/null disables the geo field. */
  ipGeo?: IpGeoLookup | null
}

/**
 * Collect one system snapshot. Probes run concurrently and are dispatched by
 * platform: macOS shells out (vm_stat/sysctl/pmset/ioreg/iostat/netstat/
 * sw_vers), Linux reads /proc and /sys, Windows takes its hot fields from the
 * node builtins and the rest from one batched PowerShell facts round. Memory
 * uses the platform's own decomposition (macOS: active+wired+compressed over
 * vm_stat; Linux: MemTotal−MemAvailable over /proc/meminfo; Windows:
 * total−Available over the OS memory counters) with total−free as the
 * documented fallback, so a missing probe degrades instead of failing. The
 * Linux sampling window is padded to a full second for the /proc/diskstats
 * differential; the Windows PowerShell round spans well over a second on its
 * own clock, so its CPU differential needs no padding.
 */
export async function collectStatus(
  maxTop = DEFAULT_TOP_PROCESSES,
  sort: ProcessSort = 'cpu',
  extras?: CollectExtras,
): Promise<SystemStatus> {
  const plat = platform()
  const onLinux = plat === 'linux'
  const onWindows = plat === 'win32'
  const cpuStart = cpus()
  const startedAt = Date.now()
  // The first diskstats read precedes every probe so the differential spans
  // the whole sampling window.
  const diskstatsStart = onLinux
    ? await probe('diskstats', null as DiskstatSample | null, readDiskstats)
    : null
  // The single Windows bundle carries the process table too, so it must be the
  // only interpreter spawned this round: a second concurrent PowerShell would
  // both double the cost and show up as a row in the very table it helps
  // collect (each script can only drop its own `$PID`). `mergeProcessTable` is
  // still the one-spawn path for callers that want the table alone.
  const [windowsBundle, posixDisks, mergedProcessTable, posixNetwork, gpuPercent, iostatPerSec, pmsetBattery, ioregBattery, swap, vmstat, osVersionProbe, meminfo, linuxBattery, linuxTemp, publicIp] =
    await Promise.all([
      onWindows
        ? probe('windows bundle', null as WindowsBundle | null, () => readWindowsBundle(totalmem()))
        : Promise.resolve(null as WindowsBundle | null),
      onWindows
        ? Promise.resolve([] as DiskUsage[])
        : probe('df', [] as DiskUsage[], async () => {
            const { stdout } = await run('df', ['-k'], { timeout: EXEC_TIMEOUT_MS })
            return parseDf(stdout)
          }),
      onWindows
        ? Promise.resolve([] as ProcessInfo[])
        : mergeProcessTable(),
      onWindows
        ? Promise.resolve([] as NetworkInterface[])
        : onLinux
          ? probe('netdev', [] as NetworkInterface[], async () => parseProcNetDev(await readFile('/proc/net/dev', 'utf8')))
          : probe('netstat', [] as NetworkInterface[], async () => {
              const { stdout } = await run('netstat', ['-ib'], { timeout: EXEC_TIMEOUT_MS })
              return parseNetstatIb(stdout)
            }),
      onLinux || onWindows
        ? probe('gpu nvidia-smi', null as number | null, async () => {
            if (!await hasNvidiaSmi()) return null
            const { stdout } = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: EXEC_TIMEOUT_MS })
            return parseNvidiaSmiGpu(stdout)
          })
        : probe('gpu ioreg', null as number | null, async () => {
            const { stdout } = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeout: EXEC_TIMEOUT_MS })
            return parseIoregGpu(stdout)
          }),
      onLinux || onWindows
        ? Promise.resolve(null as number | null)
        : probe('iostat', null as number | null, async () => {
            const { stdout } = await run('iostat', ['-d', '-c', '2'], { timeout: EXEC_TIMEOUT_MS })
            return parseIostat(stdout)
          }),
      onLinux || onWindows
        ? Promise.resolve(null as PmsetBatterySample | null)
        : probe('pmset', null as PmsetBatterySample | null, async () => {
            const { stdout } = await run('pmset', ['-g', 'batt'], { timeout: EXEC_TIMEOUT_MS })
            return parsePmsetBatt(stdout)
          }),
      onLinux || onWindows
        ? Promise.resolve(null as IoregBatterySample | null)
        : probe('battery ioreg', null as IoregBatterySample | null, async () => {
            const { stdout } = await run('ioreg', ['-rn', 'AppleSmartBattery'], { timeout: EXEC_TIMEOUT_MS })
            return parseIoregBattery(stdout)
          }),
      onLinux || onWindows
        ? Promise.resolve(null as SwapUsage | null)
        : probe('swapusage', null as SwapUsage | null, async () => {
            const { stdout } = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: EXEC_TIMEOUT_MS })
            return parseSwapUsage(stdout)
          }),
      onLinux || onWindows
        ? Promise.resolve(null as VmStatUsage | null)
        : probe('vm_stat', null as VmStatUsage | null, async () => {
            const { stdout } = await run('vm_stat', [], { timeout: EXEC_TIMEOUT_MS })
            return parseVmStat(stdout)
          }),
      onWindows
        ? Promise.resolve(windowsOsVersion())
        : onLinux
          ? probe('os-release', null as string | null, async () => parseOsRelease(await readFile('/etc/os-release', 'utf8')))
          : probe('sw_vers', null as string | null, async () => {
              const { stdout } = await run('sw_vers', ['-productVersion'], { timeout: EXEC_TIMEOUT_MS })
              const value = stdout.trim()
              return value.length > 0 ? value : null
            }),
      onLinux
        ? probe('meminfo', null as MeminfoUsage | null, async () => parseMeminfo(await readFile('/proc/meminfo', 'utf8')))
        : Promise.resolve(null as MeminfoUsage | null),
      onLinux
        ? probe('power_supply', null as BatteryStatus | null, readLinuxBattery)
        : Promise.resolve(null as BatteryStatus | null),
      onLinux
        ? probe('cpu temp', null as number | null, readLinuxCpuTemp)
        : Promise.resolve(null as number | null),
      // The lookup's own TTL cache bounds the request rate; the first round
      // may pay one network round-trip (≤5s), after which it resolves cached.
      extras?.ipGeo === undefined || extras.ipGeo === null
        ? Promise.resolve(null as PublicIpGeo | null)
        : probe('ip-geo', null as PublicIpGeo | null, extras.ipGeo),
    ])
  const disks = onWindows ? windowsBundle?.volumes ?? [] : posixDisks
  const network = onWindows ? windowsBundle?.network ?? [] : posixNetwork
  // The bundle's rows already carry their per-pid GPU attribution.
  const processTable = onWindows ? windowsBundle?.processes ?? [] : mergedProcessTable
  // Windows GPU comes from the engine counters first; a machine whose counter
  // class is unavailable falls back to nvidia-smi when that binary exists.
  const gpuUsagePercent = onWindows
    ? windowsBundle?.gpu.totalPercent ?? gpuPercent
    : gpuPercent
  const osVersion = onWindows
    ? windowsBundle?.osCaption ?? osVersionProbe
    : osVersionProbe

  // The macOS iostat probe already spans ~1s on its own clock; Linux's probes
  // are instant file reads, so its window is padded for the diskstats
  // differential (and a steadier CPU average). The Windows facts round spans
  // ~2.5s of PowerShell startup, so its window is already wide enough.
  const elapsed = Date.now() - startedAt
  const minWindowMs = onLinux ? DISKSTAT_SAMPLE_MS : CPU_SAMPLE_MS
  if (elapsed < minWindowMs) await delay(minWindowMs - elapsed)
  const cpuEnd = cpus()

  let diskIoPerSec = onWindows ? windowsBundle?.diskBytesPerSec ?? null : iostatPerSec
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
  if (windowsBundle !== null) {
    // Windows memory counters: "Available" already counts the standby list as
    // reclaimable, which is exactly the MemAvailable notion Linux uses, so
    // used = total − Available. Standby cache is the cached-files counterpart
    // and the non-paged pool the closest thing to wired memory (kernel
    // allocations that can never be paged out). Windows exposes no
    // compressed-page or purgeable counter → both stay null, and the page file
    // stands in for swap.
    const available = windowsBundle.availableBytes
    usedBytes = available === null || available > total ? fallbackUsed : total - available
    wiredBytes = windowsBundle.poolNonpagedBytes
    cachedBytes = windowsBundle.cacheBytes
    appMemoryBytes = Math.max(0, usedBytes - (wiredBytes ?? 0))
    compressedBytes = null
    purgeableBytes = null
    swapTotalBytes = windowsBundle.pageFileTotalBytes
    swapUsedBytes = windowsBundle.pageFileUsedBytes
  }

  const battery: BatteryStatus | null = onWindows
    ? windowsBundle?.battery ?? null
    : onLinux
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
    platform: plat,
    hostname: hostname(),
    osVersion,
    uptimeSeconds: uptime(),
    cpu: {
      model: cpuEnd[0]?.model ?? 'unknown',
      cores: cpuEnd.length,
      usagePercent: cpuUsagePercent(cpuStart, cpuEnd),
      // Windows has no load average; `os.loadavg()` returns zeroes there, which
      // would read as a genuinely idle machine. The dashboard hides the line.
      loadavg: onWindows ? null : [loadavg()[0], loadavg()[1], loadavg()[2]],
      temperatureCelsius: onWindows ? windowsBundle?.temperatureCelsius ?? null : linuxTemp,
    },
    gpu: { usagePercent: gpuUsagePercent, name: onWindows ? windowsBundle?.gpu.name ?? null : null },
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
    localIps: pickLocalAddresses(networkInterfaces()),
    publicIp,
    topProcesses: sortProcesses(processTable, sort, maxTop),
    sampledAt: new Date().toISOString(),
  }
}
