import z from "@deepseek-ai/schemastery";
import { execFile } from "node:child_process";
import { access, constants, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, homedir, hostname, loadavg, networkInterfaces, platform, release, totalmem, uptime, version } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { constants as constants$1 } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/win32.ts
/**
* Windows platform utilities shared by the monitor and junk domains.
*
* Windows exposes none of the `/proc`-style text interfaces the other two
* platforms are read through, so both domains shell out to Windows PowerShell
* for everything the node builtins cannot see (volumes, process CPU, per-NIC
* counters, battery, firmware thermal zones, the Recycle Bin shell API).
* Two consequences shape this module:
*
* - **One spawn is expensive.** PowerShell startup dominates (~2.3 s on a
*   machine with endpoint security), so callers batch as much as possible
*   into a single script and this module caches the interpreter lookup.
* - **Windows PowerShell 5.1 JSON is quirky.** `ConvertTo-Json` must be fed
*   `-InputObject @(…)` to keep single-element arrays arrays and to emit `[]`
*   for empty input, and `[Console]::OutputEncoding` has to be forced to UTF-8
*   or a non-ASCII path comes back as mojibake. The readers below accept both
*   shapes so a parser never has to care.
* @module @deepseek-ai/dsh-pc-manager
*/
/** Candidates for the PowerShell interpreter, most preferred first. Windows
* PowerShell 5.1 ships with every supported release; `pwsh` (7+) is optional. */
function powershellCandidates(env = process.env) {
	const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
	const programFiles = env.ProgramFiles ?? "C:\\Program Files";
	return [win32.join(systemRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe"), win32.join(programFiles, "PowerShell\\7\\pwsh.exe")];
}
/** Preamble every script starts with: UTF-8 stdout (so non-ASCII paths
* survive) and a default of no terminating errors (a missing WMI class must
* degrade a field, never the whole probe). */
const PS_PREAMBLE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'SilentlyContinue';";
/** argv for one inline script; `-Command` is unaffected by the execution
* policy, which only gates `.ps1` files and modules. */
const PS_ARGV = [
	"-NoProfile",
	"-NonInteractive",
	"-NoLogo",
	"-Command"
];
let cachedPowershell;
/**
* Resolve the PowerShell interpreter once per process; null when absent. The
* cache holds the *promise*, not its result: two consumers can ask at the same
* time (the SSE pump's collection round and an HTTP `/status` fallback, or a
* probe round and a recycle command), and a value-shaped cache would hand the
* second caller the still-unset sentinel instead of the interpreter.
*/
function resolvePowershell() {
	cachedPowershell ??= probePowershell();
	return cachedPowershell;
}
async function probePowershell() {
	for (const candidate of powershellCandidates()) if (await access(candidate).then(() => true, () => false)) return candidate;
	return null;
}
/**
* Parse one PowerShell JSON payload. A leading BOM (Windows PowerShell writes
* one under a forced UTF-8 console encoding), surrounding whitespace, and an
* empty document are all tolerated → null.
*/
function parsePowershellJson(text) {
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (trimmed.length === 0) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}
/**
* PowerShell unrolls a one-element array into an object, and an empty piped
* list arrives as an empty string rather than `[]`; normalize all three.
*/
function asArray(value) {
	if (Array.isArray(value)) return value;
	if (value === null || value === void 0 || value === "") return [];
	return [value];
}
/** Finite number or null; PowerShell sends numbers, but nulls and `""` occur. */
function asNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
/** Non-empty string or null (a PowerShell `$null` field arrives as null). */
function asString(value) {
	if (typeof value === "string") return value.length > 0 ? value : null;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}
/** Property access on a parsed JSON object without a cast at every step. */
function asRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value;
}
//#endregion
//#region src/monitor.ts
/**
* Read-only system status sampling for macOS and Linux hosts. macOS probes
* shell out to system subcommands; Linux reads /proc and /sys directly (zero
* dependencies, zero privileges). Every probe degrades to an empty result
* instead of failing the snapshot: monitoring must not hard-fail because one
* source is missing. Pure parsers are exported for unit tests.
* @module @deepseek-ai/dsh-pc-manager
*/
const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 5e3;
/** Minimum window between the two `os.cpus()` samples used for utilization. */
const CPU_SAMPLE_MS = 250;
/**
* Linux sampling window: the /proc probes are instant file reads, so the
* window is padded to give the /proc/diskstats differential (and the CPU
* average) a full second — matching what macOS's `iostat -c 2` spans on its
* own clock.
*/
const DISKSTAT_SAMPLE_MS = 1e3;
/**
* Windows probe timeout. One facts bundle or process table costs ~2.5 s on a
* host with endpoint security (PowerShell startup dominates), so the 5 s
* subcommand budget is too tight for a loaded machine — a slow round must
* still return a snapshot rather than degrade every field.
*/
const WINDOWS_PS_TIMEOUT_MS = 2e4;
/** Clamp to one decimal, mapping unparseable input to 0 (percent fields never null). */
function round1(value) {
	return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}
/**
* Linux pseudo filesystems `df -k` reports that are not reclaimable volumes.
* `overlay`/`squashfs` are absent from the set: they are handled specially —
* a container's overlay root at `/` IS its real disk, while snap squashfs
* mounts and nested overlay mounts are artifacts.
*/
const PSEUDO_FILESYSTEMS = /* @__PURE__ */ new Set([
	"tmpfs",
	"devtmpfs",
	"udev",
	"proc",
	"sysfs",
	"cgroup",
	"cgroup2",
	"devpts",
	"mqueue",
	"hugetlbfs",
	"fusectl",
	"securityfs",
	"debugfs",
	"tracefs",
	"pstore",
	"bpf",
	"configfs",
	"autofs",
	"binfmt_misc",
	"ramfs",
	"efivarfs",
	"erofs",
	"iso9660",
	"nsfs",
	"rpc_pipefs",
	"cramfs",
	"fusectlfs"
]);
/** Kernel-owned mount points whose contents are never user-reclaimable volumes. */
const PSEUDO_MOUNT_PREFIXES = [
	"/dev",
	"/proc",
	"/sys",
	"/run",
	"/snap"
];
/**
* Parse `df -k` stdout into byte-level disk usage. Virtual filesystems are
* dropped: macOS devfs/map_* snapshots, and Linux pseudo filesystems plus
* kernel mount points (overlay/squashfs keep only a `/` root).
*/
function parseDf(stdout) {
	const disks = [];
	for (const line of stdout.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 6) continue;
		const [filesystem, kbTotal, kbUsed, kbFree] = fields;
		const mount = fields.slice(fields.length >= 9 ? 8 : 5).join(" ");
		if (filesystem.startsWith("devfs") || filesystem.startsWith("map ")) continue;
		if (filesystem === "overlay" || filesystem === "squashfs") {
			if (mount !== "/") continue;
		} else if (PSEUDO_FILESYSTEMS.has(filesystem)) continue;
		if (PSEUDO_MOUNT_PREFIXES.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))) continue;
		if (!mount.startsWith("/")) continue;
		const total = Number(kbTotal) * 1024;
		if (!Number.isFinite(total) || total <= 0) continue;
		disks.push({
			mount,
			filesystem,
			totalBytes: total,
			usedBytes: Number(kbUsed) * 1024,
			freeBytes: Number(kbFree) * 1024
		});
	}
	return disks;
}
/**
* Parse `ps -Ao pid,pcpu,pmem,rss,comm` stdout into rows in input order;
* ranking happens in {@link sortProcesses}. Network/GPU/disk fields start null
* and are filled by {@link mergeProcesses} where data exists.
*/
function parsePs(stdout) {
	const rows = [];
	for (const line of stdout.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5) continue;
		const pid = Number(fields[0]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const rssKb = Number(fields[3]);
		rows.push({
			pid,
			cpuPercent: round1(Number(fields[1])),
			memPercent: round1(Number(fields[2])),
			rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
			command: fields.slice(4).join(" "),
			netRxBytes: null,
			netTxBytes: null,
			gpuPercent: null,
			diskReadBytes: null,
			diskWrittenBytes: null
		});
	}
	return rows;
}
/**
* Whole-system CPU utilization 0–100 from two `os.cpus()` samples; null when
* the counter window is empty (e.g. zero elapsed ticks).
*/
function cpuUsagePercent(prev, cur) {
	let busyDelta = 0;
	let totalDelta = 0;
	for (let index = 0; index < Math.min(prev.length, cur.length); index += 1) {
		const before = prev[index]?.times;
		const after = cur[index]?.times;
		if (before === void 0 || after === void 0) continue;
		const beforeTotal = before.user + before.nice + before.sys + before.idle + before.irq;
		const afterTotal = after.user + after.nice + after.sys + after.idle + after.irq;
		busyDelta += afterTotal - after.idle - (beforeTotal - before.idle);
		totalDelta += afterTotal - beforeTotal;
	}
	if (totalDelta <= 0) return null;
	return round1(Math.min(100, Math.max(0, busyDelta / totalDelta * 100)));
}
const VMSTAT_KEYS = [
	["Pages free", "freeBytes"],
	["Pages active", "activeBytes"],
	["Pages inactive", "inactiveBytes"],
	["Pages speculative", "speculativeBytes"],
	["Pages wired down", "wiredBytes"],
	["Pages purgeable", "purgeableBytes"],
	["Pages occupied by compressor", "compressedBytes"]
];
/**
* Parse `vm_stat` stdout (page size read from its header, counts carry a
* trailing dot); null when the page size is absent or unusable.
*/
function parseVmStat(stdout) {
	const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
	if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
	const usage = {
		freeBytes: 0,
		activeBytes: 0,
		inactiveBytes: 0,
		speculativeBytes: 0,
		wiredBytes: 0,
		purgeableBytes: 0,
		compressedBytes: 0
	};
	for (const line of stdout.split("\n")) {
		const match = /^([^:]+):\s+(\d+)\.?\s*$/.exec(line.trim());
		if (match === null) continue;
		const key = VMSTAT_KEYS.find(([label]) => label === match[1]);
		if (key === void 0) continue;
		usage[key[1]] = Number(match[2]) * pageSize;
	}
	return usage;
}
/** Binary multiples `sysctl vm.swapusage` reports sizes in. */
const SWAP_UNITS = {
	B: 1,
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
	T: 1024 ** 4
};
/** One `total = 12.00M used = ...` triplet member scaled to bytes. */
function swapMember(text, key) {
	const match = new RegExp(`${key}\\s*=\\s*([\\d.]+)\\s*([BKMGT])`).exec(text);
	if (match === null) return null;
	const value = Number(match[1]);
	const unit = SWAP_UNITS[match[2]];
	return Number.isFinite(value) && unit !== void 0 ? value * unit : null;
}
/** Parse `sysctl -n vm.swapusage`; null when the line shape is unrecognized. */
function parseSwapUsage(stdout) {
	const totalBytes = swapMember(stdout, "total");
	const usedBytes = swapMember(stdout, "used");
	if (totalBytes === null || usedBytes === null) return null;
	return {
		totalBytes,
		usedBytes,
		freeBytes: swapMember(stdout, "free") ?? Math.max(0, totalBytes - usedBytes)
	};
}
/**
* Parse `/proc/meminfo` (`MemTotal:  16380760 kB` lines, always kB); null
* when the MemTotal/MemFree anchors are missing.
*/
function parseMeminfo(stdout) {
	const values = /* @__PURE__ */ new Map();
	for (const line of stdout.split("\n")) {
		const match = /^([A-Za-z_]+):\s+(\d+)\s*kB\s*$/.exec(line);
		if (match !== null) values.set(match[1], Number(match[2]) * 1024);
	}
	const totalBytes = values.get("MemTotal");
	const freeBytes = values.get("MemFree");
	if (totalBytes === void 0 || freeBytes === void 0) return null;
	const buffers = values.get("Buffers") ?? 0;
	const cached = values.get("Cached") ?? 0;
	const sreclaimable = values.get("SReclaimable") ?? 0;
	const availableBytes = values.get("MemAvailable") ?? null;
	return {
		totalBytes,
		freeBytes,
		availableBytes,
		cachedBytes: buffers + cached + sreclaimable,
		anonPagesBytes: values.get("AnonPages") ?? 0,
		sUnreclaimBytes: values.get("SUnreclaim") ?? null,
		swapTotalBytes: values.get("SwapTotal") ?? 0,
		swapFreeBytes: values.get("SwapFree") ?? 0,
		usedBytes: availableBytes !== null ? Math.max(0, totalBytes - availableBytes) : Math.max(0, totalBytes - freeBytes - buffers - cached)
	};
}
/**
* Parse `/etc/os-release` into the osVersion face: PRETTY_NAME when present
* (it names the distro itself, e.g. `Debian GNU/Linux 12 (bookworm)`), else
* NAME + VERSION_ID; null with neither.
*/
function parseOsRelease(stdout) {
	const values = /* @__PURE__ */ new Map();
	for (const line of stdout.split("\n")) {
		const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/.exec(line);
		if (match !== null) values.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
	}
	const pretty = values.get("PRETTY_NAME");
	if (pretty !== void 0 && pretty.length > 0) return pretty;
	const name = values.get("NAME");
	if (name === void 0 || name.length === 0) return null;
	const version = values.get("VERSION_ID");
	return version === void 0 || version.length === 0 ? name : `${name} ${version}`;
}
/**
* Parse `pmset -g batt`; null when no InternalBattery row appears (desktops),
* which is the signal that the host has no battery to report.
*/
function parsePmsetBatt(stdout) {
	const line = stdout.split("\n").find((candidate) => candidate.includes("InternalBattery"));
	if (line === void 0) return null;
	const percent = /(\d+(?:\.\d+)?)\s*%/.exec(line);
	const remaining = /(\d+):(\d+)\s*remaining/.exec(line);
	const state = line.split(";")[1]?.trim() ?? "";
	return {
		percent: percent === null ? null : Number(percent[1]),
		charging: state === "charging" || state === "finishing charge",
		powerSource: /Now drawing from '([^']+)'/.exec(stdout)?.[1] ?? null,
		timeRemainingMinutes: remaining === null ? null : Number(remaining[1]) * 60 + Number(remaining[2])
	};
}
/** One quoted ioreg integer property. */
function ioregNumber(text, key) {
	const match = new RegExp(`"${key}"\\s*=\\s*(\\d+)`).exec(text);
	return match === null ? null : Number(match[1]);
}
/**
* Parse `ioreg -rn AppleSmartBattery` into cycle count and health (full over
* design capacity); null when the node carries no battery evidence at all —
* desktops expose the node with zeroed capacities.
*/
function parseIoregBattery(stdout) {
	const cycleCount = ioregNumber(stdout, "Cycle Count");
	const fullCapacity = ioregNumber(stdout, "NominalChargeCapacity") ?? ioregNumber(stdout, "MaxCapacity");
	const designCapacity = ioregNumber(stdout, "DesignCapacity");
	const healthPercent = fullCapacity !== null && designCapacity !== null && designCapacity > 0 ? Math.min(100, Math.round(fullCapacity / designCapacity * 100)) : null;
	if (healthPercent === null && (cycleCount ?? 0) === 0) return null;
	return {
		cycleCount,
		healthPercent
	};
}
/**
* Parse the `uevent` of one `BAT*` supply under /sys/class/power_supply
* (`POWER_SUPPLY_KEY=value` lines). `acOnline` comes from the adapter
* `online` files: true/false pins the power source, null derives it from
* STATUS. Null overall when the node is not a present battery (an AC
* adapter's uevent, or `PRESENT=0`).
*/
function parseBatteryUevent(text, acOnline) {
	const values = /* @__PURE__ */ new Map();
	for (const line of text.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
	}
	if (values.get("POWER_SUPPLY_PRESENT") === "0") return null;
	if (values.get("POWER_SUPPLY_TYPE") !== "Battery") return null;
	const status = values.get("POWER_SUPPLY_STATUS") ?? null;
	const charging = status === null ? null : status === "Charging";
	const capacityField = Number(values.get("POWER_SUPPLY_CAPACITY"));
	const now = Number(values.get("POWER_SUPPLY_ENERGY_NOW") ?? values.get("POWER_SUPPLY_CHARGE_NOW"));
	const full = Number(values.get("POWER_SUPPLY_ENERGY_FULL") ?? values.get("POWER_SUPPLY_CHARGE_FULL"));
	const design = Number(values.get("POWER_SUPPLY_ENERGY_FULL_DESIGN") ?? values.get("POWER_SUPPLY_CHARGE_FULL_DESIGN"));
	const percent = Number.isFinite(capacityField) ? capacityField : Number.isFinite(now) && Number.isFinite(full) && full > 0 ? Math.round(now / full * 100) : null;
	const healthPercent = Number.isFinite(full) && Number.isFinite(design) && design > 0 ? Math.min(100, Math.round(full / design * 100)) : null;
	const cycleField = Number(values.get("POWER_SUPPLY_CYCLE_COUNT"));
	const minutesField = Number(values.get(charging === false ? "POWER_SUPPLY_TIME_TO_EMPTY_NOW" : "POWER_SUPPLY_TIME_TO_FULL_NOW"));
	return {
		percent,
		charging,
		powerSource: acOnline === true ? "AC Power" : acOnline === false ? "Battery Power" : status === "Discharging" ? "Battery Power" : status !== null && status !== "Unknown" ? "AC Power" : null,
		timeRemainingMinutes: Number.isFinite(minutesField) ? minutesField : null,
		cycleCount: Number.isFinite(cycleField) ? cycleField : null,
		healthPercent
	};
}
/**
* Read the first present battery under /sys/class/power_supply into a
* {@link BatteryStatus}, pinning the power source from any adapter `online`
* file; null on desktops/servers (no supply subsystem or no battery).
*/
async function readLinuxBattery() {
	const supplyDir = "/sys/class/power_supply";
	let entries;
	try {
		entries = await readdir(supplyDir, { withFileTypes: true });
	} catch {
		return null;
	}
	let acOnline = null;
	for (const entry of entries) {
		if (!/^A/i.test(entry.name)) continue;
		try {
			const online = (await readFile(join(supplyDir, entry.name, "online"), "utf8")).trim() === "1";
			acOnline = acOnline === true ? true : online;
		} catch {}
	}
	for (const entry of entries) {
		if (!/^B/i.test(entry.name)) continue;
		const uevent = await readFile(join(supplyDir, entry.name, "uevent"), "utf8").catch(() => null);
		if (uevent === null) continue;
		const sample = parseBatteryUevent(uevent, acOnline);
		if (sample !== null) return {
			percent: sample.percent,
			charging: sample.charging,
			powerSource: sample.powerSource,
			timeRemainingMinutes: sample.timeRemainingMinutes,
			cycleCount: sample.cycleCount,
			healthPercent: sample.healthPercent
		};
	}
	return null;
}
/**
* Parse `ioreg -r -d 1 -c IOAccelerator` for the GPU's `Device Utilization %`,
* taking the busiest of several GPUs; null when the key is absent (VMs, and
* macOS versions that drop it).
*/
function parseIoregGpu(stdout) {
	let best = null;
	for (const match of stdout.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)) {
		const value = Number(match[1]);
		if (Number.isFinite(value) && (best === null || value > best)) best = value;
	}
	return best === null ? null : Math.min(100, best);
}
/**
* Parse `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`
* (one integer line per GPU), taking the busiest; null when no line parses
* (no NVIDIA hardware, `[Not Supported]` rows, command absent).
*/
function parseNvidiaSmiGpu(stdout) {
	let best = null;
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s*$/.exec(line);
		if (match === null) continue;
		const value = Number(match[1]);
		if (best === null || value > best) best = value;
	}
	return best === null ? null : Math.min(100, best);
}
/**
* Parse `nvidia-smi pmon -c 1` (`gpu pid type sm mem enc dec command` rows,
* `#` comment headers, `-` placeholders) into per-pid SM utilization; the
* busiest GPU wins when a pid spans several.
*/
function parseNvidiaSmiPmon(stdout) {
	const rows = /* @__PURE__ */ new Map();
	for (const line of stdout.split("\n")) {
		const trimmedLine = line.trim();
		if (trimmedLine.startsWith("#")) continue;
		const fields = trimmedLine.split(/\s+/);
		if (fields.length < 5) continue;
		const pid = Number(fields[1]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const sm = Number(fields[3]);
		if (!Number.isFinite(sm)) continue;
		const best = rows.get(pid);
		if (best === void 0 || sm > best) rows.set(pid, Math.min(100, sm));
	}
	return rows;
}
/** Cached nvidia-smi existence: probing must not spawn (and warn) every
* round on hosts without NVIDIA hardware. */
let nvidiaSmiAvailable = null;
/** Where nvidia-smi can live: the Linux toolchain paths, or on Windows the
* driver's System32/NVSMI locations plus whatever is on PATH. */
function nvidiaSmiCandidates() {
	if (platform() !== "win32") return ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"];
	const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const onPath = (process.env.PATH ?? "").split(";").filter((entry) => entry.trim().length > 0).map((entry) => win32.join(entry.trim(), "nvidia-smi.exe"));
	return [
		win32.join(systemRoot, "System32\\nvidia-smi.exe"),
		win32.join(programFiles, "NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"),
		...onPath
	];
}
async function hasNvidiaSmi() {
	if (nvidiaSmiAvailable === null) {
		nvidiaSmiAvailable = false;
		for (const bin of nvidiaSmiCandidates()) if (await access(bin, constants.X_OK).then(() => true, () => false)) {
			nvidiaSmiAvailable = true;
			break;
		}
	}
	return nvidiaSmiAvailable;
}
/** Attach per-process SM utilization (nvidia-smi pmon) to ps rows by pid. */
function mergeGpuPercent(psRows, gpuRows) {
	if (gpuRows.size === 0) return [...psRows];
	return psRows.map((row) => {
		const gpu = gpuRows.get(row.pid);
		return gpu === void 0 ? row : {
			...row,
			gpuPercent: gpu
		};
	});
}
/** Chip names (hwmon `name` or thermal-zone `type`) whose reading counts as
* the CPU package temperature. */
const CPU_TEMP_SOURCES = /^(?:coretemp|k\d+temp|zenpower|cpu|soc_thermal|soc_dts|acpitz|x86_pkg_temp)/i;
/** True when a chip reading may headline as the CPU temperature. */
function isCpuTempSource(name) {
	return CPU_TEMP_SOURCES.test(name);
}
/**
* The headline CPU temperature across candidate chips: per-core inputs
* report per-core readings, so the max over the CPU-named chips is the
* honest glance value. Null when no candidate chip contributed.
*/
function pickCpuTempCelsius(chips) {
	let best = null;
	for (const chip of chips) {
		if (!isCpuTempSource(chip.name)) continue;
		for (const celsius of chip.celsius) if (Number.isFinite(celsius) && (best === null || celsius > best)) best = celsius;
	}
	return best === null ? null : round1(best);
}
/**
* Linux CPU temperature: hwmon chips (`name` + `temp*_input`, millidegrees)
* with a thermal_zone fallback (`type` + `temp`). Zero privileges needed —
* but cloud VMs commonly expose no sensor at all, which reads as null.
*/
async function readLinuxCpuTemp() {
	const chips = [];
	for (const base of ["/sys/class/hwmon", "/sys/class/thermal"]) {
		let entries;
		try {
			entries = await readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const chip = {
				name: "",
				celsius: []
			};
			if (base.endsWith("hwmon")) {
				if (!entry.name.startsWith("hwmon")) continue;
				const dir = join(base, entry.name);
				chip.name = (await readFile(join(dir, "name"), "utf8").catch(() => "")).trim();
				for (const file of await readdir(dir).catch(() => [])) if (/^temp\d+_input$/.test(file)) {
					const milli = Number((await readFile(join(dir, file), "utf8").catch(() => "")).trim());
					if (Number.isFinite(milli)) chip.celsius.push(milli / 1e3);
				}
			} else {
				if (!entry.name.startsWith("thermal_zone")) continue;
				const dir = join(base, entry.name);
				chip.name = (await readFile(join(dir, "type"), "utf8").catch(() => "")).trim();
				const milli = Number((await readFile(join(dir, "temp"), "utf8").catch(() => "")).trim());
				if (Number.isFinite(milli)) chip.celsius.push(milli / 1e3);
			}
			chips.push(chip);
		}
	}
	return pickCpuTempCelsius(chips);
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
ConvertTo-Json -InputObject $bundle -Compress -Depth 5`;
/**
* Project the volume rows of one facts bundle. `mount` is spelled the way
* Windows spells it (`C:\`) and `filesystem` carries the real volume name
* (NTFS/exFAT/FAT32) instead of a type code.
*/
function parseWindowsVolumes(rows) {
	const volumes = [];
	for (const raw of rows) {
		const row = asRecord(raw);
		if (row === null) continue;
		const deviceId = asString(row.deviceId);
		const totalBytes = asNumber(row.sizeBytes);
		const freeBytes = asNumber(row.freeBytes);
		if (deviceId === null || totalBytes === null || freeBytes === null) continue;
		if (totalBytes <= 0 || freeBytes < 0) continue;
		volumes.push({
			mount: `${deviceId}\\`,
			filesystem: asString(row.fileSystem) ?? "unknown",
			totalBytes,
			usedBytes: Math.max(0, totalBytes - freeBytes),
			freeBytes
		});
	}
	return volumes;
}
/**
* Project the per-NIC rows of one facts bundle. Windows keeps cumulative
* counters in the raw performance class (its `…Persec` names are the
* performance-counter convention, not a rate), so these are the same
* since-boot totals `netstat -ib` and /proc/net/dev give on the other two
* platforms; duplicate adapter instances keep their `_2` suffix.
*/
function parseWindowsNetwork(rows) {
	const interfaces = [];
	for (const raw of rows) {
		const row = asRecord(raw);
		if (row === null) continue;
		const name = asString(row.name);
		const rxBytes = asNumber(row.rxBytes);
		const txBytes = asNumber(row.txBytes);
		if (name === null || rxBytes === null || txBytes === null) continue;
		interfaces.push({
			interface: name,
			rxBytes,
			txBytes
		});
	}
	return interfaces;
}
/** Battery status codes Win32_Battery reports as "on wall power". */
const WINDOWS_AC_STATUS = /* @__PURE__ */ new Set([
	2,
	6,
	7,
	8,
	9,
	11
]);
/** …and the subset that means the pack is actively charging. */
const WINDOWS_CHARGING_STATUS = /* @__PURE__ */ new Set([
	6,
	7,
	8,
	9,
	11
]);
/** Win32_Battery's "no estimate" sentinel for EstimatedRunTime. */
const WINDOWS_UNKNOWN_RUNTIME = 7158276;
/**
* Project the battery row. `powerSource` reuses the macOS/literal strings
* (`AC Power` / `Battery Power`) so the dashboard's existing state mapping
* keeps working; cycle count and health are not exposed by Win32_Battery
* (they need vendor WMI or `powercfg /batteryreport`), so they stay null.
*/
function parseWindowsBattery(row) {
	const record = asRecord(row);
	if (record === null) return null;
	const percent = asNumber(record.percent);
	const status = asNumber(record.status);
	if (percent === null && status === null) return null;
	const onAc = status !== null && WINDOWS_AC_STATUS.has(status);
	const minutes = asNumber(record.runTimeMinutes);
	return {
		percent: percent === null ? null : Math.min(100, Math.max(0, Math.round(percent))),
		charging: status === null ? null : WINDOWS_CHARGING_STATUS.has(status),
		powerSource: status === null ? null : onAc ? "AC Power" : "Battery Power",
		timeRemainingMinutes: minutes === null || onAc || minutes >= WINDOWS_UNKNOWN_RUNTIME ? null : Math.round(minutes),
		cycleCount: null,
		healthPercent: null
	};
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
function parseWindowsGpuEngines(rows, available) {
	const byPid = /* @__PURE__ */ new Map();
	const byEngine = /* @__PURE__ */ new Map();
	let sawRow = false;
	for (const raw of rows) {
		const row = asRecord(raw);
		if (row === null) continue;
		const name = asString(row.name);
		const utilization = asNumber(row.utilization);
		if (name === null || utilization === null || utilization <= 0) continue;
		const pidMatch = /pid_(\d+)/.exec(name);
		if (pidMatch === null) continue;
		const pid = Number(pidMatch[1]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		sawRow = true;
		byPid.set(pid, (byPid.get(pid) ?? 0) + utilization);
		const engine = /engtype_(.+)$/.exec(name)?.[1] ?? "unknown";
		byEngine.set(engine, (byEngine.get(engine) ?? 0) + utilization);
	}
	for (const [pid, value] of byPid) byPid.set(pid, Math.min(100, round1(value)));
	const busiest = sawRow ? Math.max(...byEngine.values()) : 0;
	return {
		totalPercent: available ? Math.min(100, round1(busiest)) : null,
		byPid
	};
}
/** Parse one probe bundle; null when the payload is not JSON at all. */
function parseWindowsBundle(stdout, totalMemoryBytes) {
	const root = asRecord(parsePowershellJson(stdout));
	if (root === null) return null;
	const gpu = {
		...parseWindowsGpuEngines(asArray(root.gpuEngines), root.gpuCounterAvailable === true),
		name: asString(root.gpuAdapterName)
	};
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
		processes: mergeGpuPercent(parseWindowsProcesses(stdout, totalMemoryBytes), gpu.byPid)
	};
}
/**
* Project the Windows process table. `cpuPercent` is the process's lifetime
* average on the single-core scale — the same ps semantics macOS and Linux
* report, so the ranking is comparable across platforms — and processes whose
* `StartTime`/`CPU` are unreadable (protected system processes) read as 0.
*/
function parseWindowsProcesses(stdout, totalMemoryBytes) {
	const root = asRecord(parsePowershellJson(stdout));
	if (root === null) return [];
	const samplerPid = asNumber(root.samplerPid);
	const rows = [];
	for (const raw of asArray(root.processes)) {
		const row = asRecord(raw);
		if (row === null) continue;
		const pid = asNumber(row.pid);
		if (pid === null || !Number.isInteger(pid) || pid <= 0) continue;
		if (samplerPid !== null && pid === samplerPid) continue;
		const rssBytes = asNumber(row.rssBytes) ?? 0;
		const cpuPercent = asNumber(row.cpuPercent) ?? 0;
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
			diskWrittenBytes: null
		});
	}
	return rows;
}
/**
* Windows OS name from the node builtins: `os.version()` carries the product
* name ("Windows 11 Pro for Workstations") and `os.release()` the build
* ("10.0.26300"). Together they are the same "which OS is this" answer
* `sw_vers -productVersion` and `/etc/os-release` give on the other platforms
* — and unlike the WMI caption they are available even when PowerShell is not.
*/
function windowsOsVersion() {
	const name = version();
	const build = release();
	if (name.length === 0) return build.length > 0 ? build : null;
	return build.length === 0 ? name : `${name} ${build}`;
}
/** Run one PowerShell script, returning its UTF-8 stdout. */
async function runPowershell(script) {
	const bin = await resolvePowershell();
	if (bin === null) throw new Error("Windows PowerShell not found");
	const { stdout } = await run(bin, [...PS_ARGV, script], {
		timeout: WINDOWS_PS_TIMEOUT_MS,
		maxBuffer: 8388608
	});
	return stdout;
}
/** Run the Windows probe bundle (null when PowerShell is missing or the
* payload is unusable — the caller then keeps its node-builtin numbers). */
async function readWindowsBundle(totalMemoryBytes) {
	return parseWindowsBundle(await runPowershell(WINDOWS_BUNDLE_SCRIPT), totalMemoryBytes);
}
/**
* Parse `iostat -d -c 2` and return the last (instantaneous) sample's total
* throughput summed across disks, in bytes/sec. Each disk contributes a
* `KB/t tps MB/s` triple; MB/s is treated as a binary multiple (1024²).
*/
function parseIostat(stdout) {
	let last = null;
	for (const line of stdout.split("\n")) {
		const tokens = line.trim().split(/\s+/);
		if (tokens.length < 3 || tokens.length % 3 !== 0) continue;
		if (!tokens.every((token) => /^\d+(\.\d+)?$/.test(token))) continue;
		last = tokens.map(Number);
	}
	if (last === null) return null;
	let mbPerSec = 0;
	for (let index = 2; index < last.length; index += 3) {
		const value = last[index];
		if (value !== void 0) mbPerSec += value;
	}
	return mbPerSec * 1024 * 1024;
}
/** Physical whole-disk names; partitions, loop/dm/md devices are excluded so
* partitions do not double-count against their parent disk. */
const PHYSICAL_DISK_PATTERN = /^(?:sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+|mmcblk\d+)$/;
/**
* Parse `/proc/diskstats` (`major minor name rd_ios rd_merges rd_sectors
* rd_ms wr_ios wr_merges wr_sectors …`); non-physical or malformed rows are
* skipped, never summed as garbage.
*/
function parseDiskstats(stdout, at = Date.now()) {
	let sectors = 0;
	for (const line of stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 10) continue;
		if (!PHYSICAL_DISK_PATTERN.test(fields[2] ?? "")) continue;
		const read = Number(fields[5]);
		const written = Number(fields[9]);
		if (!Number.isFinite(read) || !Number.isFinite(written)) continue;
		sectors += read + written;
	}
	return {
		at,
		sectors
	};
}
/** Whole-disk throughput (bytes/sec) from two /proc/diskstats samples; null
* on an empty window or a counter reset (never a negative rate). */
function diskstatRate(prev, cur) {
	const dtSeconds = (cur.at - prev.at) / 1e3;
	if (dtSeconds <= 0 || cur.sectors < prev.sectors) return null;
	return (cur.sectors - prev.sectors) * 512 / dtSeconds;
}
/** Read one /proc/diskstats snapshot (the Linux iostat equivalent). */
async function readDiskstats() {
	return parseDiskstats(await readFile("/proc/diskstats", "utf8"));
}
/**
* Parse `netstat -ib` into one row per interface, keeping only the `<Link#>`
* row of each name (address rows repeat the counters). Loopback and down
* interfaces (`*` suffix) are dropped.
*/
function parseNetstatIb(stdout) {
	const interfaces = /* @__PURE__ */ new Map();
	for (const line of stdout.split("\n").slice(1)) {
		if (!line.includes("<Link#")) continue;
		const fields = line.trim().split(/\s+/);
		const name = fields[0];
		if (name === void 0 || name.startsWith("lo") || name.endsWith("*")) continue;
		const linkIndex = fields.findIndex((field) => field.startsWith("<Link#"));
		const after = fields.slice(linkIndex + 1);
		const counters = after.length === 8 ? after.slice(1) : after;
		const rxBytes = Number(counters[2]);
		const txBytes = Number(counters[5]);
		if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
		if (!interfaces.has(name)) interfaces.set(name, {
			interface: name,
			rxBytes,
			txBytes
		});
	}
	return [...interfaces.values()];
}
/**
* Parse `/proc/net/dev` (`iface: rx_bytes … tx_bytes …`, 8 counter fields per
* direction); loopback excluded. The Linux counterpart of `netstat -ib`.
*/
function parseProcNetDev(stdout) {
	const interfaces = [];
	for (const line of stdout.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const name = line.slice(0, separator).trim();
		if (name === "lo") continue;
		const fields = line.slice(separator + 1).trim().split(/\s+/);
		const rxBytes = Number(fields[0]);
		const txBytes = Number(fields[8]);
		if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
		interfaces.push({
			interface: name,
			rxBytes,
			txBytes
		});
	}
	return interfaces;
}
/**
* Local IPv4 selection over `os.networkInterfaces()` — the one address source
* that is identical on every platform (no subprocess involved). Internal
* (loopback) entries and IPv4 link-local addresses (169.254.x.x, a DHCP miss)
* are excluded; remaining addresses keep os order, deduplicated.
*/
function pickLocalAddresses(interfaces) {
	const seen = /* @__PURE__ */ new Set();
	for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
		if (entry.internal || entry.family !== "IPv4") continue;
		if (entry.address.startsWith("169.254.") || seen.has(entry.address)) continue;
		seen.add(entry.address);
	}
	return [...seen];
}
/**
* Parse an ipwho.is-compatible lookup body
* (`{"ip":"1.2.3.4","success":true,"city":…,"region":…,"country":…,"country_code":"CN"}`).
* Missing place fields degrade to null; a body without a usable ip (or
* `success:false`, or non-JSON) is null overall.
*/
function parseIpWhoIs(json) {
	let value;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const record = value;
	if (record.success === false) return null;
	if (typeof record.ip !== "string" || record.ip.length === 0) return null;
	const text = (key) => {
		const field = record[key];
		return typeof field === "string" && field.length > 0 ? field : null;
	};
	return {
		ip: record.ip,
		city: text("city"),
		region: text("region"),
		country: text("country"),
		countryCode: text("country_code")
	};
}
const IP_GEO_TIMEOUT_MS = 5e3;
/** Retry floor after a failed lookup — a dead endpoint must not be hit once
* per snapshot round. */
const IP_GEO_FAILURE_RETRY_MS = 6e4;
/**
* Public-IP geolocation behind a TTL cache with single-flight. Successes stay
* cached for `refreshMs`, failures for {@link IP_GEO_FAILURE_RETRY_MS}; the
* dashboard pump samples every few seconds, so the outbound request rate is
* bounded by the cache, not the poll. All errors degrade to null with one
* warn per actual attempt — the lookup must never fail a snapshot.
*/
function createIpGeoLookup(options) {
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	let cached = null;
	let cachedAt = Number.NEGATIVE_INFINITY;
	let inflight = null;
	const fresh = () => {
		const ttl = cached === null ? IP_GEO_FAILURE_RETRY_MS : options.refreshMs;
		return now() - cachedAt < ttl;
	};
	const attempt = async () => {
		const response = await doFetch(options.endpoint, { signal: AbortSignal.timeout(IP_GEO_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
		return parseIpWhoIs(await response.text());
	};
	return async () => {
		if (fresh()) return cached;
		inflight ??= attempt().then((value) => {
			cached = value;
			cachedAt = now();
			return value;
		}).catch((error) => {
			console.warn(`[pc-manager] ip-geo lookup failed: ${String(error)}`);
			cached = null;
			cachedAt = now();
			return null;
		}).finally(() => {
			inflight = null;
		});
		return inflight;
	};
}
/** `name.pid` → pid (the part after the last dot; names may contain dots/spaces). */
function pidFromKey(key) {
	const match = /^(.*)\.(\d+)\s*$/.exec(key);
	if (match === null) return null;
	const pid = Number(match[2]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}
/**
* Parse `nettop -P -L 1 -J bytes_in,bytes_out`. macOS 26+ prints CSV
* (`name.pid,in,out,` rows, warnings mixed into stdout); older releases print
* a JSON object — both are accepted, garbage lines are skipped.
*/
function parseNettop(stdout) {
	const rows = /* @__PURE__ */ new Map();
	const trimmed = stdout.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			for (const [key, value] of Object.entries(parsed.processes ?? {})) {
				const pid = pidFromKey(key);
				if (pid === null || value.bytes_in === void 0 || value.bytes_out === void 0) continue;
				rows.set(pid, {
					rxBytes: value.bytes_in,
					txBytes: value.bytes_out
				});
			}
		} catch {}
		return rows;
	}
	for (const line of trimmed.split("\n")) {
		const parts = line.split(",");
		const pid = pidFromKey(parts[0] ?? "");
		const rxBytes = Number(parts[1]);
		const txBytes = Number(parts[2]);
		if (pid === null || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
		rows.set(pid, {
			rxBytes,
			txBytes
		});
	}
	return rows;
}
/**
* True when this process may attribute EVERY socket to its pid — `ss -p`
* under a normal user only names its own sockets, which would read as
* "nobody else uses the network". Root only; injected for tests.
*/
function canAttributeSockets(uid = process.getuid?.()) {
	return uid === 0;
}
/**
* Parse `ss -tinp`, the privileged Linux counterpart of nettop: each socket
* row names its owning processes (`users:(("name",pid=1,fd=3))`) and the
* indented info line that follows carries cumulative per-socket counters.
* Bytes are summed per pid across sockets; tx prefers `bytes_sent` and falls
* back to `bytes_acked` (older iproute2). TCP only — the counters live on
* tcp_info. A socket shared by several pids credits each of them.
*/
function parseSsTinp(stdout) {
	const rows = /* @__PURE__ */ new Map();
	let pendingPids = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith(" ") || line.startsWith("	")) {
			if (pendingPids === null) continue;
			const rxRaw = /bytes_received:(\d+)/.exec(line)?.[1];
			const txRaw = /bytes_sent:(\d+)/.exec(line)?.[1] ?? /bytes_acked:(\d+)/.exec(line)?.[1];
			if (rxRaw !== void 0 || txRaw !== void 0) for (const pid of pendingPids) {
				const row = rows.get(pid) ?? {
					rxBytes: 0,
					txBytes: 0
				};
				row.rxBytes += rxRaw === void 0 ? 0 : Number(rxRaw);
				row.txBytes += txRaw === void 0 ? 0 : Number(txRaw);
				rows.set(pid, row);
			}
			pendingPids = null;
			continue;
		}
		const users = /users:\(\((.*)\)\)/.exec(line)?.[1];
		if (users === void 0) {
			pendingPids = null;
			continue;
		}
		pendingPids = [...users.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])).filter((pid) => Number.isInteger(pid) && pid > 0);
		if (pendingPids.length === 0) pendingPids = null;
	}
	return rows;
}
/** Attach per-process network counters to ps rows by pid. */
function mergeProcesses(psRows, netRows) {
	return psRows.map((row) => {
		const net = netRows.get(row.pid);
		return net === void 0 ? row : {
			...row,
			netRxBytes: net.rxBytes,
			netTxBytes: net.txBytes
		};
	});
}
/**
* Per-interface byte rates derived from two consecutive snapshots (their
* `sampledAt` stamps provide the window). Missing interfaces, counter resets
* (reboot), and empty windows yield no entry — never a negative or bogus rate.
*/
function diffNetRates(prev, cur) {
	const rates = /* @__PURE__ */ new Map();
	if (prev === null) return rates;
	const dtSeconds = (Date.parse(cur.sampledAt) - Date.parse(prev.sampledAt)) / 1e3;
	if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return rates;
	for (const iface of cur.network) {
		const before = prev.network.find((candidate) => candidate.interface === iface.interface);
		if (before === void 0 || iface.rxBytes < before.rxBytes || iface.txBytes < before.txBytes) continue;
		rates.set(iface.interface, {
			rxPerSec: (iface.rxBytes - before.rxBytes) / dtSeconds,
			txPerSec: (iface.txBytes - before.txBytes) / dtSeconds
		});
	}
	return rates;
}
/**
* Per-process network rates from cumulative counters, each pid differenced
* over its OWN window since it last appeared in a frame — a process that
* dropped off a list and returned is not undercounted the way a fixed
* frame-to-frame dt would. A pid with no history, a counter reset (process
* restart reusing the pid), or an empty window yields no rate, never a fake
* one. `nextLastSeen` is the state to carry into the next call.
*/
function diffProcessRates(lastSeen, rows, sampledAt) {
	const at = Date.parse(sampledAt);
	const rates = /* @__PURE__ */ new Map();
	const nextLastSeen = /* @__PURE__ */ new Map();
	if (!Number.isFinite(at)) return {
		rates,
		nextLastSeen
	};
	for (const row of rows) {
		if (row.netRxBytes === null || row.netTxBytes === null) continue;
		nextLastSeen.set(row.pid, {
			at,
			rxBytes: row.netRxBytes,
			txBytes: row.netTxBytes
		});
		const before = lastSeen.get(row.pid);
		if (before === void 0) continue;
		const dtSeconds = (at - before.at) / 1e3;
		if (dtSeconds <= 0 || row.netRxBytes < before.rxBytes || row.netTxBytes < before.txBytes) continue;
		rates.set(row.pid, {
			rxPerSec: (row.netRxBytes - before.rxBytes) / dtSeconds,
			txPerSec: (row.netTxBytes - before.txBytes) / dtSeconds
		});
	}
	return {
		rates,
		nextLastSeen
	};
}
/** Rank rows by the requested key and keep at most `limit`. */
function sortProcesses(rows, sort, limit) {
	const weight = (row) => {
		switch (sort) {
			case "mem": return row.rssBytes;
			case "network": return (row.netRxBytes ?? 0) + (row.netTxBytes ?? 0);
			default: return row.cpuPercent;
		}
	};
	return [...rows].sort((left, right) => weight(right) - weight(left)).slice(0, Math.max(0, limit));
}
/**
* The rows a rate-ranked view needs: the CPU top-N plus every process with a
* network socket that fell outside it, so per-pid rate windows survive a
* process bouncing between views. Socket rows are few (tens), so no cap beyond
* a defensive one.
*/
function unionProcessRows(rows, cpuLimit) {
	const cpuTop = sortProcesses(rows, "cpu", cpuLimit);
	const inTop = new Set(cpuTop.map((row) => row.pid));
	const socketRows = rows.filter((row) => !inTop.has(row.pid) && (row.netRxBytes !== null || row.netTxBytes !== null)).slice(0, 100);
	return [...cpuTop, ...socketRows];
}
/**
* Rank by live network rate (server-derived). Rows without a rate window —
* the first frame, or a just-appeared pid — rank as zero, NOT by their
* cumulative counters: mixing a lifetime total into a rate ranking is exactly
* the misordering this function exists to prevent. A zero-rate frame keeps
* the union's incoming (CPU) order via sort stability.
*/
function sortByNetworkRate(rows, rates, limit) {
	const weight = (row) => {
		const rate = rates.get(row.pid);
		return rate === void 0 ? 0 : rate.rxPerSec + rate.txPerSec;
	};
	return [...rows].sort((left, right) => weight(right) - weight(left)).slice(0, Math.max(0, limit));
}
/** Probe one subcommand, degrading to `fallback` on any failure. */
async function probe(label, fallback, task) {
	try {
		return await task();
	} catch (error) {
		console.warn(`[pc-manager] ${label} probe failed: ${String(error)}`);
		return fallback;
	}
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
async function mergeProcessTable() {
	if (platform() === "win32") return (await probe("windows bundle", null, () => readWindowsBundle(totalmem())))?.processes ?? [];
	const onLinux = platform() === "linux";
	const psColumns = onLinux ? "pid,pcpu,pmem,rss,args" : "pid,pcpu,pmem,rss,comm";
	const [psRows, netRows, gpuRows] = await Promise.all([
		probe("ps", [], async () => {
			const { stdout } = await run("ps", ["-Ao", psColumns], { timeout: EXEC_TIMEOUT_MS });
			return parsePs(stdout);
		}),
		platform() === "darwin" ? probe("nettop", /* @__PURE__ */ new Map(), async () => {
			const { stdout } = await run("nettop", [
				"-P",
				"-L",
				"1",
				"-n",
				"-J",
				"bytes_in,bytes_out"
			], { timeout: EXEC_TIMEOUT_MS });
			return parseNettop(stdout);
		}) : onLinux && canAttributeSockets() ? probe("ss", /* @__PURE__ */ new Map(), async () => {
			const { stdout } = await run("ss", ["-tinp"], { timeout: EXEC_TIMEOUT_MS });
			return parseSsTinp(stdout);
		}) : Promise.resolve(/* @__PURE__ */ new Map()),
		onLinux ? probe("nvidia pmon", /* @__PURE__ */ new Map(), async () => {
			if (!await hasNvidiaSmi()) return /* @__PURE__ */ new Map();
			const { stdout } = await run("nvidia-smi", [
				"pmon",
				"-c",
				"1"
			], { timeout: EXEC_TIMEOUT_MS });
			return parseNvidiaSmiPmon(stdout);
		}) : Promise.resolve(/* @__PURE__ */ new Map())
	]);
	return mergeGpuPercent(mergeProcesses(psRows, netRows), gpuRows);
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
async function collectStatus(maxTop = 10, sort = "cpu", extras) {
	const plat = platform();
	const onLinux = plat === "linux";
	const onWindows = plat === "win32";
	const cpuStart = cpus();
	const startedAt = Date.now();
	const diskstatsStart = onLinux ? await probe("diskstats", null, readDiskstats) : null;
	const [windowsBundle, posixDisks, mergedProcessTable, posixNetwork, gpuPercent, iostatPerSec, pmsetBattery, ioregBattery, swap, vmstat, osVersionProbe, meminfo, linuxBattery, linuxTemp, publicIp] = await Promise.all([
		onWindows ? probe("windows bundle", null, () => readWindowsBundle(totalmem())) : Promise.resolve(null),
		onWindows ? Promise.resolve([]) : probe("df", [], async () => {
			const { stdout } = await run("df", ["-k"], { timeout: EXEC_TIMEOUT_MS });
			return parseDf(stdout);
		}),
		onWindows ? Promise.resolve([]) : mergeProcessTable(),
		onWindows ? Promise.resolve([]) : onLinux ? probe("netdev", [], async () => parseProcNetDev(await readFile("/proc/net/dev", "utf8"))) : probe("netstat", [], async () => {
			const { stdout } = await run("netstat", ["-ib"], { timeout: EXEC_TIMEOUT_MS });
			return parseNetstatIb(stdout);
		}),
		onLinux || onWindows ? probe("gpu nvidia-smi", null, async () => {
			if (!await hasNvidiaSmi()) return null;
			const { stdout } = await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], { timeout: EXEC_TIMEOUT_MS });
			return parseNvidiaSmiGpu(stdout);
		}) : probe("gpu ioreg", null, async () => {
			const { stdout } = await run("ioreg", [
				"-r",
				"-d",
				"1",
				"-c",
				"IOAccelerator"
			], { timeout: EXEC_TIMEOUT_MS });
			return parseIoregGpu(stdout);
		}),
		onLinux || onWindows ? Promise.resolve(null) : probe("iostat", null, async () => {
			const { stdout } = await run("iostat", [
				"-d",
				"-c",
				"2"
			], { timeout: EXEC_TIMEOUT_MS });
			return parseIostat(stdout);
		}),
		onLinux || onWindows ? Promise.resolve(null) : probe("pmset", null, async () => {
			const { stdout } = await run("pmset", ["-g", "batt"], { timeout: EXEC_TIMEOUT_MS });
			return parsePmsetBatt(stdout);
		}),
		onLinux || onWindows ? Promise.resolve(null) : probe("battery ioreg", null, async () => {
			const { stdout } = await run("ioreg", ["-rn", "AppleSmartBattery"], { timeout: EXEC_TIMEOUT_MS });
			return parseIoregBattery(stdout);
		}),
		onLinux || onWindows ? Promise.resolve(null) : probe("swapusage", null, async () => {
			const { stdout } = await run("sysctl", ["-n", "vm.swapusage"], { timeout: EXEC_TIMEOUT_MS });
			return parseSwapUsage(stdout);
		}),
		onLinux || onWindows ? Promise.resolve(null) : probe("vm_stat", null, async () => {
			const { stdout } = await run("vm_stat", [], { timeout: EXEC_TIMEOUT_MS });
			return parseVmStat(stdout);
		}),
		onWindows ? Promise.resolve(windowsOsVersion()) : onLinux ? probe("os-release", null, async () => parseOsRelease(await readFile("/etc/os-release", "utf8"))) : probe("sw_vers", null, async () => {
			const { stdout } = await run("sw_vers", ["-productVersion"], { timeout: EXEC_TIMEOUT_MS });
			const value = stdout.trim();
			return value.length > 0 ? value : null;
		}),
		onLinux ? probe("meminfo", null, async () => parseMeminfo(await readFile("/proc/meminfo", "utf8"))) : Promise.resolve(null),
		onLinux ? probe("power_supply", null, readLinuxBattery) : Promise.resolve(null),
		onLinux ? probe("cpu temp", null, readLinuxCpuTemp) : Promise.resolve(null),
		extras?.ipGeo === void 0 || extras.ipGeo === null ? Promise.resolve(null) : probe("ip-geo", null, extras.ipGeo)
	]);
	const disks = onWindows ? windowsBundle?.volumes ?? [] : posixDisks;
	const network = onWindows ? windowsBundle?.network ?? [] : posixNetwork;
	const processTable = onWindows ? windowsBundle?.processes ?? [] : mergedProcessTable;
	const gpuUsagePercent = onWindows ? windowsBundle?.gpu.totalPercent ?? gpuPercent : gpuPercent;
	const osVersion = onWindows ? windowsBundle?.osCaption ?? osVersionProbe : osVersionProbe;
	const elapsed = Date.now() - startedAt;
	const minWindowMs = onLinux ? DISKSTAT_SAMPLE_MS : CPU_SAMPLE_MS;
	if (elapsed < minWindowMs) await delay(minWindowMs - elapsed);
	const cpuEnd = cpus();
	let diskIoPerSec = onWindows ? windowsBundle?.diskBytesPerSec ?? null : iostatPerSec;
	if (onLinux && diskstatsStart !== null) {
		const end = await probe("diskstats end", null, readDiskstats);
		if (end !== null) diskIoPerSec = diskstatRate(diskstatsStart, end);
	}
	const total = totalmem();
	const fallbackUsed = total - freemem();
	let usedBytes = fallbackUsed;
	let appMemoryBytes = 0;
	let wiredBytes = null;
	let compressedBytes = null;
	let cachedBytes = null;
	let purgeableBytes = null;
	let swapTotalBytes = null;
	let swapUsedBytes = null;
	if (vmstat !== null) {
		const vmUsed = vmstat.activeBytes + vmstat.wiredBytes + vmstat.compressedBytes;
		usedBytes = vmUsed > 0 ? Math.min(vmUsed, total) : fallbackUsed;
		appMemoryBytes = vmstat.activeBytes;
		wiredBytes = vmstat.wiredBytes;
		compressedBytes = vmstat.compressedBytes;
		cachedBytes = vmstat.inactiveBytes + vmstat.speculativeBytes;
		purgeableBytes = vmstat.purgeableBytes;
		swapTotalBytes = swap?.totalBytes ?? null;
		swapUsedBytes = swap?.usedBytes ?? null;
	}
	if (meminfo !== null) {
		usedBytes = meminfo.usedBytes;
		appMemoryBytes = meminfo.anonPagesBytes;
		wiredBytes = meminfo.sUnreclaimBytes;
		compressedBytes = null;
		cachedBytes = meminfo.cachedBytes;
		swapTotalBytes = meminfo.swapTotalBytes;
		swapUsedBytes = meminfo.swapTotalBytes > 0 ? meminfo.swapTotalBytes - meminfo.swapFreeBytes : 0;
	}
	if (windowsBundle !== null) {
		const available = windowsBundle.availableBytes;
		usedBytes = available === null || available > total ? fallbackUsed : total - available;
		wiredBytes = windowsBundle.poolNonpagedBytes;
		cachedBytes = windowsBundle.cacheBytes;
		appMemoryBytes = Math.max(0, usedBytes - (wiredBytes ?? 0));
		compressedBytes = null;
		purgeableBytes = null;
		swapTotalBytes = windowsBundle.pageFileTotalBytes;
		swapUsedBytes = windowsBundle.pageFileUsedBytes;
	}
	const battery = onWindows ? windowsBundle?.battery ?? null : onLinux ? linuxBattery : pmsetBattery === null && ioregBattery === null ? null : {
		percent: pmsetBattery?.percent ?? null,
		charging: pmsetBattery?.charging ?? null,
		powerSource: pmsetBattery?.powerSource ?? null,
		timeRemainingMinutes: pmsetBattery?.timeRemainingMinutes ?? null,
		cycleCount: ioregBattery?.cycleCount ?? null,
		healthPercent: ioregBattery?.healthPercent ?? null
	};
	extras?.onProcessTable?.(processTable);
	return {
		platform: plat,
		hostname: hostname(),
		osVersion,
		uptimeSeconds: uptime(),
		cpu: {
			model: cpuEnd[0]?.model ?? "unknown",
			cores: cpuEnd.length,
			usagePercent: cpuUsagePercent(cpuStart, cpuEnd),
			loadavg: onWindows ? null : [
				loadavg()[0],
				loadavg()[1],
				loadavg()[2]
			],
			temperatureCelsius: onWindows ? windowsBundle?.temperatureCelsius ?? null : linuxTemp
		},
		gpu: {
			usagePercent: gpuUsagePercent,
			name: onWindows ? windowsBundle?.gpu.name ?? null : null
		},
		memory: {
			totalBytes: total,
			usedBytes,
			appMemoryBytes,
			wiredBytes,
			compressedBytes,
			cachedBytes,
			purgeableBytes,
			swapTotalBytes,
			swapUsedBytes
		},
		diskIo: { totalBytesPerSec: diskIoPerSec },
		disks,
		battery,
		network,
		localIps: pickLocalAddresses(networkInterfaces()),
		publicIp,
		topProcesses: sortProcesses(processTable, sort, maxTop),
		sampledAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/types.ts
/** Typed domain error; tools translate it into a {@link PcErrorValue}. */
var PcManagerError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "PcManagerError";
	}
};
//#endregion
//#region src/junk.ts
/**
* System junk cleanup (垃圾清理) for macOS, Linux, and Windows hosts. The
* target registries (one per platform) are the core safety asset — which paths
* count as junk, why, and how safe they are — while scanJunk (size walk,
* always dry-run) and cleanJunk (validation chain plus Trash-first reclaim)
* are the executors. Pure node:fs, zero cordis, so the module stays
* unit-testable outside the harness.
* @module @deepseek-ai/dsh-pc-manager
*/
/** Flavor of one literal: a drive-absolute or UNC path is Windows, else POSIX. */
function pathFlavor(path) {
	return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path) ? "win32" : "posix";
}
/** The `node:path` face for a flavor. */
const apiFor = (flavor) => flavor === "win32" ? win32 : posix;
/** Windows filesystems are case-insensitive; POSIX ones are not. */
const foldCase = (flavor, value) => flavor === "win32" ? value.toLowerCase() : value;
/**
* Normalize with the literal's own flavor, dropping a trailing separator
* (except at a root). The strip is a safety property, not cosmetics: without
* it `user-caches:/Users/x/.cache/` normalizes to the root itself yet still
* satisfies the "strictly under the root" test that guards children-kind
* deletion, which would let a trailing slash empty a whole registry root.
*/
function normalizePath(path) {
	return normalizeLiteral(apiFor(pathFlavor(path)), path);
}
/** Normalization body, shared by the flavor-detecting entry point and the
* flavor-injected helpers below. */
function normalizeLiteral(api, value) {
	const normalized = api.normalize(value);
	const root = api.parse(normalized).root;
	return normalized.length > root.length && normalized.endsWith(api.sep) ? normalized.slice(0, -1) : normalized;
}
/** Join with the base literal's flavor, so `/Users/t` + `.Trash` stays POSIX
* even on a Windows host, and a Windows base keeps its backslashes. */
function joinPath(base, ...parts) {
	return apiFor(pathFlavor(base)).join(base, ...parts);
}
/** True when the literal is absolute in its own flavor (POSIX `/…`, Windows
* `C:\…`/`C:/…`, or a UNC share). */
function isAbsolutePath(path) {
	return apiFor(pathFlavor(path)).isAbsolute(path);
}
/** Basename in the literal's own flavor (`C:\a\b` → `b` on any host). */
function basenamePath(path) {
	return apiFor(pathFlavor(path)).basename(path);
}
/** Every junk kind the registry (and the tool schema) knows; closed vocabulary. */
const JUNK_KINDS = [
	"trash",
	"user-caches",
	"user-logs",
	"system-temp",
	"xcode-derived-data",
	"xcode-archives",
	"xcode-ios-device-support",
	"xcode-simulator-caches",
	"simulator-unavailable-devices",
	"npm-cache",
	"pnpm-store",
	"homebrew-cache",
	"pip-cache",
	"uv-cache",
	"yarn-cache",
	"go-build-cache",
	"go-mod-cache",
	"ios-backups"
];
/**
* Sensitive-cache protection list for macOS `~/Library/Caches`: "caches" that
* hold non-regenerable state (password vaults, IDE indexes, input-method
* lexicons, VPN configs, sync clients, AI apps). Self-built — concept
* references only.
*/
const PROTECTED_CHILDREN = [
	"com.1password.",
	"com.agilebits.",
	"com.bitwarden.",
	"com.keepassx.",
	"org.keepassxc.",
	"com.lastpass.",
	"com.dashlane.",
	"com.jetbrains.",
	"com.microsoft.VSCode",
	"com.visualstudio.code.",
	"com.sublimetext.",
	"im.rime.",
	"com.sogou.inputmethod.",
	"com.baidu.inputmethod.",
	"*.inputmethod",
	"com.wireguard.",
	"io.tailscale.",
	"com.zerotier.",
	"net.openvpn.",
	"*clash*",
	"*Clash*",
	"com.dropbox.",
	"com.getdropbox.",
	"com.google.GoogleDrive",
	"com.microsoft.OneDrive",
	"com.anthropic.claude",
	"com.openai.chat",
	"com.ollama.",
	"page.jan.jan"
];
/**
* The same protection concept for Linux `~/.cache`, where directories are
* named after the app (XDG convention) instead of a reverse-DNS bundle id.
* Over-blocking is the safe direction: rules are prefixes.
*/
const LINUX_PROTECTED_CHILDREN = [
	"1password",
	"bitwarden",
	"keepass",
	"keepassxc",
	"lastpass",
	"dashlane",
	"jetbrains",
	"vscode",
	"Code",
	"sublime-text",
	"sublime",
	"fcitx",
	"ibus",
	"rime",
	"clash",
	"Clash",
	"tailscale",
	"Tailscale",
	"openvpn",
	"OpenVPN",
	"wireguard",
	"WireGuard",
	"zerotier",
	"mullvad",
	"dropbox",
	"Dropbox",
	"onedrive",
	"OneDrive",
	"google-drive",
	"nextcloud",
	"syncthing",
	"ollama",
	"jan",
	"lm-studio",
	"claude",
	"Claude"
];
/**
* Endpoint-security (EDR) prefixes for `system-temp`: deleting an enterprise
* agent's cache triggers tamper alerts (e.g. CrowdStrike Falcon sensor), which
* IT reads as a security incident. Protected unconditionally.
*/
const EDR_PROTECTED_PREFIXES = [
	"com.crowdstrike.",
	"com.sentinelone.",
	"com.sentinel-labs.",
	"com.eset.",
	"com.jamf.",
	"com.jamfsoftware.",
	"com.paloaltonetworks.",
	"com.cisco.anyconnect",
	"com.cisco.secureclient"
];
/**
* Linux `system-temp` protections: live systemd/snap private dirs under /tmp
* and /var/tmp belong to running services, and Linux EDR agents (falcon,
* sentinelone, defender…) trip tamper alerts like their macOS peers.
*/
const LINUX_TEMP_PROTECTED = [
	"systemd-private-",
	"snap-private-tmp",
	"falcon",
	"crowdstrike",
	"sentinelone",
	"s1agent",
	"carbonblack",
	"cb-defense",
	"mde",
	"sophos",
	"defender"
];
/**
* Windows `system-temp` protections. `%TEMP%` and `%SystemRoot%\Temp` are
* shared by every process on the box, so live installer scaffolding is
* skipped (deleting a directory another process is using fails or breaks the
* install) and endpoint-security agents are protected for the same
* tamper-alert reason as the macOS/Linux lists.
*/
const WINDOWS_TEMP_PROTECTED = [
	"CrowdStrike",
	"CSFalcon",
	"SentinelOne",
	"Sentinel",
	"Sophos",
	"Tanium",
	"CarbonBlack",
	"CbDefense",
	"mde",
	"MsMpEng",
	"MpCmdRun",
	"MpEngine",
	"Defender",
	"avast",
	"AVG",
	"ESET",
	"Kaspersky",
	"scoped_dir",
	"chrome_installer",
	"VSIXInstaller",
	"Microsoft Visual Studio",
	"Roslyn"
];
/**
* Well-known Windows account SIDs whose Recycle Bin folders are never the
* current user's: LocalSystem, LocalService, and NetworkService. Other users'
* SID folders are not listed — they are unreadable from this account and
* degrade to `skipped` through the walk instead.
*/
const WINDOWS_SYSTEM_SIDS = [
	"S-1-5-18",
	"S-1-5-19",
	"S-1-5-20"
];
/**
* Match one first-level child name against a protection rule: a plain rule is
* a prefix, `*suffix` a suffix, `*infix*` a substring (case-sensitive).
*/
function matchesProtectedRule(name, rule) {
	if (rule.startsWith("*") && rule.endsWith("*") && rule.length > 2) return name.includes(rule.slice(1, -1));
	if (rule.startsWith("*")) return name.endsWith(rule.slice(1));
	if (rule.endsWith("*")) return name.startsWith(rule.slice(0, -1));
	return name.startsWith(rule);
}
/**
* macOS junk families, 18 kinds over 19 rows (`system-temp` has two roots).
* `safeToClean: false` rows are reported by scan but refused by clean, with a
* suggested command in the rationale.
*/
const JUNK_TARGETS_DARWIN = [
	{
		kind: "trash",
		label: "废纸篓 (~/.Trash)",
		dir: "~/.Trash",
		safeToClean: true,
		rationale: "Files the user already discarded; emptying is the normal Trash operation. Whole-root granularity also keeps individual trashed file names private.",
		granularity: "whole"
	},
	{
		kind: "user-caches",
		label: "用户缓存 (~/Library/Caches)",
		dir: "~/Library/Caches",
		safeToClean: true,
		rationale: "Per-app caches that apps rebuild on demand. Sensitive caches (password managers, IDEs, input methods, VPN, sync clients) are excluded by the protected-children list.",
		granularity: "children",
		protectedChildren: PROTECTED_CHILDREN
	},
	{
		kind: "user-logs",
		label: "用户日志 (~/Library/Logs)",
		dir: "~/Library/Logs",
		safeToClean: true,
		rationale: "Rotated logs and DiagnosticReports crash reports; recent diagnostics keep a copy in system logs.",
		granularity: "children"
	},
	{
		kind: "system-temp",
		label: "系统临时文件 (/private/tmp)",
		dir: "/private/tmp",
		safeToClean: true,
		rationale: "Active temporary files must not move; only children untouched for at least 3 days are reported. Endpoint-security agent directories are excluded (deleting them triggers tamper alerts).",
		granularity: "children",
		minAgeDays: 3,
		protectedChildren: EDR_PROTECTED_PREFIXES
	},
	{
		kind: "system-temp",
		label: "系统临时缓存 (/private/var/folders)",
		dir: "/private/var/folders/*/*/C",
		safeToClean: true,
		rationale: "Per-user temporary cache trees (the `C` subtrees of var/folders); only children untouched for at least 3 days are reported. Endpoint-security agent directories are excluded.",
		granularity: "children",
		minAgeDays: 3,
		protectedChildren: EDR_PROTECTED_PREFIXES
	},
	{
		kind: "xcode-derived-data",
		label: "Xcode 构建产物 (DerivedData)",
		dir: "~/Library/Developer/Xcode/DerivedData",
		safeToClean: true,
		rationale: "Build artifacts; the next build regenerates them.",
		granularity: "children"
	},
	{
		kind: "xcode-archives",
		label: "Xcode 归档 (Archives)",
		dir: "~/Library/Developer/Xcode/Archives",
		safeToClean: true,
		rationale: "Signed release archives and dSYM symbols — NOT regenerable. After deletion the Xcode Organizer can no longer symbolicate those historical crashes; restate this cost when confirming.",
		granularity: "children"
	},
	{
		kind: "xcode-ios-device-support",
		label: "iOS 设备支持符号 (iOS DeviceSupport)",
		dir: "~/Library/Developer/Xcode/iOS DeviceSupport",
		safeToClean: true,
		rationale: "Device symbol caches; re-downloaded when an old device reconnects.",
		granularity: "children"
	},
	{
		kind: "xcode-simulator-caches",
		label: "模拟器缓存 (CoreSimulator/Caches)",
		dir: "~/Library/Developer/CoreSimulator/Caches",
		safeToClean: true,
		rationale: "Simulator runtime caches; rebuilt on demand.",
		granularity: "whole"
	},
	{
		kind: "simulator-unavailable-devices",
		label: "不可用模拟器 (CoreSimulator/Devices)",
		dir: "~/Library/Developer/CoreSimulator/Devices",
		safeToClean: false,
		rationale: "Simulator device records CoreSimulator keeps metadata for; deleting raw directories desyncs its database. Run `xcrun simctl delete unavailable` instead.",
		granularity: "children"
	},
	{
		kind: "npm-cache",
		label: "npm 缓存 (~/.npm/_cacache)",
		dir: "~/.npm/_cacache",
		safeToClean: true,
		rationale: "Content-addressed tarball cache; `npm cache clean --force` equivalent. Sibling `_logs`/`_npx` are deliberately left alone.",
		granularity: "whole"
	},
	{
		kind: "pnpm-store",
		label: "pnpm 内容存储 (~/Library/pnpm/store)",
		dir: "~/Library/pnpm/store",
		safeToClean: false,
		rationale: "Hard-link source for every installed dependency; direct deletion breaks linked node_modules. Run `pnpm store prune` instead.",
		granularity: "children"
	},
	{
		kind: "homebrew-cache",
		label: "Homebrew 下载缓存",
		dir: "~/Library/Caches/Homebrew",
		safeToClean: true,
		rationale: "Downloaded bottles; `brew cleanup` equivalent.",
		granularity: "children"
	},
	{
		kind: "pip-cache",
		label: "pip 缓存",
		dir: "~/Library/Caches/pip",
		safeToClean: true,
		rationale: "Wheel download cache; rebuilt on demand.",
		granularity: "whole"
	},
	{
		kind: "uv-cache",
		label: "uv 缓存",
		dir: "~/Library/Caches/uv",
		safeToClean: true,
		rationale: "Wheel and source cache; rebuilt on demand.",
		granularity: "whole"
	},
	{
		kind: "yarn-cache",
		label: "Yarn 缓存",
		dir: "~/Library/Caches/Yarn",
		safeToClean: true,
		rationale: "Yarn 1.x package cache; `yarn cache clean` equivalent (on berry installs run that command).",
		granularity: "whole"
	},
	{
		kind: "go-build-cache",
		label: "Go 构建缓存",
		dir: "~/Library/Caches/go-build",
		safeToClean: true,
		rationale: "Compiled package cache; rebuilt on demand.",
		granularity: "whole"
	},
	{
		kind: "go-mod-cache",
		label: "Go 模块缓存",
		dir: "~/go/pkg/mod/cache",
		safeToClean: true,
		rationale: "Downloaded module cache (conservative subtree of ~/go/pkg/mod); re-downloaded on demand.",
		granularity: "whole"
	},
	{
		kind: "ios-backups",
		label: "iOS 设备备份 (MobileSync/Backup)",
		dir: "~/Library/Application Support/MobileSync/Backup",
		safeToClean: true,
		rationale: "Full iPhone/iPad backups — NOT regenerable. One subdirectory per device: restate each device folder by name when confirming. Trash by default keeps them recoverable.",
		granularity: "children"
	}
];
/** The current platform's registry (the safety asset the tools scan); an
* unknown platform falls back to the macOS registry so a scan on an
* unsupported host still enumerates something reviewable. */
const JUNK_TARGETS = {
	darwin: JUNK_TARGETS_DARWIN,
	linux: [
		{
			kind: "trash",
			label: "回收站 (~/.local/share/Trash)",
			dir: "~/.local/share/Trash",
			safeToClean: true,
			rationale: "Files the user already discarded (freedesktop trash); emptying is the normal trash operation. Whole-root granularity also keeps individual trashed file names private.",
			granularity: "whole"
		},
		{
			kind: "user-caches",
			label: "用户缓存 (~/.cache)",
			dir: "~/.cache",
			safeToClean: true,
			rationale: "XDG per-app caches that apps rebuild on demand (including ~/.cache/thumbnails, which the file manager regenerates). Sensitive caches (password managers, IDEs, input methods, VPN, sync clients) are excluded by the protected-children list.",
			granularity: "children",
			protectedChildren: LINUX_PROTECTED_CHILDREN
		},
		{
			kind: "system-temp",
			label: "系统临时文件 (/tmp)",
			dir: "/tmp",
			safeToClean: true,
			rationale: "Active temporary files must not move; only children untouched for at least 3 days are reported. systemd private dirs (systemd-private-*) and snap-private-tmp belong to running services and are excluded, as are endpoint-security agent directories (deleting them triggers tamper alerts).",
			granularity: "children",
			minAgeDays: 3,
			protectedChildren: LINUX_TEMP_PROTECTED
		},
		{
			kind: "system-temp",
			label: "系统临时文件 (/var/tmp)",
			dir: "/var/tmp",
			safeToClean: true,
			rationale: "Persistent temporary files (survive reboots by convention); only children untouched for at least 3 days are reported, with the same live-service and endpoint-security exclusions as /tmp.",
			granularity: "children",
			minAgeDays: 3,
			protectedChildren: LINUX_TEMP_PROTECTED
		},
		{
			kind: "npm-cache",
			label: "npm 缓存 (~/.npm/_cacache)",
			dir: "~/.npm/_cacache",
			safeToClean: true,
			rationale: "Content-addressed tarball cache; `npm cache clean --force` equivalent. Sibling `_logs`/`_npx` are deliberately left alone.",
			granularity: "whole"
		},
		{
			kind: "pnpm-store",
			label: "pnpm 内容存储 (~/.local/share/pnpm/store)",
			dir: "~/.local/share/pnpm/store",
			safeToClean: false,
			rationale: "Hard-link source for every installed dependency; direct deletion breaks linked node_modules. Run `pnpm store prune` instead.",
			granularity: "children"
		},
		{
			kind: "homebrew-cache",
			label: "Homebrew 下载缓存 (~/.cache/Homebrew)",
			dir: "~/.cache/Homebrew",
			safeToClean: true,
			rationale: "Downloaded bottles (Linuxbrew); `brew cleanup` equivalent.",
			granularity: "children"
		},
		{
			kind: "pip-cache",
			label: "pip 缓存 (~/.cache/pip)",
			dir: "~/.cache/pip",
			safeToClean: true,
			rationale: "Wheel download cache; rebuilt on demand.",
			granularity: "whole"
		},
		{
			kind: "uv-cache",
			label: "uv 缓存 (~/.cache/uv)",
			dir: "~/.cache/uv",
			safeToClean: true,
			rationale: "Wheel and source cache; rebuilt on demand.",
			granularity: "whole"
		},
		{
			kind: "yarn-cache",
			label: "Yarn 缓存 (~/.cache/yarn)",
			dir: "~/.cache/yarn",
			safeToClean: true,
			rationale: "Yarn 1.x package cache; `yarn cache clean` equivalent (on berry installs run that command).",
			granularity: "whole"
		},
		{
			kind: "go-build-cache",
			label: "Go 构建缓存 (~/.cache/go-build)",
			dir: "~/.cache/go-build",
			safeToClean: true,
			rationale: "Compiled package cache; rebuilt on demand.",
			granularity: "whole"
		},
		{
			kind: "go-mod-cache",
			label: "Go 模块缓存 (~/go/pkg/mod/cache)",
			dir: "~/go/pkg/mod/cache",
			safeToClean: true,
			rationale: "Downloaded module cache (conservative subtree of ~/go/pkg/mod); re-downloaded on demand.",
			granularity: "whole"
		}
	],
	win32: [
		{
			kind: "trash",
			label: "回收站 ($Recycle.Bin)",
			dir: "%SystemDrive%\\$Recycle.Bin",
			safeToClean: true,
			rationale: "Files the user already discarded. Windows keeps one folder per account SID; this account's folder is emptied in place (the local Recycle Bin operation). LocalSystem/LocalService/NetworkService folders are excluded, and another account's folder is unreadable and reported as skipped instead.",
			granularity: "children",
			protectedChildren: WINDOWS_SYSTEM_SIDS
		},
		{
			kind: "system-temp",
			label: "用户临时文件 (%TEMP%)",
			dir: "%TEMP%",
			safeToClean: true,
			rationale: "Per-user temporary files; apps recreate them on demand. Only children untouched for at least 3 days are reported, and live installer scaffolding plus endpoint-security agent directories are excluded (deleting them breaks a running install or trips tamper alerts).",
			granularity: "children",
			minAgeDays: 3,
			protectedChildren: WINDOWS_TEMP_PROTECTED
		},
		{
			kind: "system-temp",
			label: "系统临时文件 (%SystemRoot%\\Temp)",
			dir: "%SystemRoot%\\Temp",
			safeToClean: true,
			rationale: "Machine-wide temporary files. Only children untouched for at least 3 days are reported, with the same live-installer and endpoint-security exclusions as %TEMP%. Writing here generally needs an elevated process, so expect unreadable children to be skipped.",
			granularity: "children",
			minAgeDays: 3,
			protectedChildren: WINDOWS_TEMP_PROTECTED
		},
		{
			kind: "user-logs",
			label: "错误报告存档 (%LOCALAPPDATA%\\…\\WER\\ReportArchive)",
			dir: "%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportArchive",
			safeToClean: true,
			rationale: "Windows Error Reporting crash archives; diagnostic copies that no longer serve a purpose once reported. Regenerated only by new crashes.",
			granularity: "children"
		},
		{
			kind: "user-logs",
			label: "错误报告队列 (%LOCALAPPDATA%\\…\\WER\\ReportQueue)",
			dir: "%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportQueue",
			safeToClean: true,
			rationale: "Windows Error Reporting entries still queued for upload; reports already sent live in the archive. Regenerated only by new crashes.",
			granularity: "children"
		},
		{
			kind: "user-logs",
			label: "崩溃转储 (%LOCALAPPDATA%\\CrashDumps)",
			dir: "%LOCALAPPDATA%\\CrashDumps",
			safeToClean: true,
			rationale: "Post-mortem process dumps written by WER; useful only while debugging a crash that is being investigated right now.",
			granularity: "children"
		},
		{
			kind: "user-caches",
			label: "WinINet 缓存 (%LOCALAPPDATA%\\…\\INetCache)",
			dir: "%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache",
			safeToClean: true,
			rationale: "The system-wide WinINet download cache shared by apps that use the Windows HTTP stack; refetched on demand. (Cookies live in the sibling INetCookies tree and are not touched.)",
			granularity: "children"
		},
		{
			kind: "user-caches",
			label: "DirectX 着色器缓存 (%LOCALAPPDATA%\\D3DSCache)",
			dir: "%LOCALAPPDATA%\\D3DSCache",
			safeToClean: true,
			rationale: "Compiled shader cache; games recompile it on first launch, costing a one-time stutter rather than data.",
			granularity: "children"
		},
		{
			kind: "user-caches",
			label: "NVIDIA 着色器缓存 (%LOCALAPPDATA%\\NVIDIA\\DXCache)",
			dir: "%LOCALAPPDATA%\\NVIDIA\\DXCache",
			safeToClean: true,
			rationale: "DirectX shader cache written by the NVIDIA driver; rebuilt on demand.",
			granularity: "children"
		},
		{
			kind: "user-caches",
			label: "NVIDIA OpenGL 缓存 (%LOCALAPPDATA%\\NVIDIA\\GLCache)",
			dir: "%LOCALAPPDATA%\\NVIDIA\\GLCache",
			safeToClean: true,
			rationale: "OpenGL shader cache written by the NVIDIA driver; rebuilt on demand.",
			granularity: "children"
		},
		{
			kind: "user-caches",
			label: "远程桌面缓存 (%LOCALAPPDATA%\\…\\Terminal Server Client\\Cache)",
			dir: "%LOCALAPPDATA%\\Microsoft\\Terminal Server Client\\Cache",
			safeToClean: true,
			rationale: "Remote Desktop bitmap cache; rebuilt as the session redraws.",
			granularity: "children"
		},
		{
			kind: "npm-cache",
			label: "npm 缓存 (%LOCALAPPDATA%\\npm-cache)",
			dir: "%LOCALAPPDATA%\\npm-cache",
			safeToClean: true,
			rationale: "Content-addressed tarball cache on Windows (npm's `_cacache` equivalent); `npm cache clean --force` equivalent.",
			granularity: "whole"
		},
		{
			kind: "pnpm-store",
			label: "pnpm 内容存储 (%LOCALAPPDATA%\\pnpm\\store)",
			dir: "%LOCALAPPDATA%\\pnpm\\store",
			safeToClean: false,
			rationale: "Hard-link source for every installed dependency; direct deletion breaks linked node_modules. Run `pnpm store prune` instead.",
			granularity: "children"
		},
		{
			kind: "pip-cache",
			label: "pip 缓存 (%LOCALAPPDATA%\\pip\\Cache)",
			dir: "%LOCALAPPDATA%\\pip\\Cache",
			safeToClean: true,
			rationale: "Wheel download cache; rebuilt on demand.",
			granularity: "whole"
		},
		{
			kind: "uv-cache",
			label: "uv 缓存 (%LOCALAPPDATA%\\uv\\cache)",
			dir: "%LOCALAPPDATA%\\uv\\cache",
			safeToClean: true,
			rationale: "Wheel and source cache; rebuilt on demand.",
			granularity: "whole"
		},
		{
			kind: "yarn-cache",
			label: "Yarn 缓存 (%LOCALAPPDATA%\\Yarn\\Cache)",
			dir: "%LOCALAPPDATA%\\Yarn\\Cache",
			safeToClean: true,
			rationale: "Yarn 1.x package cache; `yarn cache clean` equivalent (on berry installs run that command).",
			granularity: "whole"
		},
		{
			kind: "go-build-cache",
			label: "Go 构建缓存 (%LOCALAPPDATA%\\go-build)",
			dir: "%LOCALAPPDATA%\\go-build",
			safeToClean: true,
			rationale: "Compiled package cache; rebuilt on demand.",
			granularity: "whole"
		},
		{
			kind: "go-mod-cache",
			label: "Go 模块缓存 (%USERPROFILE%\\go\\pkg\\mod\\cache)",
			dir: "%USERPROFILE%\\go\\pkg\\mod\\cache",
			safeToClean: true,
			rationale: "Downloaded module cache (conservative subtree of %USERPROFILE%\\go\\pkg\\mod); re-downloaded on demand.",
			granularity: "whole"
		}
	]
}[platform()] ?? JUNK_TARGETS_DARWIN;
/**
* Kinds whose deletion costs non-regenerable data (§3.2 ✅* rows): excluded
* from the recommended pre-selection — the UI shows them unchecked by default.
*/
const NON_REGENERABLE_KINDS = ["xcode-archives", "ios-backups"];
/**
* The pre-checked cleanup plan for one registry (§16.2): every safe-to-clean
* kind minus the non-regenerable ones, items at or above 1 MiB. Safety-policy
* data in the registry's own league — not a Config knob.
*/
function computeRecommendedPlan(targets = JUNK_TARGETS) {
	const kinds = JUNK_KINDS.filter((kind) => {
		const rows = targets.filter((target) => target.kind === kind);
		return rows.length > 0 && rows.every((row) => row.safeToClean) && !NON_REGENERABLE_KINDS.includes(kind);
	});
	return Object.freeze({
		kinds: Object.freeze(kinds),
		minItemBytes: 1048576
	});
}
/** The current platform's pre-checked cleanup plan. */
const RECOMMENDED_PLAN = computeRecommendedPlan();
/** True when the UI plan card pre-checks this item. */
function isRecommendedItem(item) {
	return RECOMMENDED_PLAN.kinds.includes(item.kind) && item.sizeBytes >= RECOMMENDED_PLAN.minItemBytes;
}
/**
* Blocked POSIX system paths (defense in depth above root containment,
* guarding against future registry misconfiguration). The list is the UNION
* of the macOS and Linux red lines — blocking an extra system tree can only
* refuse more, never allow more. `$HOME` and `~/Library` block equality only —
* their descendants are where junk lives.
*/
const BLOCKED_PREFIXES_POSIX = [
	"/System",
	"/usr",
	"/bin",
	"/sbin",
	"/etc",
	"/boot",
	"/srv",
	"/private/var/db",
	"/private/etc",
	"/Library",
	"/var/log",
	"/var/lib",
	"/var/db",
	"/var/cache",
	"/lib",
	"/lib64",
	"/lib32",
	"/libx32",
	"~/Library/Containers",
	"~/Library/Group Containers"
];
/**
* Blocked Windows system trees. Built from the environment rather than
* hard-coded to `C:` so a machine whose system drive is `D:` (or whose Program
* Files live elsewhere) is still covered; the conventional locations stay as
* fallbacks for a stripped-down environment. `$SystemDrive` itself and the
* Recycle Bin under it are deliberately absent — the drive root is blocked
* separately, and `$Recycle.Bin` is a registry root.
*/
function windowsBlockedPrefixes(env = process.env) {
	const systemDrive = (env.SystemDrive ?? "C:").replace(/[\\/]+$/, "");
	const candidates = [
		env.SystemRoot,
		env.windir,
		`${systemDrive}\\Windows`,
		env.ProgramFiles,
		env.ProgramW6432,
		`${systemDrive}\\Program Files`,
		env["ProgramFiles(x86)"],
		`${systemDrive}\\Program Files (x86)`,
		env.ProgramData,
		`${systemDrive}\\ProgramData`,
		`${systemDrive}\\Recovery`,
		`${systemDrive}\\PerfLogs`,
		`${systemDrive}\\System Volume Information`,
		`${systemDrive}\\Users\\Default`,
		`${systemDrive}\\Users\\Public`,
		`${systemDrive}\\Users\\All Users`
	];
	const seen = /* @__PURE__ */ new Set();
	const prefixes = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate.length === 0) continue;
		const normalized = win32.normalize(candidate);
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		prefixes.push(normalized);
	}
	return prefixes;
}
/** True when `path` is `prefix` or a descendant of it; case-folded on Windows. */
function isAtOrUnder(path, prefix, flavor) {
	const p = foldCase(flavor, apiFor(flavor).normalize(path));
	const b = foldCase(flavor, apiFor(flavor).normalize(prefix));
	if (p === b) return true;
	const sep = flavor === "win32" ? "\\" : "/";
	return p.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}
