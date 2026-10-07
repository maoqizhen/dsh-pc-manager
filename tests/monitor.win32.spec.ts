/**
 * Windows-platform tests: the PowerShell bundle readers and the shared win32
 * utilities, driven by payloads captured from a real Windows 11 host (Windows
 * PowerShell 5.1 shapes — `ConvertTo-Json` quirks, `$null` fields, the
 * `…Persec` naming of the raw performance counters). The bundle probe itself
 * is exercised end to end in `e2e.win32.spec.ts`; everything here is pure and
 * therefore runs on any host.
 * @module @deepseek-ai/dsh-pc-manager
 */

import { describe, expect, it } from 'vitest'
import {
  parseWindowsBattery, parseWindowsBundle, parseWindowsGpuEngines, parseWindowsNetwork, parseWindowsProcesses,
  parseWindowsVolumes,
} from '../src/monitor.ts'
import { asArray, asNumber, asRecord, asString, parsePowershellJson, powershellCandidates } from '../src/win32.ts'

/** One real bundle payload (captured on Windows 11 24H2, PowerShell 5.1). */
const BUNDLE = `{
  "samplerPid": 15968,
  "osCaption": "Microsoft Windows 11 Pro for Workstations",
  "volumes": [
    { "deviceId": "C:", "fileSystem": "NTFS", "sizeBytes": 999044411392, "freeBytes": 804485656576 },
    { "deviceId": "Z:", "fileSystem": "NTFS", "sizeBytes": 511900434432, "freeBytes": 331776000000 }
  ],
  "network": [
    { "name": "Realtek PCIe GbE Family Controller _2", "rxBytes": 0, "txBytes": 0 },
    { "name": "Realtek PCIe GbE Family Controller", "rxBytes": 0, "txBytes": 0 },
    { "name": "Intel[R] Wireless-AC 9260 160MHz", "rxBytes": 2372036325, "txBytes": 237941857 }
  ],
  "diskBytesPerSec": 1199508.5,
  "gpuCounterAvailable": true,
  "gpuAdapterName": "AMD Radeon(TM) Vega 8 Graphics",
  "gpuEngines": [
    { "name": "pid_12504_luid_0x00000000_0x00013B33_phys_0_eng_0_engtype_3D", "utilization": 9 },
    { "name": "pid_4892_luid_0x00000000_0x00013B33_phys_0_eng_0_engtype_3D", "utilization": 3 }
  ],
  "availableBytes": 7392468992,
  "cacheBytes": 7042486272,
  "poolNonpagedBytes": 536387584,
  "committedBytes": 8705560576,
  "pageFileTotalBytes": 2818572288,
  "pageFileUsedBytes": 57671680,
  "battery": { "percent": 96, "status": 2, "runTimeMinutes": 71582788 },
  "temperatureCelsius": null,
  "processes": [
    { "pid": 4892, "name": "DeepSeek Harness", "cpuPercent": 49.969739367352254, "rssBytes": 661258240,
      "command": "C:\\\\Users\\\\maoqi\\\\AppData\\\\Local\\\\Programs\\\\DeepSeek Harness\\\\DeepSeek Harness.exe" },
    { "pid": 7920, "name": "ABCSafePop", "cpuPercent": 0.00276, "rssBytes": 13365248,
      "command": "C:\\\\Program Files (x86)\\\\中国农业银行\\\\中国农业银行网银助手\\\\ABCSafePop.exe" },
    { "pid": 4, "name": "System", "cpuPercent": null, "rssBytes": 14569472, "command": null },
    { "pid": 2824, "name": "ChsIME", "cpuPercent": 0.0033028, "rssBytes": 10899456, "command": null },
    { "pid": 15968, "name": "powershell", "cpuPercent": 134.3285, "rssBytes": 93720576,
      "command": "C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" }
  ]
}`

const TOTAL_MEMORY = 14_904_889_344

