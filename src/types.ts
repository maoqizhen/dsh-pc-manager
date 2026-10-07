/**
 * Domain contracts for the PC Manager (电脑管家) toolset: system status
 * monitoring, junk cleanup, and app uninstall. Pure data shapes only — no
 * cordis, no I/O — so the domain modules stay unit-testable in isolation.
 * @module @deepseek-ai/dsh-pc-manager
 */

/** Closed error vocabulary shared by every pc-manager tool. */
export type PcErrorCode =
  | 'not_implemented'
  | 'unsupported_platform'
  | 'invalid_argument'
  | 'not_found'
  | 'disabled_by_config'
  | 'unsafe_target'
  | 'internal_error'

/** Canonical tool-facing error value (the closed union member of every output). */
export interface PcErrorValue {
  code: PcErrorCode
  message: string
}

/** Typed domain error; tools translate it into a {@link PcErrorValue}. */
export class PcManagerError extends Error {
  constructor(
    readonly code: PcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PcManagerError'
  }
}

/** One mounted volume as reported by `df -k`. */
export interface DiskUsage {
  /** Mount point, e.g. `/` or `/Volumes/LocalData`. */
  mount: string
  filesystem: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

/** One process row merged from `ps` and per-process network counters. */
export interface ProcessInfo {
  pid: number
  /** CPU percent as reported by ps; rounded to one decimal. */
  cpuPercent: number
  /** Memory percent as reported by ps; rounded to one decimal. */
  memPercent: number
  /** Resident set size in bytes (ps rss column × 1024). */
  rssBytes: number
  /** Command path or name, truncated by ps to its own width. */
  command: string
  /** Cumulative inbound bytes since process start (`nettop`); null when unavailable. */
  netRxBytes: number | null
  /** Cumulative outbound bytes since process start (`nettop`); null when unavailable. */
  netTxBytes: number | null
  /** Per-process GPU percent; needs a privileged helper, so always null today. */
  gpuPercent: number | null
  /** Per-process disk counters; need a privileged helper, so always null today. */
  diskReadBytes: number | null
  diskWrittenBytes: number | null
}

/** Process-table sort keys the tools and the dashboard route share. */
export type ProcessSort = 'cpu' | 'mem' | 'network'

/** Battery/power supply face; null overall when the host has no battery. */
export interface BatteryStatus {
  /** Charge level 0–100; null when not observable. */
  percent: number | null
  /** True while charging/finishing charge; null when not observable. */
  charging: boolean | null
  /** Source description, e.g. `AC Power` / `Battery Power`. */
  powerSource: string | null
  /** Estimated minutes to empty/full; null when macOS reports no estimate. */
  timeRemainingMinutes: number | null
  /** Charge cycles consumed; null on desktops without a battery. */
  cycleCount: number | null
  /** Max capacity over design capacity, 0–100; null when unobservable. */
  healthPercent: number | null
}

/** One network interface's cumulative byte counters (`netstat -ib`). */
export interface NetworkInterface {
  /** BSD interface name, e.g. `en0`; loopback is excluded. */
  interface: string
  /** Cumulative inbound bytes since boot. */
  rxBytes: number
  /** Cumulative outbound bytes since boot. */
  txBytes: number
}

/** Read-only system snapshot; sampling never mutates host state. */
export interface SystemStatus {
  platform: string
  hostname: string
  /** macOS product version, e.g. `26.2`; null when `sw_vers` is unavailable. */
  osVersion: string | null
  uptimeSeconds: number
  cpu: {
    model: string
    cores: number
    /** Whole-system CPU utilization 0–100 over the sampling window; null when unmeasurable. */
    usagePercent: number | null
    /** 1/5/15-minute load averages. */
    loadavg: [number, number, number]
  }
  /** GPU face; `usagePercent` is best-effort via IOAccelerator and often null. */
  gpu: { usagePercent: number | null }
  memory: {
    totalBytes: number
    /** active + wired + compressed (documented approximation); falls back to total−free. */
    usedBytes: number
    /** Active pages ("app memory"). */
    appMemoryBytes: number
    wiredBytes: number | null
    compressedBytes: number | null
    /** Inactive + speculative pages ("cached files"). */
    cachedBytes: number | null
    purgeableBytes: number | null
    swapTotalBytes: number | null
    swapUsedBytes: number | null
  }
  /** Whole-disk throughput, reads+writes combined; split needs privileges, so only the total exists. */
  diskIo: { totalBytesPerSec: number | null }
  disks: DiskUsage[]
  battery: BatteryStatus | null
  network: NetworkInterface[]
  topProcesses: ProcessInfo[]
  sampledAt: string
}

/** Reclaimable-junk family; ids are stable and model-visible. */
export type JunkKind =
  | 'trash'
  | 'user-caches'
  | 'user-logs'
  | 'system-temp'
  | 'xcode-derived-data'
  | 'xcode-archives'
  | 'xcode-ios-device-support'
  | 'xcode-simulator-caches'
  | 'simulator-unavailable-devices'
  | 'npm-cache'
  | 'pnpm-store'
  | 'homebrew-cache'
  | 'pip-cache'
  | 'uv-cache'
  | 'yarn-cache'
  | 'go-build-cache'
  | 'go-mod-cache'
  | 'ios-backups'

/** One scan hit: a directory (or set) the cleaner can reclaim. */
export interface JunkItem {
  id: string
  kind: JunkKind
  /** Human label, e.g. `用户缓存` or a first-level child directory name. */
  label: string
  /** Absolute host path the item covers. */
  path: string
  sizeBytes: number
  fileCount: number
  /** False means cleaning is deferred pending a design review. */
  safeToClean: boolean
  rationale: string
  /** Subtree max mtime (children) or root mtime (whole), ISO; null when unmeasurable. */
  lastModifiedAt: string | null
}

/** One protected or degraded path the scanner deliberately did not turn into an item. */
export interface JunkSkipped {
  path: string
  reason: string
}

/** Dry-run enumeration result; deleting nothing is the scan's contract. */
export interface JunkScanReport {
  items: JunkItem[]
  totalBytes: number
  /** Protected children and permission-degraded subtrees, reported honestly. */
  skipped: JunkSkipped[]
  scannedAt: string
}

/** Per-item outcome after one clean run. */
export interface JunkCleanOutcome {
  id: string
  reclaimedBytes: number
  error?: string
}

export interface JunkCleanResult {
  outcomes: JunkCleanOutcome[]
  totalReclaimedBytes: number
  /** Where the bytes went; `trash` is recoverable, `delete` is not. */
  mode: 'trash' | 'delete'
  cleanedAt: string
}

/** Install sources the uninstaller knows about. */
export type AppKind = 'app-bundle' | 'homebrew' | 'system'

/** One uninstallable entry. */
export interface AppEntry {
  id: string
  name: string
  kind: AppKind
  /** App bundle path or formula/cask name. */
  path: string
  sizeBytes: number
  /** Last launch time when observable; ISO string. */
  lastUsedAt?: string
}

export interface AppInventory {
  apps: AppEntry[]
  scannedAt: string
}

export interface AppUninstallResult {
  id: string
  uninstalled: boolean
  mode: 'trash' | 'delete'
  /** Related plists/caches/app-support dirs left behind or removed. */
  leftovers: string[]
  uninstalledAt: string
}
