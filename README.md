# dsh-pc-manager — PC Manager

[English](README.md) · [简体中文](README.zh-CN.md)

> DeepSeek Harness plugin for system monitoring & junk cleanup · 系统监控、垃圾清理与应用卸载的 DeepSeek Harness 插件

A PC Manager plugin for DeepSeek Harness (dsh), shipped in the official bundle format. It provides:
system status monitoring (model tools + a right-sidebar dashboard), system junk cleanup (a
zero-LLM direct-execution window), and app uninstall (M3) — 5 model-visible tools in total.

**Platform support**: monitoring (`pc_status` + dashboard) and junk cleanup
(`pc_junk_scan`/`pc_junk_clean` + the cleanup window) work on **macOS, Linux and Windows**; other
platforms return `unsupported_platform`. On Windows, metrics come from node builtins plus a single
batched PowerShell probe (see [Windows data sources](#windows-data-sources)), the junk registry is
`JUNK_TARGETS_WIN32`, and recycling goes to the real Recycle Bin.

It is positioned as a **security-first** agent system tool: scans are always dry-run; the two
destructive tools default to `disabled_by_config` and only act after the host explicitly opts in;
trash/uninstall defaults to the Trash (recoverable); if any link of the id validation chain fails,
the whole call is rejected with **zero deletion**.

## Table of contents

- [Quick start](#quick-start)
  - [Install (one line)](#install-one-line)
  - [Enable junk cleanup (optional)](#enable-junk-cleanup-optional)
  - [Manual mounting (fallback, mutually exclusive with bundle install)](#manual-mounting-fallback-mutually-exclusive-with-bundle-install)
- [Features](#features)
  - [Model tools](#model-tools)
  - [Dashboard (right sidebar)](#dashboard-right-sidebar)
  - [Junk cleanup (zero-LLM direct-execution window)](#junk-cleanup-zero-llm-direct-execution-window)
- [Security design](#security-design)
- [Appendix](#appendix)
  - [Monitoring metrics and data sources](#monitoring-metrics-and-data-sources)
  - [Windows data sources](#windows-data-sources)
  - [Capability-gated probes](#capability-gated-probes)
  - [Junk target registry (per-platform dispatch)](#junk-target-registry-per-platform-dispatch)
  - [Reverse proxy / prefix-mounted deployment](#reverse-proxy--prefix-mounted-deployment)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Milestones](#milestones)
- [License](#license)

## Quick start

### Install (one line)

This repository is an official **bundle plugin** (`dsh.bundle` + `dsh.client` in the root
`package.json`); the build artifacts in `lib/` are committed, so a git install requires no build
step:

```sh
dsh plugin --profile web add "github:maoqizhen/dsh-pc-manager#main"
```

After installing, **restart `dsh web`** (the bundle layer is synthesized at startup). To update:
`dsh plugin --profile web update dsh-pc-manager`; to uninstall:
`dsh plugin --profile web remove dsh-pc-manager` — both require a restart to take effect.

> **pnpm required**: `dsh plugin` is a pnpm forwarder and fails outright if pnpm is not on the PATH
> (install with `npm i -g pnpm`; the pnpm major version must match the profile's existing store).
> If dsh runs under a non-login shell on a server, make sure `node`/`pnpm` are visible on that
> process's PATH (e.g. in `/usr/local/bin`).

### Enable junk cleanup (optional)

Out of the box the install is safe-by-default: read-only tools work immediately, while the two
destructive tools (`pc_junk_clean` / `pc_app_uninstall`) refuse to execute
(`disabled_by_config`). To enable junk cleanup, write to a **back-layer patch** (the profile's
`cordis.patch.yml` or `~/.dsh/cordis.patch.yml`; the back layer replaces the whole config line,
so all keys must be restated):

```yaml
- insert:
    - id: pc-manager
      name: dsh-pc-manager
      config:
        enableJunkClean: true     # the per-call host approval gate still applies
        moveToTrash: true         # default to Trash (recoverable)
```

### Manual mounting (fallback, mutually exclusive with bundle install)

No `dsh plugin add` needed, but a **dual entry** is mandatory (the package-name entry lets the
client half be discovered by the `clientModules` scan; the file-path entry lets the host half's
`apply` run; the official bundle install has no such issue):

```bash
# 1. Let the profile resolve the package by name (the client half is discovered
#    via require.resolve('<pkg>/package.json'))
ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-pc-manager

# 2. Append the dual entry to ~/.dsh/cordis.patch.yml (host: absolute path; client: package name)
# - insert:
#     - id: pc-manager
#       name: /abs/path/to/dsh-pc-manager/lib/index.js
#     - id: pc-manager-client
#       name: dsh-pc-manager

# 3. Restart dsh web
```

## Features

### Model tools

| Tool | Purpose | Status |
| --- | --- | --- |
| `pc_status` | Read-only system snapshot: CPU/GPU utilization, load, temperature (capability-gated), memory breakdown (incl. swap), disk I/O and per-volume usage, battery/power, network counters, multi-key sortable process table (macOS + Linux + Windows; Windows has no load average, and the per-process network and disk columns are unobtainable — see [Windows data sources](#windows-data-sources)) | ✅ Shipped |
| `pc_junk_scan` | Enumerates reclaimable junk (macOS: Trash, user caches/logs, system temp, Xcode artifacts, simulator leftovers, package-manager caches, iOS backups; Linux: XDG Trash, ~/.cache, /tmp and /var/tmp, package-manager caches; Windows: the per-account Recycle Bin, %TEMP% and %SystemRoot%\Temp, WER reports and crash dumps, WinINet/D3D/NVIDIA shader/RDP caches, package-manager caches) with per-item size / safety flag / protected-exclusion records; params `kinds` / `minItemBytes`; always dry-run | ✅ Shipped |
| `pc_junk_clean` | Trashes items by the exact ids returned by scan; if any link of the structural validation chain (format/root containment/realpath/blocked/safeToClean) fails, the whole call is rejected with zero deletion; the `trash` kind is emptied in place, everything else defaults to the three-tier trash (macOS: `/usr/bin/trash` → rename into `~/.Trash` → cross-volume cp+rm; Linux: `trash-put`/`gio trash` → freedesktop `~/.local/share/Trash/{files,info}` with `.trashinfo` restore records → cross-volume cp+rm; Windows: the `Microsoft.VisualBasic` recycle API into the **real Recycle Bin** → fallback `%LOCALAPPDATA%\pc-manager\trash` → cross-volume cp+rm); refuses to delete when sizes can't be verified; tier-1 results are re-verified (success reported but source still present counts as failure and degrades); requires explicit config opt-in | ✅ Shipped |
| `pc_apps_list` | Installed-app inventory (app bundles + Homebrew; Linux distro packages and Windows registered programs await M3), with size / last-used | Stub, M3 |
| `pc_app_uninstall` | Uninstalls by exact id; defaults to Trash, residual items are reported rather than silently deleted | Stub, M3 |

### Dashboard (right sidebar)

The "System Monitor" entry (order 30) in the web profile's right sidebar opens a narrow-column
card dashboard: header (host/OS + a muted second line "local … · public IP · city" (geo shows city
only; the segment collapses when lookup is off or misses) / uptime) → CPU (bar + load +
temperature row* + sparkline) → GPU (whole card hidden when unavailable) → memory (swap +
breakdown) → disk (usage bars for valid volumes + I/O rate) → battery (hidden when absent) →
network (main-interface rate + sparkline) → process table (switchable by CPU/memory/network,
top 10 by default; hovering the CPU column header explains its scale). Hand-written SVG, no
chart library.

- **Capability-gated rows/columns**: the CPU card's temperature row (Linux with a sensor /
  Windows with an ACPI thermal zone), the load line (Windows has no load average — the whole line
  hides instead of showing a fabricated 0), the GPU card and the process table's "GPU" column
  (Windows uses the vendor-agnostic engine counters, so AMD/Intel/NVIDIA all show; Linux needs
  NVIDIA hardware + `nvidia-smi`), the process table's "network" column (always present on macOS
  via nettop; Linux only with root-attributed `ss -tinp`; Windows needs ETW and stays hidden) —
  missing capability means hidden, no wall of "—", see
  [Capability-gated probes](#capability-gated-probes). On Windows the disk card lists every
  volume by drive letter (`C:\`, `Z:\`, …); on POSIX it is still `/` plus data volumes under
  `/Volumes`, `/media`, `/mnt`. Process CPU% is **per-core** (multi-core processes can exceed
  100%) and a **process-lifetime average** (macOS/Linux from ps; Windows computed from
  `Get-Process`'s cumulative CPU seconds over process uptime); the column header tooltip
  explains this.
- Data flows through the host half's **single collection pump + SSE push**:
  `GET /pc-manager/stream` (text/event-stream) is the shared foundation — one host-side timer
  (interval `dashboardPollMs`, adjustable, min 500) collects on a single path and diffs
  server-side (network rates available from the first frame); the dashboard, floating window and
  every other consumer share one connection and one frame stream; **with no consumers, the
  connection and collection stop automatically** (reference-counted; hidden tab / closed
  floating window releases it). `GET /pc-manager/status` (`?processSort=&processLimit=`) remains
  as a cache fallback: requests with the pump's sort order (default CPU) read the fresh cache
  directly, other sort orders collect on demand. The LLM tool `pc_status` does not go through
  the pump; its contract is unchanged.
- Headless profiles (no webServer) skip route registration automatically; tools are unaffected.
  On platforms with a source, the GPU card is titled with the **adapter name** (Windows reads it
  from the display adapter, e.g. `AMD Radeon(TM) Vega 8 Graphics`; the narrow column truncates
  with an ellipsis, full name in the tooltip); platforms without a name source keep the generic
  `GPU`.

### Junk cleanup (zero-LLM direct-execution window)

A dedicated **"Junk Cleanup" window** in the right sidebar (guide entry peer-level with System
Monitor, order 31), **zero LLM end to end**: click "Scan" → host `GET /pc-manager/junk/scan`
(read-only; the server filters out small items below a 1 MiB threshold) → presented **by
category** (the checkbox unit is the category, not single items; an inline size preview with the
top 2–3 item names answers "which apps does this affect"; each category's "details (N)" folds out
into a scrollable list for surgical add/remove; recommended categories are pre-checked —
non-regenerable Xcode archives/iOS backups and `safeToClean:false` pnpm store/simulator leftovers
are unchecked by default with a stated reason) → "Clean selected" → an **in-place two-step
confirmation bar** (N items · size → Trash (recoverable) / permanent delete) →
`POST /pc-manager/junk/clean` executes directly → an **in-place result briefing**. The host side
shares the same config gate and id validation chain as the tool path (all-or-nothing rejection,
zero deletion) and emits an audit log line; the confirmation bar cannot be skipped and stands in
for the tool path's approval panel. **The floating window's "Scan" button invokes this window and
starts scanning automatically** (`openTab` + navigation revision; re-invoking re-scans); the five
tools and all security defenses are unchanged.

**Note**: the conversational approval panel only appears when the session Access mode's approval
policy is ask; under the danger-full-access deployment default (`approval: never`), in-session
ask is silently auto-rejected — switch Access mode in the session or adjust the deployment
preset. The UI direct-execution window is not subject to this.

## Security design

- **Read-only tools work out of the box**; the two destructive tools default to
  `disabled_by_config` and only act after the host flips the switches in a back-layer patch.
- Trash/uninstall defaults to the **Trash** (recoverable — on Windows that is the system
  "Recycle Bin"; the two terms are synonyms in this document); permanent deletion requires
  `moveToTrash: false`. The trash landing has three tiers: on macOS `/usr/bin/trash` (invoked by
  absolute path, guarding against PATH hijacking) → ownership-checked rename into `~/.Trash`
  (name conflicts get ` 2`/` 3` suffixes) → cross-volume EXDEV cp+rm; on Linux
  `trash-put`/`gio trash` (probed absolute paths) → freedesktop
  `~/.local/share/Trash/{files,info}` rename + **`.trashinfo` restore records** (name conflicts
  suffix both sides in sync) → cross-volume cp+rm; on Windows the
  `Microsoft.VisualBasic.FileIO.FileSystem` `SendToRecycleBin` (the same shell recycle as
  Explorer, landing in the **real Recycle Bin** with the original location recorded, restorable
  from Explorer; paths are **embedded into the script as PowerShell literals** rather than
  appended to argv — `-Command` re-joins arguments with spaces, so a path containing one silently
  splits, and a multi-statement script never sees `$args` at all) → fallback to
  `%LOCALAPPDATA%\pc-manager\trash` (a private holding area inside the profile, still recoverable,
  just not in the Recycle Bin UI) → cross-volume cp+rm. After tier-1 reports success, the source
  is **checked to have actually disappeared**, otherwise the tier counts as failed and the next
  one runs — a silent no-op (the shell API blocked by policy, arguments never bound) must never be
  reported as "reclaimed N bytes" (the Windows e2e caught exactly one such fake success). The
  `trash` kind itself is emptied in place (macOS empties `~/.Trash`, Linux empties the contents of
  `files/`+`info/`, Windows empties this account's `%SystemDrive%\$Recycle.Bin\<SID>` — exactly
  what "Empty Recycle Bin" means for that volume). Moving the Trash back into the Trash would be a
  pointless matryoshka.
- **Three-layer confirmation for junk cleanup**: model conversation confirmation (the tool
  description instructs preferring `ask_user_question`) + the framework's `tools/pre-execute`
  approval gate (`askBeforeJunkClean` defaults to true, asked every time, fail-closed when no
  answerer) + the id structural validation chain (strict child paths for `children` kinds /
  exact root for `whole` kinds, dual-sided realpath against symlink redirection, blocked list,
  safeToClean; any failure **rejects the whole call with zero deletion**).
- The **safe target registry** is the core asset: macOS 18 kinds / 19 rows, Linux 11 kinds / 12
  rows (XDG), Windows 11 kinds / 18 rows (`%VAR%` roots), including a sensitive-cache protection
  list (the "caches" of password managers/IDEs/input methods/VPNs/sync drives/AI apps are actually
  non-regenerable state; hits are recorded as `skipped` and produce no item) and EDR/active-service
  prefix protection (deleting enterprise security agent caches triggers tamper alarms; Linux
  additionally protects `systemd-private-*` and `snap-private-tmp`; Windows protects AV/EDR
  directories and installer scaffolding); `safeToClean:false` entries are reported but never
  cleaned, with suggested commands in the rationale (`xcrun simctl delete unavailable` /
  `pnpm store prune`).
- **Path validation uses each literal's own path flavor**: Windows paths are case-insensitive and
  rooted at drive letters, POSIX paths are case-sensitive; the validation chain (root containment
  / equality / blocked) normalizes and compares according to each path's own style, so the same
  code validates both `C:\Users\t\AppData\Local\Temp\x` and `/home/t/.cache/x`.
- Domain modules (`src/monitor.ts`, `junk.ts`, `apps.ts`, `win32.ts`) do not depend on cordis;
  pure logic, independently unit-testable.

## Appendix

### Monitoring metrics and data sources

All probes dispatch per platform and degrade to null/empty + `console.warn` on failure — a
probe failure never takes down the snapshot. Linux base metrics are all read from `/proc` and
`/sys`, zero dependencies and zero privilege escalation; **capability-detection enhancements**
(per-process network attribution, temperature, per-process GPU) follow "enable only when the
capability is detected; missing capability means silent null, no warn spam" — see the table and
[Capability-gated probes](#capability-gated-probes).

| Group | Metric | macOS source | Linux source | Parser |
| --- | --- | --- | --- | --- |
| CPU | Utilization % | `os.cpus()` two samples, 250ms delta | same (sampling window ≥1s, see disk I/O) | `cpuUsagePercent` |
| CPU | Model/cores/load 1/5/15 | `node:os` | `node:os` | — |
| CPU | Package temperature °C | null (`powermetrics` needs sudo, not run on the user's behalf) | `/sys/class/hwmon` (name + `temp*_input` millidegrees) falling back to `/sys/class/thermal` (type + temp); max across CPU-family chips; cloud hosts often lack sensors → null | `pickCpuTempCelsius` / `isCpuTempSource` |
| GPU | Utilization % (best effort) | `Device Utilization %` from `ioreg -r -d 1 -c IOAccelerator`, max across GPUs | `nvidia-smi --query-gpu=utilization.gpu` (presence probed once and cached; null without NVIDIA hardware, whole card hidden in the UI) | `parseIoregGpu` / `parseNvidiaSmiGpu` |
| Memory | macOS: used = active+wired+compressed (fallback total−free); Linux: used = MemTotal−MemAvailable (fallback total−free−buffers−cached) | `vm_stat` (page size parsed from the header) | `/proc/meminfo` (app≈AnonPages, wired≈SUnreclaim, cached=Buffers+Cached+SReclaimable) | `parseVmStat` / `parseMeminfo` |
| Memory | Swap total/used | `sysctl -n vm.swapusage` | SwapTotal/SwapFree from `/proc/meminfo` | `parseSwapUsage` / `parseMeminfo` |
| Disk | Per-volume usage | `df -k` | `df -k` (parser tolerates both column layouts; filters pseudo-filesystems like tmpfs/udev/overlay/squashfs and /dev /proc /sys /run /snap mount points) | `parseDf` |
| Disk | I/O throughput (read+write combined) | `iostat -d -c 2`, last sample summed | `/proc/diskstats` two-sample delta (whole physical disks sd/nvme/vd/hd/mmcblk, excluding partitions and loop/dm; sampling window stretched to 1s) | `parseIostat` / `parseDiskstats` + `diskstatRate` |
| Battery | Charge/charging/time remaining/cycle count/health | `pmset -g batt` + `ioreg -rn AppleSmartBattery` | `/sys/class/power_supply/BAT*/uevent` (AC from `A*/online`; card hidden when no battery) | `parsePmsetBatt` / `parseIoregBattery` / `parseBatteryUevent` |
| Network | Per-interface cumulative rx/tx (rates derived from call-to-call deltas) | `netstat -ib` (excludes lo*, dedupes `<Link#>` rows) | `/proc/net/dev` (excludes lo) | `parseNetstatIb` / `parseProcNetDev` |
| Network | Local IPv4 | `node:os` `networkInterfaces()` (non-internal, excluding `169.254.*` link-local; **identical across all three platforms, works on win32 too**) | same | `pickLocalAddresses` |
| Network | Public IP and geo (optional) | ipwho.is HTTPS lookup (`enableIpGeoLookup` on by default; successes cached for `ipGeoRefreshMinutes` (default 30min, min 5), failures negatively cached 60s; the endpoint can be swapped for a compatible mirror via `ipGeoEndpoint`) | same | `parseIpWhoIs` / `createIpGeoLookup` |
| Process network | **Dashboard/SSE frames: live rates**; **the `pc_status` tool: cumulative values** — both scales stand on their own | `nettop` cumulative + pump delta | **as root** `ss -tinp` socket attribution (TCP only: sum of bytes_received/bytes_sent over currently open sockets; without root the whole column is null and hidden) + pump delta | `parseNettop` / `parseSsTinp` / `diffProcessRates` |
| Process GPU | SM utilization % | null (no source) | `nvidia-smi pmon -c 1` attributed by pid (max across GPUs; column hidden without the binary or without occupying processes) | `parseNvidiaSmiPmon` / `mergeGpuPercent` |
| System | OS version | `sw_vers -productVersion` | `/etc/os-release` PRETTY_NAME (e.g. `Debian GNU/Linux 12 (bookworm)`) | `parseSwVers` / `parseOsRelease` |
| Processes | CPU%/memory%(+rss)/network cumulative/GPU%; disk column reserved, always null | `ps -Ao pid,pcpu,pmem,rss,comm` + `nettop` (CSV/JSON both supported) | `ps -Ao pid,pcpu,pmem,rss,args` (Linux comm truncates at 15 chars, hence args) + `ss -tinp` (root) + `pmon` | `parsePs` / `parseNettop` / `parseSsTinp` / `mergeProcesses` / `mergeGpuPercent` / `sortProcesses` |

### Windows data sources

Windows has neither `/proc` nor `df`/`ps`, so the strategy is **node builtins carry the hot
fields + one batched PowerShell probe for everything else**: a single
`powershell.exe -NoProfile -NonInteractive -NoLogo -Command` process fetches everything in one
round (volumes, memory split, per-NIC counters, disk throughput, GPU, battery, ACPI thermal
zones, the process table). One interpreter per round, because **startup dominates** (~2.3 s cold
start on a host with endpoint security; each extra WMI query adds only 30–700 ms) — and a second
concurrent interpreter would show up as a row in the very process table it is collecting: the
script reports its own `$PID` and the parser drops that row.

| Group | Metric | Windows source | Parser |
| --- | --- | --- | --- |
| CPU | Utilization/model/cores | `node:os` (`os.cpus()` delta) | `cpuUsagePercent` |
| CPU | Load 1/5/15 | **null** (Windows has no load average; `os.loadavg()` always returns 0, which is "no such number", not "idle" — the dashboard hides the line) | — |
| CPU | Package temperature °C | `root\WMI` `MSAcpi_ThermalZoneTemperature` (0.1 K → °C, max across repeated readings; usually needs elevation and desktops often lack the class → null, capability-gated) | `parseWindowsBundle` |
| GPU | Utilization % + adapter name | `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` — **vendor-agnostic** engine counters (AMD/Intel/NVIDIA alike, unlike `nvidia-smi` which serves one vendor); the whole-card scale takes the **busiest engine** (its per-process sum, clamped to 100, the Task Manager scale). The adapter name comes separately from `Win32_VideoController.Name` (e.g. `AMD Radeon(TM) Vega 8 Graphics`, the dashboard card title). When the counter class is missing, falls back to `nvidia-smi --query-gpu` (presence probed once and cached) | `parseWindowsGpuEngines` |
| GPU | Per-process utilization % | The same engine counters attributed by `pid_<pid>_…_engtype_<type>` (that process's engine instances summed, clamped to 100 = the Task Manager "Processes" column); falls back to `nvidia-smi pmon` when the class is missing | `parseWindowsGpuEngines` / `mergeGpuPercent` |
| Memory | total/used | node builtins `os.totalmem()`/`os.freemem()` (the latter is `GlobalMemoryStatusEx`'s "available", including standby — equivalent to MemAvailable) | — |
| Memory | app/wired/cached/swap breakdown | `Win32_PerfFormattedData_PerfOS_Memory` (`AvailableBytes`/`StandbyCacheNormalPriorityBytes`/`PoolNonpagedBytes`/`CommittedBytes`) + `Win32_PageFileUsage` (the page file as swap); no counters exist for compressed/purgeable → null | `parseWindowsBundle` |
| Disk | Per-volume usage | `Win32_LogicalDisk` (DriveType 2/3/4, `Size`/`FreeSpace`/`FileSystem`; `mount` is the drive root `C:\`) | `parseWindowsVolumes` |
| Disk | I/O throughput | `Win32_PerfFormattedData_PerfDisk_PhysicalDisk`'s `_Total` `DiskBytesPersec` (no waiting — cheaper than `Get-Counter`, which would cost an extra 1 s sample) | `parseWindowsBundle` |
| Network | Per-interface cumulative rx/tx | `Win32_PerfRawData_Tcpip_NetworkInterface` (the `…Persec` suffix is a perf-counter naming convention; the values are cumulative since boot; excludes Loopback/isatap/Teredo/Pseudo; duplicate instances keep their `_2` suffix) | `parseWindowsNetwork` |
| Battery | Charge/charging/power source/time remaining | `Win32_Battery` (`BatteryStatus` 2/6/7/8/9/11 = on AC, 6–9/11 = charging; `powerSource` reuses the macOS `AC Power`/`Battery Power` literals; the `EstimatedRunTime` sentinel 71582788 → null); cycle count/health need vendor WMI or `powercfg /batteryreport` → null | `parseWindowsBattery` |
| System | OS version | `os.version()` + `os.release()` (e.g. `Windows 11 Pro for Workstations 10.0.26300`; obtainable even without PowerShell), overridden by `Win32_OperatingSystem`'s Caption when the probe is available | `windowsOsVersion` |
| Processes | CPU%/memory%/command | `Get-Process`: `cpuPercent = cumulative CPU seconds / (now − StartTime) × 100` (**per-core scale, process-lifetime average**, matching ps semantics so rankings compare across platforms; protected processes whose `StartTime`/`CPU` are unreadable → 0), `memPercent = WorkingSet64 / totalmem`, command from `Path` (falls back to the process name when unreadable) | `parseWindowsProcesses` |
| Processes | Network column | **null, the whole column stays hidden** — the only metric Windows cannot supply: per-process byte attribution needs an ETW kernel network session (Task Manager shows that column only because it runs with an admin token by default); there is no zero-privilege source. Global rates are still given per interface by the "Network" card | — |

**Round cost and dashboard cadence**: one Windows collection = 1 PowerShell process (~2.5–4.5 s
depending on the machine's security software) + node builtins (~10 ms) + optional `nvidia-smi`;
the pump skips overlapping rounds, so even with `dashboardPollMs` set to 500, the actual refresh
cadence on Windows is one round's duration (a platform fact — the host does not silently rewrite
the config). When the probe is absent (no PowerShell) the snapshot still works: CPU, memory
totals, uptime and OS version all come from node builtins; only sizes, the process table,
battery and similar details are empty.

### Capability-gated probes

Enhancements that "enable only when the capability is detected" (no retry probing on failure, no
warn spam; missing capability means the whole column/row is null and the UI hides it
accordingly):

| Probe | Gate | Semantics and boundaries |
| --- | --- | --- |
| Per-process network attribution `ss -tinp` | `process.getuid() === 0` | Only under root does `ss -p` attribute **all** sockets; without root only one's own processes are visible, so the whole column is withheld instead. TCP only, summed over current sockets (a closed socket's counters zero out; the delta window drops that pid's rate automatically, so no negative or fake rates) |
| Temperature hwmon/thermal_zone | No privilege needed; read when a sensor is present | CPU-family chip names (coretemp/k10temp/zenpower/cpu_*/acpitz/x86_pkg_temp/soc_*) take the max reading; nvme/amdgpu etc. are not counted; cloud hosts without sensors → null (CPU card temperature row hidden) |
| Per-process GPU `nvidia-smi pmon` | Binary present (probed once in `/usr/bin`, `/usr/local/bin`, cached) | SM utilization attributed by pid; `-` placeholder rows skipped; max across GPUs. Hosts without NVIDIA hardware never spawn it again after the first probe |
| Windows full probe (PowerShell bundle) | `powershell.exe` present (`%SystemRoot%\System32\WindowsPowerShell\v1.0`, probed once and cached; `pwsh` 7 as fallback) | Absent → degrade to the node-builtin "minimal snapshot" (CPU, memory totals, uptime, OS version remain), sizes/process table/battery/network empty; each field inside the bundle degrades on its own (missing WMI class or privilege required → null) |
| Windows GPU engine counters | `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` class present (probed once with `-ErrorAction Stop`; present on Windows 10 1709+ with a display adapter) | Vendor-agnostic whole-card + **per-process** GPU utilization (two scales from one dataset), plus the `Win32_VideoController` adapter name for the card title. Missing class → GPU card and GPU column hidden, falling back to `nvidia-smi` (if present). **0% means "measured idle", null means "no such capability"** — an idle iGPU still gets a card |
| Windows package temperature | `root\WMI` `MSAcpi_ThermalZoneTemperature` returns readings | Common on laptops and usually needs elevation; desktops/restricted environments lack the class → null, CPU card temperature row hidden |
| Windows per-process network | No source (needs an ETW kernel session / privileged helper) | The network column is hidden entirely rather than faked with 0; global rates still live in the "Network" card |
| Windows `nvidia-smi` (fallback) | Present in `System32`, `NVIDIA Corporation\NVSMI` or PATH, probed once and cached | Spawned only when the engine counters are unavailable; the same parsers as Linux (whole-card `--query-gpu` + per-process `pmon`) |

### Junk target registry (per-platform dispatch)

The registry structure is shared across platforms (`JunkTarget`); entries dispatch per platform
(`JUNK_TARGETS_BY_PLATFORM`): `JUNK_TARGETS_DARWIN` (18 kinds / 19 rows), `JUNK_TARGETS_LINUX`
(11 kinds / 12 rows, XDG layout) and `JUNK_TARGETS_WIN32` (11 kinds / 18 rows, `%VAR%` roots);
the `JUNK_KINDS` closed vocabulary is identical across all three platforms (schema stays stable);
platform-only kinds have no entries on the other sides (user-logs on Linux; the Xcode/simulator
family and ios-backups on Linux/Windows; homebrew-cache on Windows).

**The path-flavor layer**: the registry carries both POSIX and Windows literals, while the test
suite pins all three tables on any host — so every path transformation picks
`path.posix`/`path.win32` **by the literal's own flavor** (`pathFlavor`/`normalizePath`/`joinPath`/
`isAbsolutePath`/`basenamePath`), never by the host default — otherwise running the tests on
Windows would rewrite POSIX fixtures into `\Users\t\.Trash`. Normalization strips trailing
separators (except on roots): `user-caches:/x/.cache/` is the root itself and must not pass as
"a child of the root" (otherwise a trailing slash could wipe a whole registry root).

| Linux kind | Directories | Granularity | minAge | safe |
| --- | --- | --- | --- | --- |
| `trash` | `~/.local/share/Trash` | whole | — | ✅ |
| `user-caches` | `~/.cache` (incl. thumbnails) | children (protected by `LINUX_PROTECTED_CHILDREN`) | — | ✅ |
| `system-temp` ×2 | `/tmp`, `/var/tmp` | children (`systemd-private-*`, `snap-private-tmp`, Linux EDR prefixes protected) | 3 days | ✅ |
| `npm-cache` / `pnpm-store` / `homebrew-cache` | `~/.npm/_cacache` / `~/.local/share/pnpm/store` (❌ prefer `pnpm store prune`) / `~/.cache/Homebrew` | whole / children / children | — | ✅ / ❌ / ✅ |
| `pip-cache` / `uv-cache` / `yarn-cache` / `go-build-cache` / `go-mod-cache` | `~/.cache/{pip,uv,yarn,go-build}`, `~/go/pkg/mod/cache` | whole | — | ✅ |

| Windows kind | Directories | Granularity | minAge | safe |
| --- | --- | --- | --- | --- |
| `trash` | `%SystemDrive%\$Recycle.Bin` | children (one per account SID; `WINDOWS_SYSTEM_SIDS` protects LocalSystem/LocalService/NetworkService) | — | ✅ |
| `system-temp` ×2 | `%TEMP%`, `%SystemRoot%\Temp` | children (protected by `WINDOWS_TEMP_PROTECTED`) | 3 days | ✅ |
| `user-logs` ×3 | `%LOCALAPPDATA%\…\WER\{ReportArchive,ReportQueue}`, `%LOCALAPPDATA%\CrashDumps` | children | — | ✅ |
| `user-caches` ×5 | `INetCache`, `D3DSCache`, `NVIDIA\{DXCache,GLCache}`, `Terminal Server Client\Cache` | children | — | ✅ |
| `npm-cache` / `pnpm-store` | `%LOCALAPPDATA%\npm-cache` / `%LOCALAPPDATA%\pnpm\store` (❌ prefer `pnpm store prune`) | whole / children | — | ✅ / ❌ |
| `pip-cache` / `uv-cache` / `yarn-cache` / `go-build-cache` / `go-mod-cache` | `%LOCALAPPDATA%\{pip\Cache,uv\cache,Yarn\Cache,go-build}`, `%USERPROFILE%\go\pkg\mod\cache` | whole | — | ✅ |

**Windows has no `user-caches` umbrella row** (deliberate): `%LOCALAPPDATA%` is not a
`~/.cache`-style cache directory — it mixes real application state (`Packages\*\LocalState`,
`Microsoft\Credentials`, browser profiles) that no protection list could reliably cover, so only
individually known-safe cache roots are registered. Likewise `$Recycle.Bin` uses children
granularity with one row per account SID: other accounts' SID directories are unreadable
(degraded to `skipped`), and the system-account SIDs are held back by the protection list.

**Imperative reclamation is not in the registry** (following design doc §14): `apt-get autoremove
--purge` (simulated with `-s` first), `journalctl --vacuum-size=`, old snap revisions (disabled
rows of `snap list --all` → `snap remove --revision`), `flatpak uninstall --unused`,
`docker system prune`, plus on Windows `Dism /Online /Cleanup-Image /StartComponentCleanup`
(WinSxS component cleanup), `SoftwareDistribution\Download` (the Windows Update cache, requires
stopping `wuauserv`) and Storage Sense — reported as suggested commands only, never execution
paths.

**The blocked red-line list** (union of all three platforms, guarding against future registry
misconfiguration): macOS keeps `/System`, `/usr`, `/private/var/db`, `~/Library/Containers` etc.
as-is; Linux: `/etc`, `/boot`, `/var/log`, `/var/lib` (dpkg/snapd/flatpak state included),
`/var/cache`, `/lib*` (running kernel modules included), `/srv`; Windows: the list is **derived
from the environment** (`SystemRoot`/`ProgramFiles`/`ProgramData`/`SystemDrive`, with
conventional-path fallbacks), covering `%SystemRoot%`, `Program Files`(+ x86), `ProgramData`,
`Recovery`, `PerfLogs`, `System Volume Information`, `Users\{Default,Public,All Users}`, and
additionally rejects **drive roots** (`C:\`) and other-account trees under the `$HOME` account
root (case-insensitive: Windows filesystems ignore case); `$Recycle.Bin` itself is not on the red
line — it is a registry root. In the multi-user home dual layout (`/Users` and `/home`) other
users' directories are always rejected, and `/root` is rejected likewise when it is not $HOME.

### Reverse proxy / prefix-mounted deployment

All browser-side requests (SSE and JSON) use **document-relative paths** (`pc-manager/…`, no
leading `/`), resolved by the web shell's `<base href="./">` — a pre-existing harness convention
(architecture note *web-document-relative-app-routes*, same as the `/plugins/events` channel).
The plugin therefore **naturally supports prefix-stripping reverse-proxy mounts** (e.g.
`https://host/dsh/` → forward and strip the prefix) and root-path deployments alike, with no
rebuild.

When the SSE stream traverses a reverse proxy, mirror the config dsh itself uses for
`/plugins/events`; otherwise default buffering delays frames and the default 60s read timeout
kills the long connection:

```nginx
location = /dsh/pc-manager/stream {
    proxy_pass http://127.0.0.1:3080/pc-manager/stream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
}
```

## Repository layout

A dual-face package: the host half (tools + routes) and the browser half both consume the
**committed build artifacts in `lib/`** (host `index.js` ESM, external dependencies resolved by
dsh at runtime; client `client.js` is a `window.__ModuleLoader__.load` artifact):

```
├── src/
│   ├── index.ts       Plugin entry: Config (TS interface + Schemastery schema) + apply; host half holds the webServer routes
│   ├── monitor.ts     System probes and pure parsers (macOS subcommands + Linux /proc /sys + the Windows batched PowerShell bundle; no cordis dependency, unit-testable standalone)
│   ├── junk.ts        Junk domain: three-platform safe registry (darwin/linux/win32), the path-flavor layer, protection/blocking lists, walk, id validation chain, three-tier trash
│   ├── win32.ts       Windows platform facilities: PowerShell discovery (cached promise, avoiding concurrent first-call races) and the fault-tolerant JSON reader
│   ├── apps.ts        App domain (M3 stub)
│   ├── types.ts       Domain contracts, PcManagerError, the closed error vocabulary PcErrorCode
│   ├── tools.ts       The only layer touching defineTool: guarded() translates exceptions into the closed error union
│   └── client/        Browser half: dashboard / junk cleanup window / floating window / locale (value imports limited to react-family)
├── lib/               Build artifacts (committed: host index.js + client client.js; *.map ignored)
├── tests/             vitest: all parsers + the full junk domain suite (registry rows pinned, validation chain layer by layer)
│                      + monitor.win32 / junk.win32 (Windows parsers and registry, host-independent)
│                      + e2e.win32 (real-host end to end: snapshot / scan / real Recycle Bin round-trip / HTTP and tool faces / build artifacts)
├── scripts/           build / test / dev-setup (one command: link into profile + build; cross-platform .bin/.cmd shim resolution)
├── bundle.patch.yml   Bundle layer (applied by dsh.plugin add; safe defaults, destructive tools off)
├── cordis.patch.yml   Dev overlay (mounted via --patch, with local dogfooding switches)
├── tsdown.config.ts   Dual-entry build (host ESM + client CJS artifact contract)
├── tsconfig.json      Type-check only (dual-candidate paths mapping to sibling/nested harness layouts)
└── package.json       dsh-pc-manager (dsh.bundle + dsh.client + real semver peer ranges)
```

## Local development

Prerequisite: this repo and [deepseek-harness](../deepseek-harness) are checked out **side by
side** (or nested one level up in the workspace directory, or pointed at via the
`DSH_HARNESS_ROOT` env var). The toolchain (tsdown / vitest / tsc) is entirely resolved from the
harness side; **do not `pnpm install`** in this repo — there is no `node_modules` at all.

> **Verifiable without a harness checkout**: `scripts/test.mjs` only requires `DSH_HARNESS_ROOT`
> to point at a directory with a `package.json` and `vitest`/`tsc` installed, and
> `tsconfig.json` resolves `@deepseek-ai/*` by the same convention in its paths. So you can build
> a "toolchain stand-in" yourself (`npm i vitest typescript @types/node @types/react react
> react-dom tsdown` + junctions following the nested paths in `tsconfig.json`) — that is exactly
> how this repo's Windows support was verified (tsdown 0.23 / vitest 3.2 / TypeScript 6.0, with
> the `@deepseek-ai/*` 0.2.0-rc.2 series).

One-command dev install (links into the profile's node_modules + builds artifacts, idempotent):

```sh
npm run dev-setup                # defaults to --profile web; or node scripts/dev-setup.mjs --profile <name>
```

Run (from the harness repo root; the host half now also consumes `lib/index.js`, so host code
changes require a fresh `npm run build`):

```sh
cd ../deepseek-harness
pnpm dsh --patch ../dsh-pc-manager/cordis.patch.yml --profile web
```

Tests and type checking:

```sh
npm test                         # vitest (182 specs: 176 pass + 6 platform skips) + tsc --noEmit, both via the harness binaries
```

**Cross-platform toolchain notes**: on Windows, `scripts/{build,test}.mjs` automatically target
`.bin/<name>.cmd` and start it with `shell: true` (the extensionless shims in
`node_modules/.bin` are not directly executable on Windows), and `scripts/dev-setup.mjs` uses a
**junction** instead of a directory symlink (symlinks on Windows need Developer Mode or
elevation). `tsc` requires TypeScript 6+: `tsconfig.json`'s `ignoreDeprecations: "6.0"` errors
out with `TS5103` on 5.x.

Coverage spans every pure parser (df both platforms incl. Linux pseudo-filesystem filtering / ps /
vm_stat / meminfo / swapusage / os-release / pmset / ioreg battery & GPU / nvidia-smi whole-card +
pmon per-process / iostat / diskstats rate delta / netstat / net-dev / nettop CSV+JSON / ss -tinp
attribution / power_supply uevent / temperature chip selection / process & GPU merge+sort / CPU
delta) and the full junk domain (per-row pins for all three platform registries and protection
lists, glob expansion, walk statistics, scan semantics, the validation chain layer by layer incl.
symlink redirection and the trailing-slash root escape, all-or-nothing rejection, three-tier
trash on all three platforms incl. `.trashinfo` restore records and conflict-suffix sync, the
blocked red-line union, size-mismatch refusal, approval summary en/zh snapshots), plus the
Windows-specific parsers (`Win32_LogicalDisk` volume rows,
`PerfRawData_Tcpip_NetworkInterface` NIC rows, `Win32_Battery` status codes and the
`EstimatedRunTime` sentinel, `Get-Process` process rows with self-exclusion of the sampling
process, per-field bundle degradation) and Windows path-flavor/red-line/validation cases.

**End to end (`tests/e2e.win32.spec.ts`)** — nothing injected: on a real host it runs
`collectStatus` and asserts snapshot self-consistency (volume arithmetic closes, memory within
total, this process present in the process table, `loadavg` null); a real read-only registry
scan; a **real Recycle Bin round-trip** (hands a fixture file to the shell recycle, finds it
again in the `$Recycle.Bin` `$I`/`$R` records to verify the original location, then deletes only
that one entry without touching the user's existing Recycle Bin contents); real delete mode; a
real `apply()` against a stubbed cordis context hitting the four
`/pc-manager/{status,junk/scan,junk/clean}` faces (incl. 405/400/403 rejection paths) and the
five tools; and finally loads the **committed `lib/` artifacts** (both host and client) to check
their contracts — this step fails when source changed but `npm run build` was forgotten.
Permission-degradation (EACCES) cases need POSIX permission semantics and skip automatically
under root or Windows (root's DAC override reads through 0000 permissions; Windows `chmod` only
flips the read-only attribute and cannot block reads).

**Release convention**: after any source change you must `npm run build` and commit `lib/*.js`
together — the git install loads the committed artifacts directly and runs no build scripts (this
also sidesteps pnpm ≥10 build authorization). Toolchain note: `scripts/build.mjs` loads the TS
config with `tsdown --config-loader native` and automatically adds
`--experimental-strip-types` (tsdown's default unrun config loader is not a harness dependency,
and Node <23 needs the flag too) — no manual intervention required.

## Milestones

- **M0 (done)**: project skeleton — type contracts, 5 tool schemas and registration, plugin
  entry, patch manifests; basic `pc_status` (node built-ins + `df`/`ps`).
- **M1 (done, 2026-10-05)**: full `pc_status` metrics — precise `vm_stat` memory, swap,
  battery/power, GPU, disk I/O, network, macOS version, five-metric process table (GPU/disk
  columns reserved); plus the right-sidebar dashboard (client half + webServer routes + polling).
- **M2 (done, 2026-10-06)**: junk scan & cleanup shipped — 18-kind safe registry + protection/
  blocking lists, dry-run walk (concurrency 4, symlinks not followed, EACCES degrades to
  `skipped`), id validation chain (all-or-nothing rejection, zero deletion), three-tier trash,
  pre-execute approval gate (`askBeforeJunkClean`).
- **M2.5 (done, 2026-10-06)**: trigger UI — dashboard action card + floating-window action row +
  `startSession` seeded draft, sharing the `cleanup.ts` trigger.
- **M2.6 (done, 2026-10-07)**: plan-first — prebuilt recommended plan (`RECOMMENDED_PLAN` into
  domain data + test pin), host `GET /pc-manager/junk/scan` read-only route, dashboard plan card,
  execution seed carrying ids; LLM turns 4→1.
- **M2.7 (done, 2026-10-07)**: plan card rework + UI direct execution — categories as the
  selection unit (kind rows on one screen by default, details folded), server-side 1 MiB
  threshold filter, `POST /pc-manager/junk/clean` direct execution (same gate and validation
  chain + in-place two-step confirmation + audit log line + in-place briefing), dashboard path
  **zero LLM**.
- **M2.8 (done, 2026-10-07)**: standalone window — junk cleanup upgraded to its own right-sidebar
  tab (guide entry peer-level with System Monitor, order 30/31); the floating window's "Scan"
  invokes it via `sidebarRight.openTab` + the autoScan param and scans automatically
  (re-invoke re-scans); the conversational seed path retired. Real cleanup e2e verified three
  times (pip/npm/Homebrew caches → Trash, byte-exact).
- **M2.9 (done, 2026-10-07)**: Linux platform support — monitoring probes dispatch per platform
  (/proc/meminfo, /proc/net/dev, /proc/diskstats two-sample delta, /sys/class/power_supply,
  /etc/os-release, best-effort nvidia-smi, df pseudo-filesystem filtering, ps args column); the
  junk registry splits per platform (`JUNK_TARGETS_LINUX` 12-row XDG layout +
  `LINUX_PROTECTED_CHILDREN`/`LINUX_TEMP_PROTECTED` protection lists); blocked red-line union
  (/etc, /var/lib, /lib*, /boot etc.); Linux landing of the three-tier trash (trash-put/gio trash
  → freedesktop `files/`+`info/` with `.trashinfo` restore records → cross-volume cp+rm);
  platform-neutral tool copy and dashboard labels; the test suite runs green on both Linux and
  macOS (platform assertions injected explicitly, EACCES cases skipped under root).
- **M2.10 (done, 2026-10-07)**: capability-gated probes — Linux root `ss -tinp` socket
  attribution completes per-process network (TCP only, rates via pump delta; whole column hidden
  without root); `nvidia-smi pmon -c 1` attributes SM utilization by pid (binary presence probed
  once and cached; absent → never spawned, no warn spam); CPU package temperature reads
  `/sys/class/hwmon` falling back to `/sys/class/thermal` (max across CPU-family chips,
  `cpu.temperatureCelsius` enters the schema and the CPU card); `pc_status` description synced.
- **M2.11 (done, 2026-10-07)**: Windows platform support — monitoring on node builtins for the
  hot fields (CPU delta, memory totals/available, uptime, `os.version()`+`os.release()` OS name)
  plus a **single batched PowerShell probe** (`Win32_LogicalDisk` volumes, `PerfOS_Memory` memory
  split, page file as swap, `PerfRawData_Tcpip_NetworkInterface` NICs, `PerfDisk_PhysicalDisk`
  throughput, `GPUPerformanceCounters_GPUEngine` vendor-agnostic GPU engines (whole-card
  "busiest engine" scale + per-process GPU attributed by pid, falling back to `nvidia-smi` when
  the class is missing), `Win32_Battery`, `MSAcpi_ThermalZoneTemperature`, `Get-Process` process
  table, with the script self-reporting its `$PID` so the sampling process vanishes from its own
  table); `loadavg` became nullable (Windows has no load average; the dashboard hides the line
  instead of showing a fake 0); on the junk side `JUNK_TARGETS_WIN32` (11 kinds / 18 rows with
  `%VAR%` roots, the Recycle Bin split per account SID) and Windows red lines (environment-derived
  system directories + drive roots + other-account trees, case-insensitive); the **path-flavor
  layer** (posix/win32 chosen by each literal's own style, which also fixed a POSIX-side
  vulnerability where a trailing slash could treat a registry root as "a child of the root" and
  wipe it); Windows landing of the three-tier trash (real Recycle Bin → profile-private holding
  area → cross-volume cp+rm) with tier-1 result re-verification; cross-platform `scripts/*`
  (`.cmd` shims + junctions); 60 new Windows cases and 9 real-host e2e cases (incl. the Recycle
  Bin round-trip, GPU capability consistency assertions, and the committed-`lib/` contract).
  **The only metric that cannot be supplied** is per-process network attribution (needs an ETW
  kernel session, no zero-privilege source); that column is capability-gated hidden on Windows.
- **M3 (planned)**: app inventory & uninstall — macOS `/Applications` bundle walk (du +
  kMDItemLastUseDate), merged with `brew list`, trash-based uninstall, residual reporting
  (plist/`App Support`/caches); Linux distro-package inventory and `rc` residual cleanup, plus
  Windows registry Uninstall keys + a `%ProgramFiles%` walk, as later candidates.
- **Unscheduled**: macOS temperature (`powermetrics` needs sudo, not run on the user's behalf),
  real per-process disk numbers (needs a privileged helper), Windows per-process network
  attribution (needs ETW), refcount-aware pnpm store cleanup, user-persistent exclusion lists.

## License

[MIT](LICENSE)
