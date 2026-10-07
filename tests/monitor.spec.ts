/**
 * Pure-parser unit tests for the monitor/junk domains. The modules under test
 * import only node builtins, so this file runs under the harness's vitest
 * without any workspace wiring:
 *   cd deepseek-harness && node_modules/.bin/vitest run --root ../dsh-pc-manager-plugin/pc-manager
 * @module @deepseek-ai/dsh-pc-manager
 */

import { describe, expect, it } from 'vitest'
import {
  cpuUsagePercent, diffNetRates, diffProcessRates, mergeProcesses, parseDf, parseIoregBattery, parseIoregGpu, parseIostat,
  parseNetstatIb, parseNettop, parsePs, parsePmsetBatt, parseSwapUsage, parseVmStat, sortByNetworkRate, sortProcesses,
  unionProcessRows,
} from '../src/monitor.ts'
import type { ProcessRateState } from '../src/monitor.ts'
import { resolveTargets } from '../src/junk.ts'
import type { CpuInfo } from 'node:os'
import type { ProcessInfo } from '../src/types.ts'

const DF_SAMPLE = `Filesystem   1024-blocks      Used Available Capacity iused ifree %iused  Mounted on
/dev/disk3s1s1   983249944 30555144 528358424     6%  477734 2636168062     0%   /
devfs                 192       192         0   100%     669      0   100%   /dev
/dev/disk3s5     983249944 648879976 528358424    56% 6132607 2640913189     0%   /System/Volumes/Data
map auto_home           0         0         0   100%       0      0   100%   /System/Volumes/Data/home
/dev/disk5s1      487946     0    487946    96%  1234 99999    1%   /Volumes/LocalData
`

describe('parseDf', () => {
  it('keeps real volumes with byte sizes and drops devfs/map entries', () => {
    const disks = parseDf(DF_SAMPLE)
    const mounts = disks.map(disk => disk.mount)
    expect(mounts).toEqual(['/', '/System/Volumes/Data', '/Volumes/LocalData'])
    expect(mounts).not.toContain('/dev')
    expect(mounts).not.toContain('/System/Volumes/Data/home')
    expect(disks[0]).toMatchObject({ filesystem: '/dev/disk3s1s1', totalBytes: 983249944 * 1024 })
    expect(disks[2].mount).toBe('/Volumes/LocalData')
  })

  it('skips malformed and non-positive-size lines', () => {
    const disks = parseDf('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/x 0 0 0 100% 0 0 100% /\nshort line')
    expect(disks).toEqual([])
  })
})

const PS_SAMPLE = `  PID %CPU %MEM   RSS COMM
  123 42.35  7.81 25600 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui
  456   1.0  0.5  8192 loginwindow
  789   0.0  0.0     0 Google Chrome Helper.1234
  notapid x y z extra
`

describe('parsePs', () => {
  it('parses rows in input order with rss bytes and one-decimal percents', () => {
    const rows = parsePs(PS_SAMPLE)
    expect(rows).toEqual([
      {
        pid: 123, cpuPercent: 42.4, memPercent: 7.8, rssBytes: 25600 * 1024,
        command: '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
        netRxBytes: null, netTxBytes: null, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null,
      },
      { pid: 456, cpuPercent: 1, memPercent: 0.5, rssBytes: 8192 * 1024, command: 'loginwindow',
        netRxBytes: null, netTxBytes: null, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null },
      { pid: 789, cpuPercent: 0, memPercent: 0, rssBytes: 0, command: 'Google Chrome Helper.1234',
        netRxBytes: null, netTxBytes: null, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null },
    ])
  })

  it('skips rows with non-numeric pids regardless of column count', () => {
    expect(parsePs(PS_SAMPLE).map(row => row.pid)).toEqual([123, 456, 789])
  })
})

function cpu(times: Partial<CpuInfo['times']>): CpuInfo {
  return {
    model: 'Apple M4', speed: 0, times: {
      user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times,
    },
  }
}