/** True when a candidate path must never be cleaned, regardless of registry contents. */
function isBlockedPath(path, home, env = process.env) {
	if (pathFlavor(path) === "win32") return isBlockedWindowsPath(path, home, env);
	const p = posix.normalize(path);
	const h = posix.normalize(home);
	if (p === h || p === `${h}/Library` || p === "/Users" || p === "/home") return true;
	for (const blocked of BLOCKED_PREFIXES_POSIX) {
		const b = posix.normalize(blocked.replace(/^~(?=\/)/, h));
		if (p === b || p.startsWith(`${b}/`)) return true;
	}
	for (const usersRoot of ["/Users", "/home"]) if (h.startsWith(`${usersRoot}/`)) {
		if (p.startsWith(`${usersRoot}/`) && !p.startsWith(`${h}/`)) return true;
	} else if (p === usersRoot || p.startsWith(`${usersRoot}/`)) return true;
	if (h !== "/root" && (p === "/root" || p.startsWith("/root/"))) return true;
	return false;
}
/**
* The Windows half of {@link isBlockedPath}: the system trees, the drive roots
* themselves, and every account tree other than `$HOME`. The multi-user rule
* derives the account root from `$HOME`'s parent (rather than assuming
* `C:\Users`) but only when that parent really is an account root, so a home
* directory inside a deeper tree keeps its own descendants cleanable.
*/
function isBlockedWindowsPath(path, home, env) {
	const p = win32.normalize(path);
	const h = win32.normalize(home);
	for (const blocked of windowsBlockedPrefixes(env)) if (isAtOrUnder(p, blocked, "win32")) return true;
	if (p.toLowerCase() === win32.parse(p).root.toLowerCase()) return true;
	if (pathFlavor(home) !== "win32") return false;
	if (p.toLowerCase() === h.toLowerCase()) return true;
	const accountRoot = win32.dirname(h);
	if (!(win32.basename(accountRoot).toLowerCase() === "users")) return false;
	if (p.toLowerCase() === accountRoot.toLowerCase()) return true;
	return isAtOrUnder(p, accountRoot, "win32") && !isAtOrUnder(p, h, "win32");
}
/**
* Expand the placeholders a registry root may carry: a leading `~` becomes
* `home` and `%NAME%` becomes the environment value (Windows roots are spelled
* that way because the profile, the temp directory, and the system drive are
* all relocatable). An unknown `%NAME%` is left verbatim — the root then
* simply does not exist, which yields no items rather than a wrong path.
* Exported for tests and future filters.
*/
function resolveTargets(targets = JUNK_TARGETS, home = homedir(), env = process.env) {
	return targets.map((target) => ({
		...target,
		dir: expandRoot(target.dir, home, env)
	}));
}
/** One registry root through `~`/`%NAME%` expansion. */
function expandRoot(dir, home, env) {
	return dir.replace(/^~(?=[\\/])/, home).replace(/%([^%]+)%/g, (match, name) => env[name] ?? match);
}
/**
* Expand whole-segment `*` globs in target dirs (e.g. the
* `/private/var/folders/<seg>/<seg>/C` pattern spelled with `*` segments)
* into concrete roots via readdir. Absent or permission-denied branches are
* skipped silently: a toolchain that is not installed simply yields no roots.
*/
async function expandGlobs(targets) {
	const expanded = [];
	for (const target of targets) expanded.push(...await expandOneTarget(target));
	return expanded;
}
async function expandOneTarget(target) {
	if (!target.dir.includes("*")) return [target];
	const flavor = pathFlavor(target.dir);
	const api = apiFor(flavor);
	const sep = flavor === "win32" ? "\\" : "/";
	const root = api.parse(target.dir).root;
	let currents = [root];
	for (const segment of target.dir.slice(root.length).split(sep).filter((part) => part.length > 0)) {
		const next = [];
		if (segment !== "*") for (const current of currents) next.push(api.join(current, segment));
		else for (const current of currents) try {
			const entries = await readdir(current, { withFileTypes: true });
			for (const entry of entries) if (entry.isDirectory()) next.push(api.join(current, entry.name));
		} catch (error) {
			const code = error.code;
			if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
			throw error;
		}
		currents = next;
		if (currents.length === 0) return [];
	}
	return currents.map((dir) => ({
		...target,
		dir
	}));
}
/**
* Measure one path (file, symlink, or directory tree): lstat sizes only,
* symlinks never followed, subtree max mtime included. EACCES/EPERM on a
* subtree degrades that subtree (recorded + warned) instead of failing the
* whole walk; ENOENT races are ignored. A missing or unreadable root
* propagates the fs error to the caller. Aborting `signal` fails the walk.
*/
async function measureTree(root, signal) {
	const stat = await lstat(root);
	const measure = {
		sizeBytes: 0,
		fileCount: 0,
		maxMtimeMs: stat.mtimeMs,
		degraded: []
	};
	if (!stat.isDirectory()) {
		measure.sizeBytes = stat.size;
		measure.fileCount = 1;
		return measure;
	}
	await walkDir(root, 0, measure, signal);
	return measure;
}
async function walkDir(dir, depth, measure, signal) {
	if (signal?.aborted) throw new PcManagerError("internal_error", `junk walk aborted at ${dir}`);
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT") return;
		measure.degraded.push({
			path: dir,
			code: code ?? "unknown"
		});
		console.warn(`[pc-manager] junk walk degraded at ${dir}: ${code ?? error}`);
		return;
	}
	for (const entry of entries) {
		const entryPath = joinPath(dir, entry.name);
		let entryStat;
		try {
			entryStat = await lstat(entryPath);
		} catch (error) {
			const code = error.code;
			if (code === "ENOENT") continue;
			measure.degraded.push({
				path: entryPath,
				code: code ?? "unknown"
			});
			console.warn(`[pc-manager] junk walk degraded at ${entryPath}: ${code ?? error}`);
			continue;
		}
		measure.maxMtimeMs = Math.max(measure.maxMtimeMs ?? entryStat.mtimeMs, entryStat.mtimeMs);
		if (entryStat.isDirectory()) {
			if (depth + 1 < 16) await walkDir(entryPath, depth + 1, measure, signal);
			continue;
		}
		measure.sizeBytes += entryStat.size;
		measure.fileCount += 1;
	}
}
/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, task) {
	const results = Array.from({ length: items.length });
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await task(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}
/** Platforms the junk domain supports; everything else is refused whole. */
const SUPPORTED_PLATFORMS = /* @__PURE__ */ new Set([
	"darwin",
	"linux",
	"win32"
]);
function assertSupportedPlatform(plat = platform()) {
	if (!SUPPORTED_PLATFORMS.has(plat)) throw new PcManagerError("unsupported_platform", "junk scan/clean support macOS, Linux, and Windows hosts.");
}
function throwIfAborted(signal, where) {
	if (signal?.aborted) throw new PcManagerError("internal_error", `junk ${where} aborted`);
}
/**
* Enumerate reclaimable junk as a grouped, per-item report. Always a dry run:
* scanning never writes or deletes anything. Missing roots yield no items;
* permission-degraded subtrees and protected children are reported in
* `skipped`; `totalBytes` always equals the sum of the listed items.
*/
async function scanJunk(options = {}, targets = resolveTargets()) {
	assertSupportedPlatform(options.platform ?? platform());
	throwIfAborted(options.signal, "scan");
	const expanded = await expandGlobs(options.kinds === void 0 ? targets : targets.filter((target) => options.kinds?.includes(target.kind)));
	const rootDirs = new Set(expanded.map((target) => target.dir));
	const results = await mapLimit(expanded, 4, (target) => scanOneTarget(target, rootDirs, options.signal));
	const minItemBytes = options.minItemBytes ?? 0;
	const items = results.flatMap((result) => result.items).filter((item) => item.sizeBytes >= minItemBytes).sort((a, b) => b.sizeBytes - a.sizeBytes);
	return {
		items,
		totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
		skipped: results.flatMap((result) => result.skipped),
		scannedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
async function scanOneTarget(target, rootDirs, signal) {
	const items = [];
	const skipped = [];
	let rootStat;
	try {
		rootStat = await lstat(target.dir);
	} catch (error) {
		const code = error.code;
		if (code !== "ENOENT") {
			skipped.push({
				path: target.dir,
				reason: `walk failed: ${code ?? error}`
			});
			console.warn(`[pc-manager] junk walk degraded at ${target.dir}: ${code ?? error}`);
		}
		return {
			items,
			skipped
		};
	}
	if (target.granularity === "whole") {
		const measure = await measureWithSkipped(target.dir, skipped, signal);
		if (measure !== null) items.push({
			id: `${target.kind}:${target.dir}`,
			kind: target.kind,
			label: target.label,
			path: target.dir,
			sizeBytes: measure.sizeBytes,
			fileCount: measure.fileCount,
			safeToClean: target.safeToClean,
			rationale: target.rationale,
			lastModifiedAt: new Date(rootStat.mtimeMs).toISOString()
		});
		return {
			items,
			skipped
		};
	}
	if (!rootStat.isDirectory()) return {
		items,
		skipped
	};
	let entries;
	try {
		entries = await readdir(target.dir, { withFileTypes: true });
	} catch (error) {
		const code = error.code;
		skipped.push({
			path: target.dir,
			reason: `walk failed: ${code ?? error}`
		});
		console.warn(`[pc-manager] junk walk degraded at ${target.dir}: ${code ?? error}`);
		return {
			items,
			skipped
		};
	}
	for (const entry of entries) {
		const childPath = joinPath(target.dir, entry.name);
		const matchedRule = target.protectedChildren?.find((rule) => matchesProtectedRule(entry.name, rule));
		if (matchedRule !== void 0) {
			skipped.push({
				path: childPath,
				reason: `protected child (rule: ${matchedRule})`
			});
			continue;
		}
		if (rootDirs.has(childPath)) continue;
		const measure = await measureWithSkipped(childPath, skipped, signal);
		if (measure === null) continue;
		if (target.minAgeDays !== void 0 && measure.maxMtimeMs !== null && measure.maxMtimeMs > Date.now() - target.minAgeDays * 864e5) continue;
		items.push({
			id: `${target.kind}:${childPath}`,
			kind: target.kind,
			label: entry.name,
			path: childPath,
			sizeBytes: measure.sizeBytes,
			fileCount: measure.fileCount,
			safeToClean: target.safeToClean,
			rationale: target.rationale,
			lastModifiedAt: measure.maxMtimeMs === null ? null : new Date(measure.maxMtimeMs).toISOString()
		});
	}
	return {
		items,
		skipped
	};
}
/** Measure one path, translating failures into `skipped` records; null = no item. */
async function measureWithSkipped(path, skipped, signal) {
	let measure;
	try {
		measure = await measureTree(path, signal);
	} catch (error) {
		throwIfAborted(signal, "scan");
		const code = error.code;
		if (code !== "ENOENT") {
			skipped.push({
				path,
				reason: `walk failed: ${code ?? error}`
			});
			console.warn(`[pc-manager] junk walk degraded at ${path}: ${code ?? error}`);
		}
		return null;
	}
	const rootDegraded = measure.degraded.find((degraded) => degraded.path === path);
	if (rootDegraded !== void 0) {
		skipped.push({
			path,
			reason: `walk failed: ${rootDegraded.code}`
		});
		return null;
	}
	for (const degraded of measure.degraded) skipped.push({
		path: degraded.path,
		reason: `walk degraded: ${degraded.code}`
	});
	return measure;
}
/**
* Parse one junk id `<kind>:<absolute path>`; null when the kind is outside
* the vocabulary or the path is not absolute in its own flavor. The split is
* at the FIRST colon, which is what lets a Windows path keep its drive colon
* (`trash:C:\$Recycle.Bin`) — no kind name contains a colon.
*/
function parseJunkId(id) {
	const separator = id.indexOf(":");
	if (separator <= 0) return null;
	const kind = id.slice(0, separator);
	const path = id.slice(separator + 1);
	if (!JUNK_KINDS.includes(kind)) return null;
	if (!isAbsolutePath(path)) return null;
	return {
		kind,
		path
	};
}
/** Strict descendant check after normalization in the root's own flavor;
* equality is not "under". */
function isStrictlyUnder(path, root) {
	const flavor = pathFlavor(root);
	const api = apiFor(flavor);
	const p = foldCase(flavor, normalizeLiteral(api, path));
	const r = foldCase(flavor, normalizeLiteral(api, root));
	if (p === r) return false;
	const sep = flavor === "win32" ? "\\" : "/";
	return p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}
/** Equality after normalization in the second literal's flavor, case-folded on
* Windows (`C:\Users\T` and `c:\users\t` are the same directory there). */
function samePath(a, b) {
	const flavor = pathFlavor(b);
	const api = apiFor(flavor);
	return foldCase(flavor, normalizeLiteral(api, a)) === foldCase(flavor, normalizeLiteral(api, b));
}
/**
* Layer 1–5 structural validation over the id list (§4.2). Children kinds
* accept only strict descendants of their roots (empty-name collapse defense);
* whole kinds accept exactly their root. Any failure rejects the whole batch
* with `invalid_argument` / `unsafe_target` — zero deletions.
*/
async function validateJunkIds(ids, expanded, home) {
	for (const id of ids) {
		const parsed = parseJunkId(id);
		if (parsed === null) throw new PcManagerError("invalid_argument", `invalid junk id: ${JSON.stringify(id)}`);
		const { kind, path } = parsed;
		const targetsOfKind = expanded.filter((target) => target.kind === kind);
		if (targetsOfKind.length === 0) throw new PcManagerError("invalid_argument", `unregistered junk kind in id: ${id}`);
		if (!targetsOfKind.some((target) => target.granularity === "whole" ? samePath(path, target.dir) : isStrictlyUnder(path, target.dir))) throw new PcManagerError("invalid_argument", `path escapes its ${kind} root: ${id}`);
		if (isBlockedPath(path, home)) throw new PcManagerError("unsafe_target", `refusing blocked system path: ${id}`);
		let realPath = null;
		try {
			realPath = await realpath(normalizePath(path));
		} catch {
			realPath = null;
		}
		if (realPath !== null) {
			let rootsResolved = 0;
			let withinReal = false;
			for (const target of targetsOfKind) {
				let realRoot;
				try {
					realRoot = await realpath(target.dir);
				} catch {
					continue;
				}
				rootsResolved += 1;
				if (target.granularity === "whole" ? samePath(realPath, realRoot) : isStrictlyUnder(realPath, realRoot)) {
					withinReal = true;
					break;
				}
			}
			if (rootsResolved > 0 && !withinReal) throw new PcManagerError("invalid_argument", `realpath escapes its ${kind} root (symlink redirect?): ${id}`);
			if (isBlockedPath(realPath, home)) throw new PcManagerError("unsafe_target", `refusing blocked system path: ${id}`);
		}
		if (targetsOfKind.some((target) => target.safeToClean === false)) throw new PcManagerError("unsafe_target", `${kind} must not be cleaned directly; ${targetsOfKind.find((target) => target.safeToClean === false)?.rationale ?? ""}`);
	}
}
/** Absolute path of the macOS system trash utility (15+); called without PATH lookup. */
const TRASH_BIN = "/usr/bin/trash";
/** Linux trash-put candidates (trash-cli), most preferred first. */
const LINUX_TRASH_BINS = ["/usr/bin/trash-put", "/usr/local/bin/trash-put"];
/** GLib's trash helper (`gio trash <paths>`), the Linux tier-1 fallback. */
const GIO_TRASH = {
	bin: "/usr/bin/gio",
	args: ["trash"]
};
/** Timeout for one tier-1 trash invocation. */
const TRASH_TIMEOUT_MS = 3e4;
/**
* The Windows tier-1 recycle script for one concrete path list.
*
* The paths are embedded as PowerShell literals rather than appended as argv:
* `-Command` re-joins its arguments with spaces, so a path containing a space
* silently splits into two arguments (and a multi-statement script receives
* nothing at all in `$args`). Single quotes are the only character PowerShell
* needs escaped, doubled inside a single-quoted literal. The .NET
* `Microsoft.VisualBasic` recycle API is the same `SendToRecycleBin` the
* Explorer shell performs, so recoverable items land in the real Recycle Bin
* with their original location. Spelled with `-Command` (never a .ps1 file),
* so a Restricted execution policy cannot block it.
*/
function windowsRecycleScript(paths) {
	const literals = paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(", ");
	return [
		PS_PREAMBLE,
		"$ErrorActionPreference = 'Stop'",
		`$targets = @(${literals})`,
		"if ($targets.Count -eq 0) { throw 'pc-manager: no recycle targets were passed' }",
		"Add-Type -AssemblyName Microsoft.VisualBasic",
		"foreach ($target in $targets) {",
		"  if ([System.IO.Directory]::Exists($target)) {",
		"    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
		"  } else {",
		"    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
		"  }",
		"}"
	].join("\n");
}
const runFile = promisify(execFile);
const defaultIo = {
	runTrashCommand: async (paths) => {
		const command = await resolveTrashCommand();
		if (command === null) throw new Error("no trash utility available on this platform");
		await runFile(command.bin, [...command.buildArgs(paths)], { timeout: TRASH_TIMEOUT_MS });
	},
	rename: (from, to) => rename(from, to)
};
async function canExecute(file) {
	try {
		await access(file, constants$1.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** argv-appending tier-1 command (macOS `trash`, Linux `trash-put`/`gio trash`). */
function argvTrashCommand(bin, prefix = []) {
	return {
		bin,
		buildArgs: (paths) => [...prefix, ...paths]
	};
}
/** Resolve the platform's tier-1 trash utility by existence probe; null when absent. */
async function resolveTrashCommand(plat = platform()) {
	if (plat === "darwin") return await canExecute("/usr/bin/trash") ? argvTrashCommand(TRASH_BIN) : null;
	if (plat === "linux") {
		for (const bin of LINUX_TRASH_BINS) if (await canExecute(bin)) return argvTrashCommand(bin);
		return await canExecute(GIO_TRASH.bin) ? argvTrashCommand(GIO_TRASH.bin, GIO_TRASH.args) : null;
	}
	if (plat === "win32") {
		const bin = await resolvePowershell();
		if (bin === null) return null;
		return {
			bin,
			buildArgs: (paths) => [...PS_ARGV, windowsRecycleScript(paths)]
		};
	}
	return null;
}
/** The trash layout for `home` under `plat`; exported for tests. Joins are
* flavor-aware, so a POSIX `home` yields a POSIX layout on any host (and a
* Windows `home` yields the profile-relative one). */
function trashDirs(plat, home) {
	if (plat === "linux") {
		const root = joinPath(home, ".local/share/Trash");
		return {
			root,
			files: joinPath(root, "files"),
			info: joinPath(root, "info")
		};
	}
	if (plat === "win32") {
		const root = joinPath(home, "AppData/Local/pc-manager/trash");
		return {
			root,
			files: root,
			info: null
		};
	}
	const root = joinPath(home, ".Trash");
	return {
		root,
		files: root,
		info: null
	};
}
/**
* Reject a trash-directory face that is not a directory, not ours, or
* writable by group/others — a world-writable trash destination would let
* anything intercept "recovered" files. Missing faces are created 0700.
*
* Ownership and mode bits are POSIX concepts: Windows reports synthesized
* modes that say nothing about the ACL, and `process.getuid()` does not exist
* there. The Windows faces are therefore only vetted structurally — they sit
* inside the account's own profile — and rely on the profile ACL Windows
* already enforces.
*/
async function ensureSafeTrashDirs(dirs) {
	const uid = process.getuid?.();
	for (const dir of [
		dirs.root,
		dirs.files,
		dirs.info
	]) {
		if (dir === null) continue;
		let stat;
		try {
			stat = await lstat(dir);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await mkdir(dir, {
				recursive: true,
				mode: 448
			});
			continue;
		}
		if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
		if (uid === void 0) continue;
		if (stat.uid !== uid) throw new Error(`${dir} is not owned by the current user`);
		if ((stat.mode & 18) !== 0) throw new Error(`${dir} is group- or other-writable`);
	}
}
/** First free `name`, `name 2`, `name 3`, … — free in BOTH the files face and
* the info face, so a leftover `.trashinfo` never orphans a fresh entry. */
async function reserveTrashName(dirs, name) {
	for (let attempt = 1;; attempt += 1) {
		const candidate = attempt === 1 ? name : `${name} ${attempt}`;
		if (!(await Promise.all([lstat(joinPath(dirs.files, candidate)).then(() => true, (error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		}), dirs.info === null ? Promise.resolve(false) : lstat(joinPath(dirs.info, `${candidate}.trashinfo`)).then(() => true, (error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		})])).some(Boolean)) return candidate;
	}
}
/**
* The freedesktop restore record for one trashed item (`info/<name>.trashinfo`).
* Without it desktop trash UIs still list the item but cannot offer Put Back —
* writing it makes tier-2 recovery path-aware.
*/
async function writeTrashInfo(infoDir, name, originalPath) {
	const deletionDate = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
	const content = `[Trash Info]\nPath=${encodeURI(originalPath)}\nDeletionDate=${deletionDate}\n`;
	await writeFile(joinPath(infoDir, `${name}.trashinfo`), content, { mode: 384 });
}
/** True when the path still exists (symlink-aware; any error reads as gone). */
async function pathExists(path) {
	return lstat(path).then(() => true, () => false);
}
/**
* Move one item to the trash: tier 1 hands it to the platform's shell-aware
* utility, tier 2 renames it into the platform's trash layout (adding the
* freedesktop restore record where one exists), tier 3 copies across volumes
* and removes the source.
*/
async function moveToTrash(path, home, io, tier1Usable, plat) {
	if (tier1Usable) try {
		await io.runTrashCommand([path]);
		if (!await pathExists(path)) return;
		throw new Error("the trash utility reported success but the source is still there");
	} catch (error) {
		console.warn(`[pc-manager] trash utility failed, falling back to rename: ${String(error)}`);
	}
	const dirs = trashDirs(plat, home);
	await ensureSafeTrashDirs(dirs);
	const name = await reserveTrashName(dirs, basenamePath(path));
	const dest = joinPath(dirs.files, name);
	try {
		await io.rename(path, dest);
	} catch (error) {
		if (error.code !== "EXDEV") throw error;
		await cp(path, dest, {
			recursive: true,
			force: false
		});
		await lstat(dest);
		await rm(path, {
			recursive: true,
			force: false
		});
	}
	if (dirs.info !== null) await writeTrashInfo(dirs.info, name, path).catch((error) => {
		console.warn(`[pc-manager] trashinfo write failed for ${path}: ${String(error)}`);
	});
}
/** Remove every child of `dir`, keeping the directory itself. */
async function emptyDirectory(dir) {
	for (const entry of await readdir(dir)) await rm(joinPath(dir, entry), {
		recursive: true,
		force: false
	});
}
/** Empty the trash kind in place (moving entries of the trash back into the
* trash would be a no-op): macOS clears the flat root, Linux clears the
* contents of `files/` and `info/` while keeping the layout directories, and
* Windows clears the account's `$Recycle.Bin` folder — which IS the local
* "empty the Recycle Bin" operation for that volume. */
async function emptyTrash(dirs) {
	await emptyDirectory(dirs.files);
	if (dirs.info !== null) await emptyDirectory(dirs.info);
}
/**
* Reclaim the selected junk items. All ids pass the structural validation
* chain first — one invalid id rejects the whole batch with zero deletions.
* Per item: vanished targets report `not_found`; re-measure failure skips the
* item untouched; trash mode tiers through the platform's trash utility
* (macOS /usr/bin/trash; Linux trash-put/gio trash), rename into the trash
* layout (~/.Trash or ~/.local/share/Trash with a .trashinfo restore record),
* and cross-volume copy+remove. The `trash` kind empties the layout in place
* (moving entries of the trash back into the trash would be a no-op).
* Failures surface per-item, never silently.
*/
async function cleanJunk(ids, mode, targets = resolveTargets(), options = {}) {
	const plat = options.platform ?? platform();
	assertSupportedPlatform(plat);
	if (ids.length === 0) throw new PcManagerError("invalid_argument", "cleanJunk requires at least one junk item id.");
	const home = options.home ?? homedir();
	const io = {
		...defaultIo,
		...options.io
	};
	await validateJunkIds(ids, await expandGlobs(targets), home);
	const tier1Usable = mode === "trash" && (options.io?.runTrashCommand !== void 0 || await resolveTrashCommand(plat) !== null);
	const outcomes = [];
	for (const id of ids) {
		throwIfAborted(options.signal, "clean");
		const parsed = parseJunkId(id);
		if (parsed === null) {
			outcomes.push({
				id,
				reclaimedBytes: 0,
				error: "invalid_argument"
			});
			continue;
		}
		const { kind, path } = parsed;
		let bytes;
		try {
			const measure = await measureTree(path, options.signal);
			if (measure.degraded.length > 0) {
				outcomes.push({
					id,
					reclaimedBytes: 0,
					error: `measure_failed: incomplete measurement (${measure.degraded.length} permission-degraded subtrees)`
				});
				continue;
			}
			bytes = measure.sizeBytes;
		} catch (error) {
			throwIfAborted(options.signal, "clean");
			const code = error.code;
			outcomes.push({
				id,
				reclaimedBytes: 0,
				error: code === "ENOENT" ? "not_found" : `measure_failed: ${code ?? error}`
			});
			continue;
		}
		try {
			if (kind === "trash") await emptyTrash(plat === "linux" ? {
				root: path,
				files: joinPath(path, "files"),
				info: joinPath(path, "info")
			} : {
				root: path,
				files: path,
				info: null
			});
			else if (mode === "delete") await rm(path, {
				recursive: true,
				force: false
			});
			else await moveToTrash(path, home, io, tier1Usable, plat);
			outcomes.push({
				id,
				reclaimedBytes: bytes
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outcomes.push({
				id,
				reclaimedBytes: 0,
				error: `${mode}_failed: ${message}`
			});
		}
	}
	return {
		outcomes,
		totalReclaimedBytes: outcomes.reduce((sum, outcome) => sum + outcome.reclaimedBytes, 0),
		mode,
		cleanedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/**
* Bilingual approval summary for a batch of ids: item count, per-kind
* distribution, and the destination. Pure — safe to call from the
* pre-execute listener.
*/
function describeJunkIds(ids, mode) {
	const counts = /* @__PURE__ */ new Map();
	let unknown = 0;
	for (const id of ids) {
		const kind = parseJunkId(id)?.kind;
		if (kind === void 0) unknown += 1;
		else counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const parts = [...counts.entries()].map(([kind, count]) => `${kind} ×${count}`);
	if (unknown > 0) parts.push(`unrecognized ×${unknown}`);
	const distribution = parts.join(", ");
	const noun = ids.length === 1 ? "item" : "items";
	return {
		en: mode === "trash" ? `Clean ${ids.length} ${noun} (${distribution}) → move to Trash. Recoverable until the Trash is emptied.` : `Clean ${ids.length} ${noun} (${distribution}) → permanent deletion. Not recoverable.`,
		zh: mode === "trash" ? `清理 ${ids.length} 项（${distribution}）→ 移入废纸篓，清空前可恢复。` : `清理 ${ids.length} 项（${distribution}）→ 永久删除，不可恢复。`
	};
}
//#endregion
//#region src/apps.ts
/**
* Enumerate uninstallable apps with sizes and last-launch times.
* TODO(M3): /Applications + ~/Applications bundle walk (du + Spotlight
* kMDItemLastUseDate), plus `brew list --formula --cask` merging.
*/
async function listApps() {
	throw new PcManagerError("not_implemented", "app inventory lands in M3; the source list is ready for review.");
}
/**
* Uninstall one app by its inventory id.
* TODO(M3): bundle → Trash first (recoverable); hard delete and `brew
* uninstall` behind config; report plists and app-support dirs as leftovers.
*/
async function uninstallApp(_id, _mode) {
	throw new PcManagerError("not_implemented", "app uninstall lands in M3; nothing was removed.");
}
//#endregion
//#region src/tools.ts
const ERROR_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		code: {
			type: "string",
			required: true,
			enum: [
				"not_implemented",
				"unsupported_platform",
				"invalid_argument",
				"not_found",
				"disabled_by_config",
				"unsafe_target",
				"internal_error"
			]
		},
		message: {
			type: "string",
			required: true
		}
	}
};
/** Nullable scalar as the schema DSL's exact-one `oneOf`, keeping `type` literal for inference. */
const nullable = (schema) => ({ oneOf: [schema, { type: "null" }] });
const STATUS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		platform: {
			type: "string",
			required: true
		},
		hostname: {
			type: "string",
			required: true
		},
		osVersion: nullable({ type: "string" }),
		uptimeSeconds: {
			type: "number",
			required: true
		},
		cpu: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: {
				model: {
					type: "string",
					required: true
				},
				cores: {
					type: "number",
					required: true
				},
				usagePercent: nullable({ type: "number" }),
				loadavg: {
					oneOf: [{
						type: "array",
						items: { type: "number" }
					}, { type: "null" }],
					required: true
				},
				temperatureCelsius: nullable({ type: "number" })
			}
		},
		gpu: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: {
				usagePercent: nullable({ type: "number" }),
				name: nullable({ type: "string" })
			}
		},
		memory: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: {
				totalBytes: {
					type: "number",
					required: true
				},
				usedBytes: {
					type: "number",
					required: true
				},
				appMemoryBytes: {
					type: "number",
					required: true
				},
				wiredBytes: nullable({ type: "number" }),
				compressedBytes: nullable({ type: "number" }),
				cachedBytes: nullable({ type: "number" }),
				purgeableBytes: nullable({ type: "number" }),
				swapTotalBytes: nullable({ type: "number" }),
				swapUsedBytes: nullable({ type: "number" })
			}
		},
		diskIo: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: { totalBytesPerSec: nullable({ type: "number" }) }
		},
		disks: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					mount: {
						type: "string",
						required: true
					},
					filesystem: {
						type: "string",
						required: true
					},
					totalBytes: {
						type: "number",
						required: true
					},
					usedBytes: {
						type: "number",
						required: true
					},
					freeBytes: {
						type: "number",
						required: true
					}
				}
			}
		},
		battery: { oneOf: [{
			type: "object",
			additionalProperties: false,
			properties: {
				percent: nullable({ type: "number" }),
				charging: nullable({ type: "boolean" }),
				powerSource: nullable({ type: "string" }),
				timeRemainingMinutes: nullable({ type: "number" }),
				cycleCount: nullable({ type: "number" }),
				healthPercent: nullable({ type: "number" })
			}
		}, { type: "null" }] },
		network: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					interface: {
						type: "string",
						required: true
					},
					rxBytes: {
						type: "number",
						required: true
					},
					txBytes: {
						type: "number",
						required: true
					}
				}
			}
		},
		localIps: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		publicIp: { oneOf: [{
			type: "object",
			additionalProperties: false,
			properties: {
				ip: {
					type: "string",
					required: true
				},
				city: nullable({ type: "string" }),
				region: nullable({ type: "string" }),
				country: nullable({ type: "string" }),
				countryCode: nullable({ type: "string" })
			}
		}, { type: "null" }] },
		topProcesses: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					pid: {
						type: "number",
						required: true
					},
					cpuPercent: {
						type: "number",
						required: true
					},
					memPercent: {
						type: "number",
						required: true
					},
					rssBytes: {
						type: "number",
						required: true
					},
					command: {
						type: "string",
						required: true
					},
					netRxBytes: nullable({ type: "number" }),
					netTxBytes: nullable({ type: "number" }),
					gpuPercent: nullable({ type: "number" }),
					diskReadBytes: nullable({ type: "number" }),
					diskWrittenBytes: nullable({ type: "number" })
				}
			}
		},
		sampledAt: {
			type: "string",
			required: true
		}
	}
};
const JUNK_SCAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		items: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true,
						enum: [...JUNK_KINDS]
					},
					label: {
						type: "string",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					sizeBytes: {
						type: "number",
						required: true
					},
					fileCount: {
						type: "number",
						required: true
					},
					safeToClean: {
						type: "boolean",
						required: true
					},
					rationale: {
						type: "string",
						required: true
					},
					lastModifiedAt: nullable({ type: "string" })
				}
			}
		},
		totalBytes: {
			type: "number",
			required: true
		},
		skipped: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					reason: {
						type: "string",
						required: true
					}
				}
			}
		},
		scannedAt: {
			type: "string",
			required: true
		}
	}
};
const JUNK_CLEAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		outcomes: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					reclaimedBytes: {
						type: "number",
						required: true
					},
					error: { type: "string" }
				}
			}
		},
		totalReclaimedBytes: {
			type: "number",
			required: true
		},
		mode: {
			type: "string",
			required: true,
			enum: ["trash", "delete"]
		},
		cleanedAt: {
			type: "string",
			required: true
		}
	}
};
const APPS_LIST_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		apps: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true,
						enum: [
							"app-bundle",
							"homebrew",
							"system"
						]
					},
					path: {
						type: "string",
						required: true
					},
					sizeBytes: {
						type: "number",
						required: true
					},
					lastUsedAt: { type: "string" }
				}
			}
		},
		scannedAt: {
			type: "string",
			required: true
		}
	}
};
const APP_UNINSTALL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		uninstalled: {
			type: "boolean",
			required: true
		},
		mode: {
			type: "string",
			required: true,
			enum: ["trash", "delete"]
		},
		leftovers: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		uninstalledAt: {
			type: "string",
			required: true
		}
	}
};
/** Deterministic model content: the canonical JSON the schema validated. */
function renderValue(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/** Pure generic pending card. */
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...rawInput === void 0 ? {} : { rawInput }
	};
}
/** Run one domain call, translating failures into the closed error union. */
async function guarded(task) {
	try {
		return await task();
	} catch (error) {
		return error instanceof PcManagerError ? {
			code: error.code,
			message: error.message
		} : {
			code: "internal_error",
			message: String(error)
		};
	}
}
/** Register all five 电脑管家 tools in one plugin context. */
function registerPcManagerTools(ctx, config) {
	ctx.tools.register(defineTool({
		name: "pc_status",
		description: "Read one system status snapshot: CPU model/cores/utilization/load average (and package temperature when the host exposes a sensor), GPU utilization (best-effort), memory pressure breakdown with swap, disk I/O throughput and per-volume usage, battery/power, per-interface network counters, local and public IP addresses (public geolocation via an external lookup, host-configurable), and ranked processes (CPU, memory, or network). Read-only; safe to call any time.",
		parameters: {},
		output: {
			schema: { oneOf: [STATUS_SCHEMA, ERROR_SCHEMA] },
			render: renderValue
		},
		execute: () => guarded(() => collectStatus(config.maxTopProcesses, "cpu", { ipGeo: config.ipGeo })),
		presentCall: () => present("System status", "read")
	}));
	ctx.tools.register(defineTool({
		name: "pc_junk_scan",
		description: "Enumerate reclaimable junk on this host — the Trash (Recycle Bin on Windows), user caches, system temp, and package-manager caches (npm/pnpm/pip/uv/yarn/go/Homebrew); on macOS also user logs, Xcode build artifacts, simulator leftovers, and iOS device backups; on Windows also Windows Error Reporting archives, crash dumps, the WinINet cache, and DirectX/NVIDIA shader caches — with per-item sizes, safety notes, and suggested commands for items that must not be deleted directly. Always a dry run: scanning deletes nothing. After scanning, present a per-category summary to the user and ask which categories or items to clean — prefer the ask_user_question tool for that choice when it is available — before ever calling pc_junk_clean.",
		parameters: {
			kinds: {
				type: "array",
				items: {
					type: "string",
					enum: [...JUNK_KINDS]
				},
				description: "Optional junk kinds to include; omit to scan all registered kinds."
			},
			minItemBytes: {
				type: "number",
				description: "Optional minimum item size in bytes; smaller items are omitted from the report."
			}
		},
		output: {
			schema: { oneOf: [JUNK_SCAN_SCHEMA, ERROR_SCHEMA] },
			render: renderValue
		},
		execute: (args, exec) => guarded(() => scanJunk({
			kinds: Array.isArray(args.kinds) ? args.kinds.filter((kind) => typeof kind === "string" && JUNK_KINDS.includes(kind)) : void 0,
			minItemBytes: typeof args.minItemBytes === "number" && Number.isFinite(args.minItemBytes) && args.minItemBytes > 0 ? args.minItemBytes : void 0,
			signal: exec.signal
		})),
		presentCall: () => present("Scan junk", "read")
	}));
	ctx.tools.register(defineTool({
		name: "pc_junk_clean",
		description: "Reclaim the junk items whose exact ids were returned by pc_junk_scan. Only call this after the user has explicitly confirmed the exact selection and the destination (the Trash — the Recycle Bin on Windows — by default, recoverable); restate the items and sizes when asking, prefer ask_user_question for the confirmation when available. Permanent deletion is only possible when the host config sets moveToTrash to false — say so instead of retrying if the user asks for it. Items from targets marked safeToClean:false are refused with unsafe_target; relay their suggested commands instead. Refuses with disabled_by_config until the host enables junk cleaning; a host-side approval prompt may also confirm the run.",
		parameters: { ids: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "Exact junk item ids from a prior pc_junk_scan."
		} },
		output: {
			schema: { oneOf: [JUNK_CLEAN_SCHEMA, ERROR_SCHEMA] },
			render: renderValue
		},
		async execute(args, exec) {
			if (!config.enableJunkClean) return {
				code: "disabled_by_config",
				message: "junk cleaning is disabled; set pc-manager.enableJunkClean to opt in."
			};
			if (!Array.isArray(args.ids) || args.ids.length === 0 || !args.ids.every((id) => typeof id === "string" && id.length > 0)) return {
				code: "invalid_argument",
				message: "pc_junk_clean requires a non-empty array of junk item ids from pc_junk_scan."
			};
			return guarded(() => cleanJunk(args.ids, config.moveToTrash ? "trash" : "delete", void 0, { signal: exec.signal }));
		},
		presentCall: (args) => present("Clean junk", "other", args)
	}));
	ctx.tools.register(defineTool({
		name: "pc_apps_list",
		description: "List installed applications (app bundles and Homebrew formulae/casks on macOS; distro packages on Linux and registered programs on Windows once M3 lands) with sizes and last-launch times when observable. Read-only.",
		parameters: {},
		output: {
			schema: { oneOf: [APPS_LIST_SCHEMA, ERROR_SCHEMA] },
			render: renderValue
		},
		execute: () => guarded(() => listApps()),
		presentCall: () => present("List apps", "read")
	}));
	ctx.tools.register(defineTool({
		name: "pc_app_uninstall",
		description: "Uninstall one application by the exact id from pc_apps_list. The app moves to the Trash by default (recoverable); related plists and caches are reported as leftovers, not silently deleted. Refuses with disabled_by_config until the host enables uninstalls.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Exact app id from pc_apps_list."
		} },
		output: {
			schema: { oneOf: [APP_UNINSTALL_SCHEMA, ERROR_SCHEMA] },
			render: renderValue
		},
		async execute(args) {
			if (!config.enableAppUninstall) return {
				code: "disabled_by_config",
				message: "app uninstall is disabled; set pc-manager.enableAppUninstall to opt in."
			};
			if (typeof args.id !== "string" || args.id.trim().length === 0) return {
				code: "invalid_argument",
				message: "pc_app_uninstall requires a non-empty app id from pc_apps_list."
			};
			return guarded(() => uninstallApp(args.id, config.moveToTrash ? "trash" : "delete"));
		},
		presentCall: (args) => present("Uninstall app", "other", args)
	}));
	if (config.askBeforeJunkClean) ctx.on("tools/pre-execute", async (exec, next) => {
		if (exec.name !== "pc_junk_clean" || !config.enableJunkClean) return next();
		const args = exec.arguments;
		const ids = Array.isArray(args?.ids) ? args.ids.filter((id) => typeof id === "string" && id.length > 0) : [];
		if (ids.length === 0) return next();
		const summary = describeJunkIds(ids, config.moveToTrash ? "trash" : "delete");
		return {
			kind: "ask",
			reason: summary.en,
			displayReason: {
				en: summary.en,
				zh: summary.zh
			}
		};
	});
}
//#endregion
//#region src/index.ts
const name = "pc-manager";
const inject = ["tools"];
/** Lowest poll interval the dashboard accepts, so a client cannot hammer the probes. */
const MIN_DASHBOARD_POLL_MS = 500;
/** Default dashboard poll interval advertised to the web client. */
const DEFAULT_DASHBOARD_POLL_MS = 2e3;
/** Default public-ip geolocation endpoint (HTTPS, keyless, ipwho.is-compatible JSON). */
const DEFAULT_IP_GEO_ENDPOINT = "https://ipwho.is/";
/** Default minutes a successful public-ip lookup stays cached. */
const DEFAULT_IP_GEO_REFRESH_MINUTES = 30;
/** Lowest accepted cache minutes — the lookup must not track the poll cadence. */
const MIN_IP_GEO_REFRESH_MINUTES = 5;
/** Runtime configuration schema. */
const Config = z.object({
	enableJunkClean: z.boolean().default(false),
	enableAppUninstall: z.boolean().default(false),
	moveToTrash: z.boolean().default(true),
	askBeforeJunkClean: z.boolean().default(true),
	maxTopProcesses: z.natural().default(10),
	dashboardPollMs: z.natural().default(DEFAULT_DASHBOARD_POLL_MS),
	enableIpGeoLookup: z.boolean().default(true),
	ipGeoRefreshMinutes: z.natural().default(30),
	ipGeoEndpoint: z.string().default(DEFAULT_IP_GEO_ENDPOINT)
});
/** Validate the dashboard route's `processSort` query parameter. */
function processSort(value) {
	return value === "mem" || value === "network" ? value : "cpu";
}
/** Clamp the dashboard route's `processLimit` query parameter. */
function processLimit(value, fallback) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, 50);
}
/**
* The single sampling pump: one timer, one probe round per interval, shared by
* every consumer. The timer runs only while at least one SSE subscriber (or a
* cache-missing HTTP request) holds a reference, so a hidden dashboard costs
* nothing. Each round also derives per-interface and per-process rates against
* the previous frames, which is why pushed frames carry rates from the second
* frame on. The `SystemStatus` wire keeps cumulative process counters — the
* pc_status tool contract stays untouched; rates are a dashboard-layer extra.
*/
var SnapshotPump = class {
	pollMs;
	maxTop;
	ipGeo;
	listeners = /* @__PURE__ */ new Set();
	timer;
	running = false;
	latest;
	inflight;
	processSeen = /* @__PURE__ */ new Map();
	constructor(pollMs, maxTop, ipGeo = null) {
		this.pollMs = pollMs;
		this.maxTop = maxTop;
		this.ipGeo = ipGeo;
	}
	acquire(listener) {
		this.listeners.add(listener);
		if (this.latest !== void 0) listener(this.latest);
		if (this.timer === void 0) {
			this.start();
			this.ensureFresh().catch(() => {});
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.stop();
		};
	}
	/** A fresh-enough frame for HTTP callers; collects only when the cache went stale. */
	async ensureFresh() {
		const age = this.latest === void 0 ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(this.latest.status.sampledAt);
		if (Number.isFinite(age) && age < this.pollMs) return this.latest;
		this.inflight ??= this.collect().finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	start() {
		this.timer = setInterval(() => {
			if (this.running) return;
			this.collect().catch(() => {});
		}, this.pollMs);
	}
	stop() {
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
	}
	async collect() {
		this.running = true;
		try {
			const prev = this.latest?.status ?? null;
			let union = [];
			const status = await collectStatus(this.maxTop, "cpu", {
				onProcessTable: (table) => {
					union = unionProcessRows(table, this.maxTop);
				},
				ipGeo: this.ipGeo
			});
			const rates = diffNetRates(prev, status);
			const processDiff = diffProcessRates(this.processSeen, union, status.sampledAt);
			this.processSeen = processDiff.nextLastSeen;
			const frame = {
				status,
				netRates: Object.fromEntries([...rates.entries()].map(([name, rate]) => [name, rate])),
				processRates: Object.fromEntries([...processDiff.rates.entries()].map(([pid, rate]) => [String(pid), rate])),
				topByNetwork: sortByNetworkRate(union, processDiff.rates, this.maxTop),
				pollMs: this.pollMs
			};
			this.latest = frame;
			for (const listener of this.listeners) listener(frame);
			return frame;
		} finally {
			this.running = false;
		}
	}
};
/**
* Serve the dashboard's data faces when the web profile provides a server:
* an SSE stream (the shared base — one pump, every consumer) and a cached
* JSON route as the fallback for one-shot callers. Headless profiles never
* inject webServer, so this stays a no-op there.
*/
function serveDashboard(ctx, pollMs, defaultLimit, ipGeo) {
	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;
		const pump = new SnapshotPump(pollMs, defaultLimit, ipGeo);
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/pc-manager/stream",
			handler: (req, res) => {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-store",
					Connection: "keep-alive"
				});
				const release = pump.acquire((frame) => {
					res.write(`data: ${JSON.stringify(frame)}\n\n`);
				});
				req.on("close", release);
			}
		}));
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/pc-manager/status",
			handler: (req, res) => {
				(async () => {
					const url = new URL(req.url ?? "/", "http://localhost");
					const requested = processLimit(url.searchParams.get("processLimit"), defaultLimit);
					const requestedSort = processSort(url.searchParams.get("processSort"));
					const status = requested === defaultLimit && requestedSort === "cpu" ? (await pump.ensureFresh()).status : await collectStatus(requested, requestedSort, { ipGeo });
					res.writeHead(200, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
						"x-pc-manager-poll-ms": String(pollMs)
					});
					res.end(JSON.stringify(status));
				})().catch((error) => {
					res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						code: "internal_error",
						message: String(error)
					}));
				});
			}
		}));
	});
}
/**
* The dashboard plan card's faces (§16.8): a read-only scan pre-filtered to
* plan-worthy items (≥ the preset threshold, so small entries never reach the
* UI), plus a direct clean endpoint so the card executes without any LLM
* round-trip — the config gate and the id validation chain inside
* {@link cleanJunk} are exactly the tool's own.
*/
function serveJunkFaces(ctx, config) {
	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/pc-manager/junk/scan",
			handler: (req, res) => {
				(async () => {
					if (req.method !== "GET") {
						res.writeHead(405, {
							"Content-Type": "application/json; charset=utf-8",
							Allow: "GET"
						});
						res.end(JSON.stringify({
							code: "invalid_argument",
							message: "GET only"
						}));
						return;
					}
					const report = await scanJunk({ minItemBytes: RECOMMENDED_PLAN.minItemBytes });
					const items = report.items.map((item) => ({
						...item,
						recommendedDefault: isRecommendedItem(item)
					}));
					const kindMeta = [];
					for (const target of JUNK_TARGETS) {
						if (kindMeta.some((meta) => meta.kind === target.kind)) continue;
						kindMeta.push({
							kind: target.kind,
							label: target.label,
							safeToClean: target.safeToClean,
							rationale: target.rationale,
							recommended: RECOMMENDED_PLAN.kinds.includes(target.kind)
						});
					}
					res.writeHead(200, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store"
					});
					res.end(JSON.stringify({
						items,
						kindMeta,
						totalBytes: report.totalBytes,
						skipped: report.skipped,
						scannedAt: report.scannedAt,
						moveToTrash: config.moveToTrash ?? true
					}));
				})().catch((error) => {
					res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						code: "internal_error",
						message: String(error)
					}));
				});
			}
		}));
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/pc-manager/junk/clean",
			handler: (req, res) => {
				(async () => {
					if (req.method !== "POST") {
						res.writeHead(405, {
							"Content-Type": "application/json; charset=utf-8",
							Allow: "POST"
						});
						res.end(JSON.stringify({
							code: "invalid_argument",
							message: "POST only"
						}));
						return;
					}
					const send = (status, payload) => {
						res.writeHead(status, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store"
						});
						res.end(JSON.stringify(payload));
					};
					if (!(config.enableJunkClean ?? false)) {
						send(403, {
							code: "disabled_by_config",
							message: "junk cleaning is disabled; set pc-manager.enableJunkClean to opt in."
						});
						return;
					}
					const ids = (await new Promise((resolve, reject) => {
						let raw = "";
						req.on("data", (chunk) => {
							raw += chunk.toString();
						});
						req.on("end", () => {
							try {
								resolve(raw.length > 0 ? JSON.parse(raw) : {});
							} catch (error) {
								reject(error);
							}
						});
						req.on("error", reject);
					})).ids;
					if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) {
						send(400, {
							code: "invalid_argument",
							message: "junk clean requires a non-empty array of item ids."
						});
						return;
					}
					const mode = config.moveToTrash ?? true ? "trash" : "delete";
					const result = await cleanJunk(ids, mode);
					const failed = result.outcomes.filter((outcome) => outcome.error !== void 0).length;
					console.warn(`[pc-manager] junk clean via dashboard: ${ids.length} ids, mode ${mode}, reclaimed ${result.totalReclaimedBytes} bytes, ${failed} failed`);
					send(200, result);
				})().catch((error) => {
					if (error instanceof PcManagerError) {
						const status = error.code === "invalid_argument" ? 400 : error.code === "unsafe_target" ? 403 : 500;
						res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							code: error.code,
							message: error.message
						}));
						return;
					}
					res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						code: "internal_error",
						message: String(error)
					}));
				});
			}
		}));
	});
}
function apply(ctx, config = {}) {
	const pollMs = Math.max(500, config.dashboardPollMs ?? 2e3);
	const maxTopProcesses = config.maxTopProcesses ?? 10;
	const ipGeo = config.enableIpGeoLookup ?? true ? createIpGeoLookup({
		endpoint: config.ipGeoEndpoint ?? "https://ipwho.is/",
		refreshMs: Math.max(5, config.ipGeoRefreshMinutes ?? 30) * 6e4
	}) : null;
	if (ipGeo !== null) ipGeo();
	serveDashboard(ctx, pollMs, maxTopProcesses, ipGeo);
	serveJunkFaces(ctx, config);
	registerPcManagerTools(ctx, {
		enableJunkClean: config.enableJunkClean ?? false,
		enableAppUninstall: config.enableAppUninstall ?? false,
		moveToTrash: config.moveToTrash ?? true,
		askBeforeJunkClean: config.askBeforeJunkClean ?? true,
		maxTopProcesses,
		ipGeo
	});
}
//#endregion
export { Config, DEFAULT_DASHBOARD_POLL_MS, DEFAULT_IP_GEO_ENDPOINT, DEFAULT_IP_GEO_REFRESH_MINUTES, MIN_DASHBOARD_POLL_MS, MIN_IP_GEO_REFRESH_MINUTES, apply, inject, name };