describe('win32 payload readers', () => {
  it('tolerates a BOM, surrounding whitespace, and an empty document', () => {
    expect(parsePowershellJson('\uFEFF{"a":1}\n')).toEqual({ a: 1 })
    expect(parsePowershellJson('   ')).toBeNull()
    expect(parsePowershellJson('')).toBeNull()
    expect(parsePowershellJson('Get-Counter: no data')).toBeNull()
  })

  it('normalizes PowerShell\'s single-object-for-array and null quirks', () => {
    expect(asArray([{ a: 1 }])).toHaveLength(1)
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }])
    expect(asArray(null)).toEqual([])
    expect(asArray('')).toEqual([])
    expect(asNumber(12.5)).toBe(12.5)
    expect(asNumber('12.5')).toBe(12.5)
    expect(asNumber('')).toBeNull()
    expect(asNumber(null)).toBeNull()
    expect(asNumber('abc')).toBeNull()
    expect(asNumber(Number.NaN)).toBeNull()
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeNull()
    expect(asString(null)).toBeNull()
    expect(asString(7)).toBe('7')
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toBeNull()
    expect(asRecord(null)).toBeNull()
  })

  it('derives the interpreter candidates from the environment', () => {
    const candidates = powershellCandidates({ SystemRoot: 'D:\\Windows', ProgramFiles: 'D:\\Apps' } as NodeJS.ProcessEnv)
    expect(candidates).toEqual([
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'D:\\Apps\\PowerShell\\7\\pwsh.exe',
    ])
  })
})

describe('parseWindowsVolumes', () => {
  it('maps real Win32_LogicalDisk rows to drive-rooted volumes', () => {
    const volumes = parseWindowsVolumes(JSON.parse(BUNDLE).volumes as unknown[])
    expect(volumes).toEqual([
      {
        mount: 'C:\\',
        filesystem: 'NTFS',
        totalBytes: 999044411392,
        usedBytes: 999044411392 - 804485656576,
        freeBytes: 804485656576,
      },
      {
        mount: 'Z:\\',
        filesystem: 'NTFS',
        totalBytes: 511900434432,
        usedBytes: 511900434432 - 331776000000,
        freeBytes: 331776000000,
      },
    ])
  })

  it('accepts a single unwrapped row and rejects rows without a usable size', () => {
    expect(parseWindowsVolumes([{ deviceId: 'C:', fileSystem: 'NTFS', sizeBytes: 100, freeBytes: 40 }]))
      .toEqual([{ mount: 'C:\\', filesystem: 'NTFS', totalBytes: 100, usedBytes: 60, freeBytes: 40 }])
    // A drive with no media reports a null Size — not a volume.
    expect(parseWindowsVolumes([{ deviceId: 'D:', fileSystem: null, sizeBytes: null, freeBytes: null }])).toEqual([])
    expect(parseWindowsVolumes([{ deviceId: 'E:', sizeBytes: 0, freeBytes: 0 }])).toEqual([])
    expect(parseWindowsVolumes([{ sizeBytes: 10, freeBytes: 1 }])).toEqual([])
  })

  it('falls back to an unknown filesystem name and never reports negative usage', () => {
    const [volume] = parseWindowsVolumes([{ deviceId: 'C:', sizeBytes: 100, freeBytes: 140 }])
    expect(volume?.filesystem).toBe('unknown')
    expect(volume?.usedBytes).toBe(0)
  })
})

describe('parseWindowsNetwork', () => {
  it('keeps every adapter instance, including the duplicate-instance suffix', () => {
    const interfaces = parseWindowsNetwork(JSON.parse(BUNDLE).network as unknown[])
    expect(interfaces).toEqual([
      { interface: 'Realtek PCIe GbE Family Controller _2', rxBytes: 0, txBytes: 0 },
      { interface: 'Realtek PCIe GbE Family Controller', rxBytes: 0, txBytes: 0 },
      { interface: 'Intel[R] Wireless-AC 9260 160MHz', rxBytes: 2372036325, txBytes: 237941857 },
    ])
  })

  it('skips rows missing a counter rather than reporting a fabricated zero', () => {
    expect(parseWindowsNetwork([
      { name: 'up', rxBytes: 10, txBytes: 20 },
      { name: 'partial', rxBytes: 10 },
      { rxBytes: 1, txBytes: 1 },
    ])).toEqual([{ interface: 'up', rxBytes: 10, txBytes: 20 }])
  })
})

