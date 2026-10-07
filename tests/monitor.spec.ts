/**
 * Pure-parser unit tests for the monitor/junk domains. The modules under test
 * import only node builtins, so this file runs under the harness's vitest
 * without any workspace wiring:
 *   cd deepseek-harness && node_modules/.bin/vitest run --root ../dsh-pc-manager-plugin/pc-manager
 * @module @deepseek-ai/dsh-pc-manager
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canAttributeSockets, cpuUsagePercent, createIpGeoLookup, diffNetRates, diffProcessRates,
  diskstatRate, isCpuTempSource, mergeGpuPercent, mergeProcesses, parseBatteryUevent, parseDf,
  parseDiskstats, parseIoregBattery, parseIoregGpu, parseIostat, parseIpWhoIs, parseMeminfo,
  parseNetstatIb, parseNettop, parseNvidiaSmiGpu, parseNvidiaSmiPmon, parseOsRelease, parseProcNetDev,
  parsePs, parsePmsetBatt, parseSsTinp, parseSwapUsage, parseVmStat, pickCpuTempCelsius,
  pickLocalAddresses, sortByNetworkRate, sortProcesses, unionProcessRows,
} from '../src/monitor.ts'
import type { ProcessRateState } from '../src/monitor.ts'
import { JUNK_TARGETS, JUNK_TARGETS_DARWIN, JUNK_TARGETS_LINUX, JUNK_TARGETS_WIN32, resolveTargets } from '../src/junk.ts'
import type { JunkTarget } from '../src/junk.ts'
import { platform } from 'node:os'
import type { CpuInfo } from 'node:os'
import type { ProcessInfo } from '../src/types.ts'

/** Minimal registry row for the resolution cases. */
function targetRow(kind: string, dir: string): JunkTarget {
  return { kind: kind as JunkTarget['kind'], label: kind, dir, safeToClean: true, rationale: kind, granularity: 'whole' }
}

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
  it('expands ~ against the given home and preserves registry size, per platform', () => {
    const darwin = resolveTargets(JUNK_TARGETS_DARWIN, '/Users/tester')
    expect(darwin).toHaveLength(19)
    expect(darwin[0].dir).toBe('/Users/tester/.Trash')
    expect(darwin[1].dir).toBe('/Users/tester/Library/Caches')
    const linux = resolveTargets(JUNK_TARGETS_LINUX, '/home/tester')
    expect(linux).toHaveLength(12)
    expect(linux[0].dir).toBe('/home/tester/.local/share/Trash')
    expect(linux[1].dir).toBe('/home/tester/.cache')
    expect(linux[2].dir).toBe('/tmp')
    expect(linux[3].dir).toBe('/var/tmp')
  })

  it('expands %VAR% roots against the injected environment (Windows)', () => {
    const env = {
      SystemDrive: 'D:',
      TEMP: 'D:\\Temp',
      SystemRoot: 'D:\\Windows',
      LOCALAPPDATA: 'D:\\Users\\t\\AppData\\Local',
      USERPROFILE: 'D:\\Users\\t',
    }
    const win = resolveTargets(JUNK_TARGETS_WIN32, 'D:\\Users\\t', env)
    expect(win).toHaveLength(18)
    expect(win[0].dir).toBe('D:\\$Recycle.Bin')
    expect(win[1].dir).toBe('D:\\Temp')
    expect(win[2].dir).toBe('D:\\Windows\\Temp')
    expect(win.filter(row => row.kind === 'go-mod-cache')[0]?.dir).toBe('D:\\Users\\t\\go\\pkg\\mod\\cache')
    // An unknown placeholder stays verbatim: the root simply does not exist,
    // which yields no items rather than a wrong path.
    const [unknown] = resolveTargets([targetRow('npm-cache', '%NOT_SET_ANYWHERE%\\cache')], 'D:\\Users\\t', env)
    expect(unknown?.dir).toBe('%NOT_SET_ANYWHERE%\\cache')
  })

  it('dispatches JUNK_TARGETS by the runtime platform', () => {
    const expected = platform() === 'linux' ? JUNK_TARGETS_LINUX
      : platform() === 'win32' ? JUNK_TARGETS_WIN32
        : JUNK_TARGETS_DARWIN
    expect(JUNK_TARGETS).toBe(expected)
  })
})