describe('cpuUsagePercent', () => {
  it('computes busy over total across both samples', () => {
    const prev = [cpu({ user: 100, idle: 100, sys: 50, nice: 0, irq: 0 })]
    const cur = [cpu({ user: 200, idle: 100, sys: 50, nice: 0, irq: 0 })]
    // busy delta 100 of total delta 100 → 100%
    expect(cpuUsagePercent(prev, cur)).toBe(100)
  })

  it('returns null on an empty counter window', () => {
    expect(cpuUsagePercent([cpu({})], [cpu({})])).toBeNull()
  })

  it('clamps to 0..100', () => {
    const prev = [cpu({ user: 100, idle: 0 })]
    const cur = [cpu({ user: 100, idle: 50 })]
    expect(cpuUsagePercent(prev, cur)).toBe(0)
  })
})

const VMSTAT_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    31022.
Pages active:                                 346862.
Pages inactive:                               346059.
Pages speculative:                               144.
Pages throttled:                                   0.
Pages wired down:                             184658.
Pages purgeable:                               21605.
"Translation faults":                       51558658.
Pages copy-on-write:                         1469416.
Pages occupied by compressor:                 106380.
`

describe('parseVmStat', () => {
  it('scales page counts by the header page size', () => {
    const usage = parseVmStat(VMSTAT_SAMPLE)
    expect(usage).not.toBeNull()
    expect(usage?.activeBytes).toBe(346862 * 16384)
    expect(usage?.wiredBytes).toBe(184658 * 16384)
    expect(usage?.compressedBytes).toBe(106380 * 16384)
    expect(usage?.inactiveBytes).toBe(346059 * 16384)
    expect(usage?.speculativeBytes).toBe(144 * 16384)
    expect(usage?.purgeableBytes).toBe(21605 * 16384)
  })

  it('returns null without a page-size header', () => {
    expect(parseVmStat('Pages free: 100.')).toBeNull()
  })
})

describe('parseSwapUsage', () => {
  it('parses megabyte and gigabyte members', () => {
    expect(parseSwapUsage('total = 4096.00M  used = 512.00M  free = 3584.00M  (encrypted)'))
      .toEqual({ totalBytes: 4096 * 1024 ** 2, usedBytes: 512 * 1024 ** 2, freeBytes: 3584 * 1024 ** 2 })
    expect(parseSwapUsage('total = 2.00G  used = 1.50G  free = 0.00B  (encrypted)'))
      .toEqual({ totalBytes: 2 * 1024 ** 3, usedBytes: 1.5 * 1024 ** 3, freeBytes: 0 })
  })

  it('returns null on unrecognized text', () => {
    expect(parseSwapUsage('swap is off')).toBeNull()
  })
})

const PMSET_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=731140928)	92%; discharging; 3:12 remaining present: true
`

const PMSET_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=731140928)	45%; charging; 1:05 remaining present: true
`

const PMSET_DESKTOP = `Now drawing from 'AC Power'
`

describe('parsePmsetBatt', () => {
  it('parses percent, state, source and remaining time', () => {
    expect(parsePmsetBatt(PMSET_BATTERY)).toEqual({
      percent: 92, charging: false, powerSource: 'Battery Power', timeRemainingMinutes: 3 * 60 + 12,
    })
    expect(parsePmsetBatt(PMSET_CHARGING)).toEqual({
      percent: 45, charging: true, powerSource: 'AC Power', timeRemainingMinutes: 65,
    })
  })

  it('returns null on desktops without an InternalBattery row', () => {
    expect(parsePmsetBatt(PMSET_DESKTOP)).toBeNull()
  })

  it('maps a missing estimate to null minutes', () => {
    const sample = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)	10%; discharging; (no estimate) remaining present: true\n`
    expect(parsePmsetBatt(sample)?.timeRemainingMinutes).toBeNull()
  })
})