describe('parseWindowsBattery', () => {
  it('maps the AC statuses to a non-charging AC power source', () => {
    // BatteryStatus 2 = "on AC, not necessarily charging".
    expect(parseWindowsBattery({ percent: 96, status: 2, runTimeMinutes: 71582788 })).toEqual({
      percent: 96,
      charging: false,
      powerSource: 'AC Power',
      timeRemainingMinutes: null,
      cycleCount: null,
      healthPercent: null,
    })
  })

  it('maps the charging statuses, the discharging status, and the runtime estimate', () => {
    expect(parseWindowsBattery({ percent: 40, status: 6, runTimeMinutes: 90 })).toMatchObject({
      charging: true, powerSource: 'AC Power', timeRemainingMinutes: null,
    })
    expect(parseWindowsBattery({ percent: 80, status: 1, runTimeMinutes: 142 })).toEqual({
      percent: 80,
      charging: false,
      powerSource: 'Battery Power',
      timeRemainingMinutes: 142,
      cycleCount: null,
      healthPercent: null,
    })
    // 71582788 is the class's "no estimate" sentinel, not four years of runtime.
    expect(parseWindowsBattery({ percent: 80, status: 1, runTimeMinutes: 71582788 })?.timeRemainingMinutes).toBeNull()
  })

  it('clamps the charge level and returns null when the row carries nothing', () => {
    expect(parseWindowsBattery({ percent: 140, status: 1 })?.percent).toBe(100)
    expect(parseWindowsBattery({ percent: -5, status: 1 })?.percent).toBe(0)
    expect(parseWindowsBattery({ percent: 50 })?.charging).toBeNull()
    expect(parseWindowsBattery(null)).toBeNull()
    expect(parseWindowsBattery({})).toBeNull()
  })
})

describe('parseWindowsProcesses', () => {
  it('maps the real rows, scales memory by the total, and drops the sampling interpreter', () => {
    const rows = parseWindowsProcesses(BUNDLE, TOTAL_MEMORY)
    expect(rows.map(row => row.pid)).toEqual([4892, 7920, 4, 2824])
    const [harness, bank, system, ime] = rows
    expect(harness).toMatchObject({
      pid: 4892,
      cpuPercent: 50,
      rssBytes: 661258240,
      command: 'C:\\Users\\maoqi\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
      netRxBytes: null,
      netTxBytes: null,
      gpuPercent: null,
      diskReadBytes: null,
      diskWrittenBytes: null,
    })
    // Single-core scale, one decimal, like ps on the other two platforms.
    expect(bank?.cpuPercent).toBe(0)
    expect(harness?.memPercent).toBe(4.4)
    // Protected processes expose neither CPU nor a path: 0 and the image name.
    expect(system?.cpuPercent).toBe(0)
    expect(system?.command).toBe('System')
    expect(ime?.command).toBe('ChsIME')
  })

  it('never emits a negative or fractional-overflow rate, and skips junk rows', () => {
    const payload = JSON.stringify({
      samplerPid: 1,
      processes: [
        { pid: 10, name: 'neg', cpuPercent: -40, rssBytes: 0 },
        { pid: 0, name: 'zero', cpuPercent: 1 },
        { pid: 11.5, name: 'fractional', cpuPercent: 1 },
        { pid: 12, name: 'tenth', cpuPercent: 12.3456, rssBytes: 10, command: 'x' },
        null,
        'garbage',
      ],
    })
    const rows = parseWindowsProcesses(payload, 0)
    expect(rows.map(row => row.pid)).toEqual([10, 12])
    expect(rows[0]?.cpuPercent).toBe(0)
    expect(rows[1]?.cpuPercent).toBe(12.3)
    // A zero memory total must not divide by zero.
    expect(rows[1]?.memPercent).toBe(0)
  })

  it('returns nothing for a payload that is not JSON', () => {
    expect(parseWindowsProcesses('', 1000)).toEqual([])
    expect(parseWindowsProcesses('not json', 1000)).toEqual([])
  })
})