const LINUX_DF_SAMPLE = `Filesystem     1K-blocks     Used Available Use% Mounted on
udev             8179100        0   8179100   0% /dev
tmpfs            1638076      576   1637500   1% /run
/dev/vda1       41111748 22561324  16842000  58% /
tmpfs            8190380        0   8190380   0% /dev/shm
tmpfs               5120        0      5120   0% /run/lock
/dev/vda15        126678    11840    114838  10% /boot/efi
tmpfs            1638076        0   1638076   0% /run/user/0
overlay          41111748 22561324  16842000  58% /var/lib/docker/overlay2/abc/merged
squashfs         1638076        0   1638076   0% /snap/core22/1380
/dev/vdb1       41111748 22561324  16842000  58% /data
`

describe('parseDf (Linux)', () => {
  it('drops pseudo filesystems and kernel mount points, keeping real volumes', () => {
    const disks = parseDf(LINUX_DF_SAMPLE)
    expect(disks.map(disk => disk.mount)).toEqual(['/', '/boot/efi', '/data'])
    expect(disks[0]).toMatchObject({ filesystem: '/dev/vda1', totalBytes: 41111748 * 1024, usedBytes: 22561324 * 1024 })
  })

  it('keeps an overlay root (a container only has its overlay as the real disk)', () => {
    const disks = parseDf('Filesystem 1K-blocks Used Available Use% Mounted on\noverlay 1000 100 900 10% /')
    expect(disks.map(disk => disk.mount)).toEqual(['/'])
  })
})

const MEMINFO_SAMPLE = `MemTotal:       16380760 kB
MemFree:         1985520 kB
MemAvailable:   12501468 kB
Buffers:          583908 kB
Cached:          9104364 kB
SwapCached:            0 kB
Active:          5722156 kB
Inactive:        7195180 kB
AnonPages:       3175784 kB
Shmem:              2320 kB
Slab:            1322960 kB
SReclaimable:    1167480 kB
SUnreclaim:       155480 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`

describe('parseMeminfo', () => {
  it('scales kB lines and derives used from MemAvailable', () => {
    const usage = parseMeminfo(MEMINFO_SAMPLE)
    expect(usage).not.toBeNull()
    expect(usage?.totalBytes).toBe(16380760 * 1024)
    expect(usage?.usedBytes).toBe((16380760 - 12501468) * 1024)
    expect(usage?.cachedBytes).toBe((583908 + 9104364 + 1167480) * 1024)
    expect(usage?.anonPagesBytes).toBe(3175784 * 1024)
    expect(usage?.sUnreclaimBytes).toBe(155480 * 1024)
    expect(usage?.swapTotalBytes).toBe(0)
  })

  it('falls back to total−free−buffers−cached without MemAvailable', () => {
    const usage = parseMeminfo('MemTotal: 1000 kB\nMemFree: 300 kB\nBuffers: 100 kB\nCached: 200 kB\n')
    expect(usage?.usedBytes).toBe(400 * 1024)
  })

  it('returns null without the MemTotal/MemFree anchors', () => {
    expect(parseMeminfo('Slab: 1 kB')).toBeNull()
  })
})

describe('parseOsRelease', () => {
  it('prefers PRETTY_NAME and strips quotes', () => {
    expect(parseOsRelease('NAME="Debian GNU/Linux"\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n'))
      .toBe('Debian GNU/Linux 12 (bookworm)')
  })

  it('falls back to NAME + VERSION_ID, and null without a name', () => {
    expect(parseOsRelease('NAME="Alpine Linux"\nVERSION_ID=3.20\n')).toBe('Alpine Linux 3.20')
    expect(parseOsRelease('VERSION_ID=1\n')).toBeNull()
    expect(parseOsRelease('')).toBeNull()
  })
})