const IOREG_BATTERY = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x1000008b2, registered, matched, active, busy 0 (0 ms), retain 22>
    {
      "Cycle Count" = 213
      "DesignCapacity" = 5000
      "MaxCapacity" = 4600
      "CurrentCapacity" = 4300
`

const IOREG_DESKTOP = `+-o AppleSmartBattery  <class AppleSmartBattery, registered, matched>
    {
      "Amperage" = 0
      "CurrentCapacity" = 0
      "MaxCapacity" = 0
`

describe('parseIoregBattery', () => {
  it('derives cycle count and health from capacity ratios', () => {
    expect(parseIoregBattery(IOREG_BATTERY)).toEqual({ cycleCount: 213, healthPercent: 92 })
  })

  it('returns null on the zeroed node desktops expose', () => {
    expect(parseIoregBattery(IOREG_DESKTOP)).toBeNull()
  })
})

describe('parseIoregGpu', () => {
  it('takes the busiest GPU utilization', () => {
    const sample = `"PerformanceStatistics" = {"Device Utilization %"=17,"other"=1}
"PerformanceStatistics" = {"Device Utilization %"=52}
`
    expect(parseIoregGpu(sample)).toBe(52)
  })

  it('returns null when the key is absent', () => {
    expect(parseIoregGpu('"PerformanceStatistics" = {"alloc"=1}')).toBeNull()
  })
})

const IOSTAT_SAMPLE = `              disk0               disk6               disk7 
    KB/t  tps  MB/s     KB/t  tps  MB/s     KB/t  tps  MB/s 
   19.13   35  0.65    11.42    7  0.08     5.75    0  0.00 
    4.00    1  0.00     0.00    0  0.00     0.00    0  0.00 
`

describe('parseIostat', () => {
  it('sums the last sample MB/s columns across disks', () => {
    // Second sample: all three disks are 0.00 MB/s.
    expect(parseIostat(IOSTAT_SAMPLE)).toBe(0)
  })

  it('uses the last numeric row and converts to bytes/sec', () => {
    const sample = ` disk0 \n  KB/t tps MB/s \n 10.00  5  1.00 \n 20.00  2  2.00 \n`
    expect(parseIostat(sample)).toBe(2 * 1024 * 1024)
  })

  it('returns null without numeric sample rows', () => {
    expect(parseIostat('iostat: no disks')).toBeNull()
  })
})

const NETSTAT_SAMPLE = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         33736     0   23381230    33736     0   23381230     0
lo0        16384 127           localhost          33736     -   23381230    33736     -   23381230     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#7>    d0:11:e5:8d:80:45  2154009     0 1989732029  1211649     0  221312126     0
en0        1500  192.168.3     192.168.3.12     2154009     - 1989732029  1211649     -  221312126     -
`

describe('parseNetstatIb', () => {
  it('keeps one row per interface from <Link#> rows, dropping loopback and down links', () => {
    expect(parseNetstatIb(NETSTAT_SAMPLE)).toEqual([
      { interface: 'en0', rxBytes: 1989732029, txBytes: 221312126 },
    ])
  })

  it('returns null-safe empty on empty input', () => {
    expect(parseNetstatIb('')).toEqual([])
  })
})

const NETTOP_CSV = `,bytes_in,bytes_out,
launchd.1,0,0,
cloudflared.454,5676127,18465020,
ZCode Helper.11588,217845,1516647,
Warning: DNS lookups did not complete within timeout
`

const NETTOP_JSON = `{
  "processes": {
    "cloudflared.454": { "bytes_in": 5676127, "bytes_out": 18465020 },
    "loginwindow.123": { "bytes_in": 10, "bytes_out": 20 }
  }
}
`

describe('parseNettop', () => {
  it('parses the macOS 26+ CSV shape, skipping headers and warnings', () => {
    const rows = parseNettop(NETTOP_CSV)
    expect(rows.get(454)).toEqual({ rxBytes: 5676127, txBytes: 18465020 })
    expect(rows.get(11588)).toEqual({ rxBytes: 217845, txBytes: 1516647 })
    expect(rows.get(1)).toEqual({ rxBytes: 0, txBytes: 0 })
    expect(rows.size).toBe(3)
  })

  it('parses the legacy JSON shape', () => {
    const rows = parseNettop(NETTOP_JSON)
    expect(rows.get(454)).toEqual({ rxBytes: 5676127, txBytes: 18465020 })
    expect(rows.get(123)).toEqual({ rxBytes: 10, txBytes: 20 })
  })

  it('degrades broken JSON to an empty map', () => {
    expect(parseNettop('{ truncated').size).toBe(0)
  })
})

describe('diffNetRates', () => {
  type SystemStatus = import('../src/types.ts').SystemStatus
  const frame = (sampledAt: string, network: Array<[name: string, rx: number, tx: number]>): SystemStatus =>
    ({ sampledAt, network: network.map(([name, rx, tx]) => ({ interface: name, rxBytes: rx, txBytes: tx })) }) as unknown as SystemStatus

  it('derives per-second rates from consecutive snapshots', () => {
    const prev = frame('2026-10-05T08:00:00Z', [['en0', 1000, 2000]])
    const cur = frame('2026-10-05T08:00:02Z', [['en0', 3000, 2000]])
    expect(diffNetRates(prev, cur).get('en0')).toEqual({ rxPerSec: 1000, txPerSec: 0 })
  })

  it('returns empty for the first frame, resets, and unknown interfaces', () => {
    const cur = frame('2026-10-05T08:00:02Z', [['en0', 3000, 2000]])
    expect(diffNetRates(null, cur).size).toBe(0)
    const prev = frame('2026-10-05T08:00:00Z', [['utun4', 500, 500]])
    expect(diffNetRates(prev, cur).size).toBe(0)
  })

  it('drops interfaces whose counters went backwards (reboot) and empty windows', () => {
    const prev = frame('2026-10-05T08:00:02Z', [['en0', 9000, 9000]])
    const cur = frame('2026-10-05T08:00:00Z', [['en0', 3000, 2000]])
    expect(diffNetRates(prev, cur).size).toBe(0)
    const same = frame('2026-10-05T08:00:02Z', [['en0', 9000, 9000]])
    expect(diffNetRates(prev, same).size).toBe(0)
  })
})

describe('diffProcessRates', () => {
  type ProcessInfo = import('../src/types.ts').ProcessInfo
  const procRow = (pid: number, netRxBytes: number | null, netTxBytes: number | null): ProcessInfo => ({
    pid, cpuPercent: 0, memPercent: 0, rssBytes: 0, command: `p${pid}`,
    netRxBytes, netTxBytes, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null,
  })
  const seen = (at: number, rxBytes: number, txBytes: number): ProcessRateState => ({ at, rxBytes, txBytes })

  it('derives per-second rates over the pid-own window', () => {
    const lastSeen = new Map([[10, seen(Date.parse('2026-10-05T08:00:00Z'), 1000, 2000)]])
    const { rates } = diffProcessRates(lastSeen, [procRow(10, 3000, 2000)], '2026-10-05T08:00:02Z')
    expect(rates.get(10)).toEqual({ rxPerSec: 1000, txPerSec: 0 })
  })

  it('yields no rate for a pid with no history, and records it for next time', () => {
    const { rates, nextLastSeen } = diffProcessRates(new Map(), [procRow(20, 500, 500)], '2026-10-05T08:00:02Z')
    expect(rates.size).toBe(0)
    expect(nextLastSeen.get(20)).toBeDefined()
  })

  it('skips counter resets (restarted pid) instead of emitting a bogus rate', () => {
    const lastSeen = new Map([[30, seen(Date.parse('2026-10-05T08:00:00Z'), 9000, 9000)]])
    const { rates, nextLastSeen } = diffProcessRates(lastSeen, [procRow(30, 100, 100)], '2026-10-05T08:00:02Z')
    expect(rates.size).toBe(0)
    expect(nextLastSeen.get(30)).toEqual(seen(Date.parse('2026-10-05T08:00:02Z'), 100, 100))
  })

  it('differences a returning pid over its own longer window, not the frame gap', () => {
    // Seen two frames ago (4s), skipped last frame (off the top-N), back now.
    const lastSeen = new Map([[40, seen(Date.parse('2026-10-05T08:00:00Z'), 0, 0)]])
    const { rates } = diffProcessRates(lastSeen, [procRow(40, 400, 800)], '2026-10-05T08:00:04Z')
    expect(rates.get(40)).toEqual({ rxPerSec: 100, txPerSec: 200 })
  })

  it('drops pids that fell off the current rows from nextLastSeen', () => {
    const lastSeen = new Map([[50, seen(Date.parse('2026-10-05T08:00:00Z'), 0, 0)]])
    const { nextLastSeen } = diffProcessRates(lastSeen, [procRow(60, 1, 1)], '2026-10-05T08:00:02Z')
    expect(nextLastSeen.has(50)).toBe(false)
    expect(nextLastSeen.has(60)).toBe(true)
  })
})

describe('unionProcessRows + sortByNetworkRate', () => {
  type ProcessInfo = import('../src/types.ts').ProcessInfo
  const row = (pid: number, cpu: number, net: number | null): ProcessInfo => ({
    pid, cpuPercent: cpu, memPercent: 0, rssBytes: 0, command: `p${pid}`,
    netRxBytes: net, netTxBytes: net === null ? null : 0, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null,
  })

  it('unions cpu top-N with socket rows outside it, deduplicated', () => {
    const rows = [row(1, 50, null), row(2, 40, 100), row(3, 30, 500), row(4, 1, 900)]
    const union = unionProcessRows(rows, 2)
    const pids = union.map(r => r.pid)
    expect(pids).toEqual([1, 2, 3, 4])
    expect(new Set(pids).size).toBe(pids.length)
  })

  it('ranks by live rate; rows without a window rank as zero, never by cumulative', () => {
    const rows = [row(1, 0, 1_000_000), row(2, 0, 5_000), row(3, 0, 50_000)]
    // pid 1 has a huge lifetime total but a zero rate now; pid 2 has no window
    // yet (its 5k cumulative must NOT outrank pid 3's live 900); pid 3 streams.
    const rates = new Map([[1, { rxPerSec: 0, txPerSec: 0 }], [3, { rxPerSec: 900, txPerSec: 0 }]])
    expect(sortByNetworkRate(rows, rates, 3).map(r => r.pid)).toEqual([3, 1, 2])
    // First frame (no rates at all): everything is zero; stable order kept.
    expect(sortByNetworkRate(rows, new Map(), 3).map(r => r.pid)).toEqual([1, 2, 3])
  })
})

describe('mergeProcesses + sortProcesses', () => {  const rows: readonly ProcessInfo[] = [
    { pid: 1, cpuPercent: 10, memPercent: 1, rssBytes: 1000, command: 'a',
      netRxBytes: 500, netTxBytes: 100, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null },
    { pid: 2, cpuPercent: 30, memPercent: 5, rssBytes: 5000, command: 'b',
      netRxBytes: null, netTxBytes: null, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null },
    { pid: 3, cpuPercent: 20, memPercent: 3, rssBytes: 3000, command: 'c',
      netRxBytes: 4000, netTxBytes: 0, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null },
  ]

  it('merges nettop counters by pid', () => {
    const net = new Map([[3, { rxBytes: 4000, txBytes: 0 }]])
    const merged = mergeProcesses(rows, net)
    expect(merged.find(row => row.pid === 3)?.netRxBytes).toBe(4000)
    expect(merged.find(row => row.pid === 2)?.netRxBytes).toBeNull()
  })

  it('ranks by cpu, memory and network totals', () => {
    expect(sortProcesses(rows, 'cpu', 3).map(row => row.pid)).toEqual([2, 3, 1])
    expect(sortProcesses(rows, 'mem', 3).map(row => row.pid)).toEqual([2, 3, 1])
    expect(sortProcesses(rows, 'network', 3).map(row => row.pid)).toEqual([3, 1, 2])
  })

  it('honors the limit', () => {
    expect(sortProcesses(rows, 'cpu', 1)).toHaveLength(1)
  })
})

describe('resolveTargets', () => {
  it('expands ~ against the given home and preserves registry size', () => {
    const targets = resolveTargets(undefined, '/Users/tester')
    expect(targets).toHaveLength(19)
    expect(targets[0].dir).toBe('/Users/tester/.Trash')
    expect(targets[1].dir).toBe('/Users/tester/Library/Caches')
  })
})