describe('parseWindowsGpuEngines', () => {
  /** Real instance names from an AMD Vega 8 iGPU (Windows 11, PowerShell 5.1). */
  const ENGINE = (pid: number, engine: number, type: string, percent: number) =>
    ({ name: `pid_${pid}_luid_0x00000000_0x00013B33_phys_0_eng_${engine}_engtype_${type}`, utilization: percent })

  it('attributes each engine instance to its pid and headlines the busiest engine', () => {
    const gpu = parseWindowsGpuEngines([
      ENGINE(12504, 0, '3D', 9),
      ENGINE(3512, 6, 'Copy', 4),
      ENGINE(1832, 2, 'Compute 0', 2),
    ], true)
    // The headline is the busiest engine (9), not the raw sum (15).
    expect(gpu.totalPercent).toBe(9)
    expect([...gpu.byPid.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1832, 2], [3512, 4], [12504, 9]])
  })

  it('sums one process across its engines and clamps at 100', () => {
    const gpu = parseWindowsGpuEngines([
      ENGINE(400, 0, '3D', 60.5),
      ENGINE(400, 1, 'Compute 0', 30.25),
      ENGINE(400, 6, 'Copy', 40),
    ], true)
    expect(gpu.byPid.get(400)).toBe(100)
    // Each engine group keeps its own sum, so the headline stays the busiest one.
    expect(gpu.totalPercent).toBe(60.5)
  })

  it('distinguishes an idle measured GPU from a host without the counters', () => {
    expect(parseWindowsGpuEngines([], true)).toEqual({ totalPercent: 0, byPid: new Map() })
    expect(parseWindowsGpuEngines([], false).totalPercent).toBeNull()
    // Zero-utilization rows are filtered by the probe; a zero row here is a no-op.
    expect(parseWindowsGpuEngines([ENGINE(1, 0, '3D', 0)], true).totalPercent).toBe(0)
  })

  it('skips rows that carry no usable pid or value', () => {
    const gpu = parseWindowsGpuEngines([
      { name: 'pid_4_luid_0x0_0x1_phys_0_eng_0_engtype_3D', utilization: 3 },
      { name: 'garbage', utilization: 50 },
      { name: 'pid_notanumber_luid_x_engtype_3D', utilization: 7 },
      { name: 'pid_0_luid_0x0_0x1_phys_0_eng_0_engtype_3D', utilization: 7 },
      { name: 'pid_99_luid_0x0_0x1_phys_0_eng_0_engtype_3D', utilization: null },
      null,
      'nonsense',
    ], true)
    // pid 4 (the System process) is a legitimate GPU client.
    expect([...gpu.byPid.keys()]).toEqual([4])
    expect(gpu.totalPercent).toBe(3)
  })
})

describe('parseWindowsBundle', () => {
  it('projects every section of a real bundle', () => {
    const bundle = parseWindowsBundle(BUNDLE, TOTAL_MEMORY)
    expect(bundle).not.toBeNull()
    expect(bundle?.osCaption).toBe('Microsoft Windows 11 Pro for Workstations')
    expect(bundle?.volumes).toHaveLength(2)
    expect(bundle?.network).toHaveLength(3)
    expect(bundle?.diskBytesPerSec).toBe(1199508.5)
    // Two processes share the 3D engine (9 + 3), so that engine reads 12% while
    // each process keeps its own 9 / 3 attribution.
    expect(bundle?.gpu.totalPercent).toBe(12)
    expect(bundle?.gpu.name).toBe('AMD Radeon(TM) Vega 8 Graphics')
    expect(bundle?.gpu.byPid.get(12504)).toBe(9)
    expect(bundle?.gpu.byPid.get(4892)).toBe(3)
    expect(bundle?.availableBytes).toBe(7392468992)
    expect(bundle?.cacheBytes).toBe(7042486272)
    expect(bundle?.poolNonpagedBytes).toBe(536387584)
    expect(bundle?.committedBytes).toBe(8705560576)
    expect(bundle?.pageFileTotalBytes).toBe(2818572288)
    expect(bundle?.pageFileUsedBytes).toBe(57671680)
    expect(bundle?.battery?.powerSource).toBe('AC Power')
    expect(bundle?.temperatureCelsius).toBeNull()
    expect(bundle?.processes).toHaveLength(4)
    // The bundle's rows carry the per-pid GPU attribution from the same read:
    // pid 4892 is a real row of the fixture, pid 12504 is not, so only the
    // former may gain a value.
    expect(bundle?.processes.find(row => row.pid === 4892)?.gpuPercent).toBe(3)
    expect(bundle?.processes.every(row => row.gpuPercent === null || row.pid === 4892)).toBe(true)
  })

  it('degrades each missing section to null/[] instead of voiding the bundle', () => {
    const bundle = parseWindowsBundle('{"samplerPid":5}', TOTAL_MEMORY)
    expect(bundle).toEqual({
      osCaption: null,
      volumes: [],
      network: [],
      diskBytesPerSec: null,
      gpu: { name: null, totalPercent: null, byPid: new Map() },
      availableBytes: null,
      cacheBytes: null,
      poolNonpagedBytes: null,
      committedBytes: null,
      pageFileTotalBytes: null,
      pageFileUsedBytes: null,
      battery: null,
      temperatureCelsius: null,
      processes: [],
    })
  })

  it('accepts a BOM-prefixed payload and rejects a non-JSON one', () => {
    expect(parseWindowsBundle(`\uFEFF${BUNDLE}`, TOTAL_MEMORY)?.volumes).toHaveLength(2)
    expect(parseWindowsBundle('Access denied', TOTAL_MEMORY)).toBeNull()
  })
})