const NETDEV_SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1494865852  911349    0    0    0     0          0         0 1494865852  911349    0    0    0     0       0          0
  eth0: 42086214556 60039480    0    1    0     0          0         0 12114914053 39678794    0    0    0     0       0          0
  eth1:   80392    1762    0    0    0     0          0         0   324826    4950    0    0    0     0       0          0
`

describe('parseProcNetDev', () => {
  it('parses per-interface counters, dropping loopback', () => {
    expect(parseProcNetDev(NETDEV_SAMPLE)).toEqual([
      { interface: 'eth0', rxBytes: 42086214556, txBytes: 12114914053 },
      { interface: 'eth1', rxBytes: 80392, txBytes: 324826 },
    ])
  })

  it('returns empty on header-only or malformed input', () => {
    expect(parseProcNetDev('Inter-|   Receive |  Transmit\n face |bytes |bytes\n')).toEqual([])
    expect(parseProcNetDev('')).toEqual([])
  })
})

const DISKSTATS_SAMPLE = `   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0
 254       0 vda 388342 9118 14648241 468864 38073381 28779780 682659067 12461280 0 1818244 13230268
 254       1 vda1 385498 9118 14522849 468059 38073338 28779772 682658962 12461272 0 1968696 12929331
   8        0 sda 100 0 200 10 100 0 400 20 0 30 60
 259       0 nvme0n1 5 0 10 1 5 0 10 1 0 2 3
`

describe('parseDiskstats + diskstatRate', () => {
  it('sums read+write sectors over physical whole disks only', () => {
    const sample = parseDiskstats(DISKSTATS_SAMPLE, 1_000)
    // vda 14648241+682659067, sda 200+400, nvme0n1 10+10; vda1 (partition) and loop0 excluded.
    expect(sample).toEqual({ at: 1_000, sectors: 14648241 + 682659067 + 200 + 400 + 10 + 10 })
  })

  it('yields bytes/sec over the sample window and guards resets', () => {
    expect(diskstatRate({ at: 0, sectors: 100 }, { at: 1_000, sectors: 300 })).toBe(200 * 512)
    expect(diskstatRate({ at: 1_000, sectors: 100 }, { at: 1_000, sectors: 300 })).toBeNull()
    expect(diskstatRate({ at: 0, sectors: 300 }, { at: 1_000, sectors: 100 })).toBeNull()
  })
})

describe('parseNvidiaSmiGpu', () => {
  it('takes the busiest numeric line', () => {
    expect(parseNvidiaSmiGpu('17\n52\n')).toBe(52)
    expect(parseNvidiaSmiGpu(' 0 ')).toBe(0)
  })

  it('returns null on unsupported or empty output', () => {
    expect(parseNvidiaSmiGpu('[Not Supported]\n')).toBeNull()
    expect(parseNvidiaSmiGpu('')).toBeNull()
  })
})

const UEVENT_SAMPLE = `POWER_SUPPLY_NAME=BAT0
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_CAPACITY=92
POWER_SUPPLY_CYCLE_COUNT=213
POWER_SUPPLY_ENERGY_FULL=4600000
POWER_SUPPLY_ENERGY_FULL_DESIGN=5000000
POWER_SUPPLY_TIME_TO_EMPTY_NOW=192
`

describe('parseBatteryUevent', () => {
  it('derives the full battery face from uevent fields', () => {
    expect(parseBatteryUevent(UEVENT_SAMPLE, null)).toEqual({
      percent: 92,
      charging: false,
      powerSource: 'Battery Power',
      timeRemainingMinutes: 192,
      cycleCount: 213,
      healthPercent: 92,
    })
  })

  it('pins the power source from the adapter online file when available', () => {
    expect(parseBatteryUevent(UEVENT_SAMPLE, true)?.powerSource).toBe('AC Power')
    expect(parseBatteryUevent(UEVENT_SAMPLE, false)?.powerSource).toBe('Battery Power')
  })

  it('nulls out on non-battery or absent nodes', () => {
    expect(parseBatteryUevent('POWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_ONLINE=1\n', null)).toBeNull()
    expect(parseBatteryUevent('POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_PRESENT=0\n', null)).toBeNull()
  })

  it('derives percent from charge ratios when CAPACITY is absent', () => {
    const sample = UEVENT_SAMPLE.replace('POWER_SUPPLY_CAPACITY=92\n', '')
      .replace('POWER_SUPPLY_ENERGY_FULL=', 'POWER_SUPPLY_ENERGY_NOW=4370000\nPOWER_SUPPLY_ENERGY_FULL=')
    expect(parseBatteryUevent(sample, null)?.percent).toBe(95)
  })
})

const SS_SAMPLE = `State      Recv-Q Send-Q         Local Address:Port             Peer Address:Port Process
ESTAB      0      0                  127.0.0.1:58516               127.0.0.1:3080  users:(("nginx",pid=3478787,fd=10))
	 cubic wscale:7,7 rto:204 bytes_sent:1403 bytes_acked:1404 bytes_received:5162993 segs_out:659
CLOSE-WAIT 25     0                  10.7.62.234:44866         103.102.166.240:443   users:(("uwsgi",pid=2764522,fd=53))
	 cubic wscale:9,7 rto:248 bytes_acked:1153 bytes_received:42434 segs_out:23
ESTAB      0      0              10.7.62.234:53862            127.0.0.1:3080  users:(("nginx",pid=3478787,fd=12))
	 cubic wscale:7,7 rto:204 bytes_sent:900 bytes_acked:901 bytes_received:1000 segs_out:9
ESTAB      0      0              10.7.62.234:53863            127.0.0.1:3080  users:(("node",pid=100,fd=3),("node",pid=101,fd=3))
	 cubic wscale:7,7 rto:204 bytes_acked:7 bytes_received:3 segs_out:2
LISTEN     0      128                      *:22                             *:*   users:(("sshd",pid=9,fd=3))
`

describe('parseSsTinp (privileged per-process network attribution)', () => {
  it('sums per-socket counters onto each owning pid across two-line records', () => {
    const rows = parseSsTinp(SS_SAMPLE)
    // nginx pid 3478787 owns two sockets: (1403 sent, 5162993 recv) + (900 sent, 1000 recv).
    expect(rows.get(3478787)).toEqual({ rxBytes: 5163993, txBytes: 2303 })
    // uwsgi row carries no bytes_sent (older counters): tx falls back to bytes_acked.
    expect(rows.get(2764522)).toEqual({ rxBytes: 42434, txBytes: 1153 })
  })

  it('credits a socket shared by several pids to each of them', () => {
    expect(parseSsTinp(SS_SAMPLE).get(100)).toEqual({ rxBytes: 3, txBytes: 7 })
    expect(parseSsTinp(SS_SAMPLE).get(101)).toEqual({ rxBytes: 3, txBytes: 7 })
  })

  it('skips sockets without byte counters (LISTEN) and without owners', () => {
    const rows = parseSsTinp(SS_SAMPLE)
    expect(rows.has(9)).toBe(false)
    expect(parseSsTinp('ESTAB 0 0 a:b c:d\n\t cubic rto:204 bytes_received:5\n').size).toBe(0)
  })

  it('gates the probe on root: only uid 0 attributes every socket', () => {
    expect(canAttributeSockets(0)).toBe(true)
    expect(canAttributeSockets(1000)).toBe(false)
    // Platforms without getuid (win32) default the uid to undefined, and
    // undefined === 0 is false — the probe stays off there.
  })
})

const PMON_SAMPLE = `# gpu        pid  type    sm   mem   enc   dec   command
# Idx          #   C/G     %     %     %     %   name
    0       1234     C    45     2     0     0   python3
    0       1234     G    60     2     0     0   python3
    1       1234     C    12     1     0     0   python3
    0       -1      M     -     0     0     0   -
    0       5678     C     -     5     0     0   firefox
`

describe('parseNvidiaSmiPmon (per-process GPU SM)', () => {
  it('takes the busiest GPU per pid and skips placeholder rows', () => {
    const rows = parseNvidiaSmiPmon(PMON_SAMPLE)
    expect(rows.get(1234)).toBe(60)
    // pid 5678 has no readable sm this sample; pid -1 is not a real pid.
    expect(rows.has(5678)).toBe(false)
    expect(rows.size).toBe(1)
  })

  it('returns empty on comment-only or empty output', () => {
    expect(parseNvidiaSmiPmon('# gpu pid type sm mem enc dec command').size).toBe(0)
    expect(parseNvidiaSmiPmon('').size).toBe(0)
  })
})

describe('mergeGpuPercent', () => {
  type ProcessInfo = import('../src/types.ts').ProcessInfo
  const row = (pid: number): ProcessInfo => ({
    pid, cpuPercent: 0, memPercent: 0, rssBytes: 0, command: `p${pid}`,
    netRxBytes: null, netTxBytes: null, gpuPercent: null, diskReadBytes: null, diskWrittenBytes: null,
  })

  it('attaches SM percent by pid and leaves unmatched rows null', () => {
    const merged = mergeGpuPercent([row(1), row(2)], new Map([[2, 42]]))
    expect(merged[0]?.gpuPercent).toBeNull()
    expect(merged[1]?.gpuPercent).toBe(42)
  })

  it('returns copies untouched when no gpu rows exist', () => {
    const rows = [row(1)]
    expect(mergeGpuPercent(rows, new Map())).toEqual(rows)
  })
})

describe('pickCpuTempCelsius', () => {
  it('accepts the CPU-named chip families and rejects others', () => {
    for (const name of ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz', 'x86_pkg_temp', 'soc_dts0']) {
      expect(isCpuTempSource(name)).toBe(true)
    }
    for (const name of ['nvme', 'amdgpu', 'battery', 'iwlwifi', '']) {
      expect(isCpuTempSource(name)).toBe(false)
    }
  })

  it('headlines the max reading across CPU chips, ignoring other chips', () => {
    const chips = [
      { name: 'nvme', celsius: [70] },            // disk, ignored
      { name: 'coretemp', celsius: [41.5, 43.2] }, // per-core inputs: max wins
      { name: 'k10temp', celsius: [39.9] },
    ]
    expect(pickCpuTempCelsius(chips)).toBe(43.2)
  })

  it('reads null with no candidate chip, and tolerates garbage readings', () => {
    expect(pickCpuTempCelsius([{ name: 'nvme', celsius: [50] }])).toBeNull()
    expect(pickCpuTempCelsius([{ name: 'coretemp', celsius: [Number.NaN] }])).toBeNull()
    expect(pickCpuTempCelsius([])).toBeNull()
  })
})

describe('pickLocalAddresses', () => {
  it('keeps non-internal IPv4 in os order, dropping loopback, link-local, IPv6, and duplicates', () => {
    const addresses = pickLocalAddresses({
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: null }],
      en0: [
        { address: '192.168.3.12', netmask: '255.255.255.0', family: 'IPv4', mac: 'd0:11:e5:8d:80:45', internal: false, cidr: null },
        { address: 'fe80::1%en0', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'd0:11:e5:8d:80:45', internal: false, scopeid: 1, cidr: null },
      ],
      bridge100: [{ address: '169.254.5.9', netmask: '255.255.0.0', family: 'IPv4', mac: '9a:11:e5:8d:80:45', internal: false, cidr: null }],
      en1: [{ address: '192.168.3.12', netmask: '255.255.255.0', family: 'IPv4', mac: 'd0:11:e5:8d:80:46', internal: false, cidr: null }],
    })
    expect(addresses).toEqual(['192.168.3.12'])
  })

  it('collects one address per qualifying interface (windows-style mixed stack)', () => {
    const addresses = pickLocalAddresses({
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      eth0: [{ address: '10.0.0.5', netmask: '255.255.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:01', internal: false, cidr: null }],
      wlan0: [
        { address: 'fe80::2%wlan0', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:02', internal: false, scopeid: 3, cidr: null },
        { address: '172.17.8.4', netmask: '255.255.248.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:02', internal: false, cidr: null },
      ],
    })
    expect(addresses).toEqual(['10.0.0.5', '172.17.8.4'])
  })

  it('returns empty when nothing qualifies', () => {
    expect(pickLocalAddresses({})).toEqual([])
    expect(pickLocalAddresses({
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      utun3: [{ address: 'fe80::4%utun3', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, scopeid: 9, cidr: null }],
    })).toEqual([])
  })
})

describe('parseIpWhoIs', () => {
  it('maps a full payload onto the geo shape', () => {
    const body = '{"ip":"203.0.113.7","success":true,"country":"China","country_code":"CN","region":"Guangdong","city":"Shenzhen"}'
    expect(parseIpWhoIs(body)).toEqual({
      ip: '203.0.113.7', city: 'Shenzhen', region: 'Guangdong', country: 'China', countryCode: 'CN',
    })
  })

  it('degrades missing place fields to null', () => {
    expect(parseIpWhoIs('{"ip":"198.51.100.2"}')).toEqual({
      ip: '198.51.100.2', city: null, region: null, country: null, countryCode: null,
    })
    expect(parseIpWhoIs('{"ip":"198.51.100.2","city":"","country_code":8}')).toEqual({
      ip: '198.51.100.2', city: null, region: null, country: null, countryCode: null,
    })
  })

  it('rejects success:false and bodies without a usable ip', () => {
    expect(parseIpWhoIs('{"ip":"203.0.113.7","success":false}')).toBeNull()
    expect(parseIpWhoIs('{"success":true}')).toBeNull()
    expect(parseIpWhoIs('{"ip":""}')).toBeNull()
    expect(parseIpWhoIs('{"ip":42}')).toBeNull()
  })

  it('returns null on non-JSON garbage and empty input', () => {
    expect(parseIpWhoIs('<html>blocked</html>')).toBeNull()
    expect(parseIpWhoIs('')).toBeNull()
    expect(parseIpWhoIs('null')).toBeNull()
  })
})

describe('createIpGeoLookup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const OK_BODY = '{"ip":"203.0.113.7","country":"China","country_code":"CN"}'
  const asFetch = (impl: () => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>): typeof fetch =>
    impl as unknown as typeof fetch

  it('serves from cache within the TTL and refetches once it lapses', async () => {
    let clock = 0
    const calls: string[] = []
    const lookup = createIpGeoLookup({
      endpoint: 'https://example.test/geo',
      refreshMs: 1_000,
      now: () => clock,
      fetchImpl: asFetch(async () => {
        calls.push('fetch')
        return { ok: true, status: 200, text: async () => OK_BODY }
      }),
    })
    await expect(lookup()).resolves.toMatchObject({ ip: '203.0.113.7' })
    clock = 500
    await lookup()
    expect(calls).toHaveLength(1)
    clock = 1_500
    await expect(lookup()).resolves.toMatchObject({ ip: '203.0.113.7' })
    expect(calls).toHaveLength(2)
  })

  it('negative-caches failures so a dead endpoint is not retried every round', async () => {
    let clock = 0
    let attempts = 0
    const lookup = createIpGeoLookup({
      endpoint: 'https://dead.test/',
      refreshMs: 60_000,
      now: () => clock,
      fetchImpl: asFetch(async () => {
        attempts += 1
        throw new Error('network down')
      }),
    })
    await expect(lookup()).resolves.toBeNull()
    await expect(lookup()).resolves.toBeNull()
    expect(attempts).toBe(1)
    clock = 61_000
    await expect(lookup()).resolves.toBeNull()
    expect(attempts).toBe(2)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('resolves null on HTTP errors and unparseable bodies without throwing', async () => {
    const httpError = createIpGeoLookup({
      endpoint: 'https://example.test/geo', refreshMs: 60_000, now: () => 0,
      fetchImpl: asFetch(async () => ({ ok: false, status: 503, text: async () => '' })),
    })
    await expect(httpError()).resolves.toBeNull()
    const garbage = createIpGeoLookup({
      endpoint: 'https://example.test/geo', refreshMs: 60_000, now: () => 0,
      fetchImpl: asFetch(async () => ({ ok: true, status: 200, text: async () => 'not json' })),
    })
    await expect(garbage()).resolves.toBeNull()
  })
})
