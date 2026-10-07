import z from "@deepseek-ai/schemastery";
import { execFile } from "node:child_process";
import { cpus, freemem, homedir, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/monitor.ts
/**
* Read-only system status sampling for macOS hosts. Every probe degrades to
* an empty result instead of failing the snapshot: monitoring must not hard-fail
* because one subcommand is missing. Pure parsers are exported for unit tests.
* @module @deepseek-ai/dsh-pc-manager
*/
const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 5e3;
/** Minimum window between the two `os.cpus()` samples used for utilization. */
const CPU_SAMPLE_MS = 250;
/** Clamp to one decimal, mapping unparseable input to 0 (percent fields never null). */
function round1(value) {
	return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}
/**
* Parse `df -k` stdout into byte-level disk usage. Virtual filesystems
* (devfs, map_*) are dropped; macOS snapshot mounts keep only real volumes.
*/
function parseDf(stdout) {
	const disks = [];
	for (const line of stdout.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 9) continue;
		const [filesystem, kbTotal, kbUsed, kbFree] = fields;
		const mount = fields.slice(8).join(" ");
		if (filesystem.startsWith("devfs") || filesystem.startsWith("map ")) continue;
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
/** One probe round of the full process table: ps rows merged with nettop counters. */
async function mergeProcessTable() {
	const [psRows, netRows] = await Promise.all([probe("ps", [], async () => {
		const { stdout } = await run("ps", ["-Ao", "pid,pcpu,pmem,rss,comm"], { timeout: EXEC_TIMEOUT_MS });
		return parsePs(stdout);
	}), probe("nettop", /* @__PURE__ */ new Map(), async () => {
		const { stdout } = await run("nettop", [
			"-P",
			"-L",
			"1",
			"-n",
			"-J",
			"bytes_in,bytes_out"
		], { timeout: EXEC_TIMEOUT_MS });
		return parseNettop(stdout);
	})]);
	return mergeProcesses(psRows, netRows);
}
/**
* Collect one system snapshot. Probes run concurrently; memory uses the
* vm_stat decomposition (active + wired + compressed) with total−free as the
* documented fallback, so a missing probe degrades instead of failing.
*/
async function collectStatus(maxTop = 10, sort = "cpu", extras) {
	const cpuStart = cpus();
	const startedAt = Date.now();
	const [disks, processTable, network, gpuPercent, diskIoPerSec, pmsetBattery, ioregBattery, swap, vmstat, osVersion] = await Promise.all([
		probe("df", [], async () => {
			const { stdout } = await run("df", ["-k"], { timeout: EXEC_TIMEOUT_MS });
			return parseDf(stdout);
		}),
		mergeProcessTable(),
		probe("netstat", [], async () => {
			const { stdout } = await run("netstat", ["-ib"], { timeout: EXEC_TIMEOUT_MS });
			return parseNetstatIb(stdout);
		}),
		probe("gpu ioreg", null, async () => {
			const { stdout } = await run("ioreg", [
				"-r",
				"-d",
				"1",
				"-c",
				"IOAccelerator"
			], { timeout: EXEC_TIMEOUT_MS });
			return parseIoregGpu(stdout);
		}),
		probe("iostat", null, async () => {
			const { stdout } = await run("iostat", [
				"-d",
				"-c",
				"2"
			], { timeout: EXEC_TIMEOUT_MS });
			return parseIostat(stdout);
		}),
		probe("pmset", null, async () => {
			const { stdout } = await run("pmset", ["-g", "batt"], { timeout: EXEC_TIMEOUT_MS });
			return parsePmsetBatt(stdout);
		}),
		probe("battery ioreg", null, async () => {
			const { stdout } = await run("ioreg", ["-rn", "AppleSmartBattery"], { timeout: EXEC_TIMEOUT_MS });
			return parseIoregBattery(stdout);
		}),
		probe("swapusage", null, async () => {
			const { stdout } = await run("sysctl", ["-n", "vm.swapusage"], { timeout: EXEC_TIMEOUT_MS });
			return parseSwapUsage(stdout);
		}),
		probe("vm_stat", null, async () => {
			const { stdout } = await run("vm_stat", [], { timeout: EXEC_TIMEOUT_MS });
			return parseVmStat(stdout);
		}),
		probe("sw_vers", null, async () => {
			const { stdout } = await run("sw_vers", ["-productVersion"], { timeout: EXEC_TIMEOUT_MS });
			const version = stdout.trim();
			return version.length > 0 ? version : null;
		})
	]);
	const elapsed = Date.now() - startedAt;
	if (elapsed < CPU_SAMPLE_MS) await delay(CPU_SAMPLE_MS - elapsed);
	const cpuEnd = cpus();
	const total = totalmem();
	const fallbackUsed = total - freemem();
	let usedBytes = fallbackUsed;
	let appMemoryBytes = 0;
	let wiredBytes = null;
	let compressedBytes = null;
	let cachedBytes = null;
	let purgeableBytes = null;
	if (vmstat !== null) {
		const vmUsed = vmstat.activeBytes + vmstat.wiredBytes + vmstat.compressedBytes;
		usedBytes = vmUsed > 0 ? Math.min(vmUsed, total) : fallbackUsed;
		appMemoryBytes = vmstat.activeBytes;
		wiredBytes = vmstat.wiredBytes;
		compressedBytes = vmstat.compressedBytes;
		cachedBytes = vmstat.inactiveBytes + vmstat.speculativeBytes;
		purgeableBytes = vmstat.purgeableBytes;
	}
	const battery = pmsetBattery === null && ioregBattery === null ? null : {
		percent: pmsetBattery?.percent ?? null,
		charging: pmsetBattery?.charging ?? null,
		powerSource: pmsetBattery?.powerSource ?? null,
		timeRemainingMinutes: pmsetBattery?.timeRemainingMinutes ?? null,
		cycleCount: ioregBattery?.cycleCount ?? null,
		healthPercent: ioregBattery?.healthPercent ?? null
	};
	extras?.onProcessTable?.(processTable);
	return {
		platform: platform(),
		hostname: hostname(),
		osVersion,
		uptimeSeconds: uptime(),
		cpu: {
			model: cpuEnd[0]?.model ?? "unknown",
			cores: cpuEnd.length,
			usagePercent: cpuUsagePercent(cpuStart, cpuEnd),
			loadavg: [
				loadavg()[0],
				loadavg()[1],
				loadavg()[2]
			]
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
			swapUsedBytes: swap?.usedBytes ?? null
		},
		diskIo: { totalBytesPerSec: diskIoPerSec },
		disks,
		battery,
		network,
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
* System junk cleanup (垃圾清理). The target registry is the core safety
* asset — which paths count as junk, why, and how safe they are — while
* scanJunk (size walk, always dry-run) and cleanJunk (validation chain plus
* Trash-first reclaim) are the executors. Pure node:fs, zero cordis, so the
* module stays unit-testable outside the harness.
* @module @deepseek-ai/dsh-pc-manager
*/
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
* Sensitive-cache protection list for `~/Library/Caches`: "caches" that hold
* non-regenerable state (password vaults, IDE indexes, input-method lexicons,
* VPN configs, sync clients, AI apps). Self-built — concept references only.
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
const JUNK_TARGETS = [
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
/**
* Kinds whose deletion costs non-regenerable data (§3.2 ✅* rows): excluded
* from the recommended pre-selection — the UI shows them unchecked by default.
*/
const NON_REGENERABLE_KINDS = ["xcode-archives", "ios-backups"];
/**
* The pre-checked cleanup plan the dashboard presents (§16.2): every
* safe-to-clean kind minus the non-regenerable ones, items at or above
* 1 MiB. Safety-policy data in the registry's own league — not a Config knob.
*/
const RECOMMENDED_PLAN = Object.freeze({
	kinds: Object.freeze(JUNK_KINDS.filter((kind) => {
		const rows = JUNK_TARGETS.filter((target) => target.kind === kind);
		return rows.length > 0 && rows.every((row) => row.safeToClean) && !NON_REGENERABLE_KINDS.includes(kind);
	})),
	minItemBytes: 1024 * 1024
});
/** True when the UI plan card pre-checks this item. */
function isRecommendedItem(item) {
	return RECOMMENDED_PLAN.kinds.includes(item.kind) && item.sizeBytes >= RECOMMENDED_PLAN.minItemBytes;
}
/**
* Blocked system paths (defense in depth above root containment, guarding
* against future registry misconfiguration). `~/Library/Containers` variants
* are prefix-blocked because containers are app state, not cache; `$HOME` and
* `~/Library` block equality only — their descendants are where junk lives.
*/
const BLOCKED_PREFIXES = [
	"/System",
	"/usr",
	"/bin",
	"/sbin",
	"/private/var/db",
	"/private/etc",
	"/Library",
	"~/Library/Containers",
	"~/Library/Group Containers"
];
/** True when a candidate path must never be cleaned, regardless of registry contents. */
function isBlockedPath(path, home) {
	const p = normalize(path);
	const h = normalize(home);
	if (p === h || p === `${h}/Library` || p === "/Users") return true;
	for (const blocked of BLOCKED_PREFIXES) {
		const b = normalize(blocked.replace(/^~(?=\/)/, h));
		if (p === b || p.startsWith(`${b}/`)) return true;
	}
	if (h.startsWith("/Users/")) {
		if (p.startsWith("/Users/") && p !== h && !p.startsWith(`${h}/`)) return true;
	} else if (p.startsWith("/Users/") || p === "/Users") return true;
	return false;
}
/** Expand `~` in every target dir; exported for tests and future filters. */
function resolveTargets(targets = JUNK_TARGETS, home = homedir()) {
	return targets.map((target) => ({
		...target,
		dir: target.dir.replace(/^~(?=\/)/, home)
	}));
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
	let currents = ["/"];
	for (const segment of target.dir.split("/").filter((part) => part.length > 0)) {
		const next = [];
		if (segment !== "*") for (const current of currents) next.push(join(current, segment));
		else for (const current of currents) try {
			const entries = await readdir(current, { withFileTypes: true });
			for (const entry of entries) if (entry.isDirectory()) next.push(join(current, entry.name));
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
		const entryPath = join(dir, entry.name);
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
function assertMacOS() {
	if (platform() !== "darwin") throw new PcManagerError("unsupported_platform", "junk scan/clean only support macOS hosts.");
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
	assertMacOS();
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
		const childPath = join(target.dir, entry.name);
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
* the vocabulary or the path is not absolute.
*/
function parseJunkId(id) {
	const separator = id.indexOf(":");
	if (separator <= 0) return null;
	const kind = id.slice(0, separator);
	const path = id.slice(separator + 1);
	if (!JUNK_KINDS.includes(kind)) return null;
	if (!path.startsWith("/")) return null;
	return {
		kind,
		path
	};
}
/** Strict descendant check after normalization; equality is not "under". */
function isStrictlyUnder(path, root) {
	const p = normalize(path);
	const r = normalize(root);
	if (p === r) return false;
	return p.startsWith(r.endsWith("/") ? r : `${r}/`);
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
		if (!targetsOfKind.some((target) => target.granularity === "whole" ? normalize(path) === normalize(target.dir) : isStrictlyUnder(path, target.dir))) throw new PcManagerError("invalid_argument", `path escapes its ${kind} root: ${id}`);
		if (isBlockedPath(path, home)) throw new PcManagerError("unsafe_target", `refusing blocked system path: ${id}`);
		let realPath = null;
		try {
			realPath = await realpath(normalize(path));
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
				if (target.granularity === "whole" ? realPath === realRoot : isStrictlyUnder(realPath, realRoot)) {
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
/** Absolute path of the system trash utility (macOS 15+); called without PATH lookup. */
const TRASH_BIN = "/usr/bin/trash";
/** Timeout for one trash(8) invocation. */
const TRASH_TIMEOUT_MS = 3e4;
const runFile = promisify(execFile);
const defaultIo = {
	runTrashCommand: async (paths) => {
		await runFile(TRASH_BIN, [...paths], { timeout: TRASH_TIMEOUT_MS });
	},
	rename: (from, to) => rename(from, to)
};
async function canExecute(file) {
	try {
		await access(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* Reject a `~/.Trash` that is not a directory, not ours, or writable by
* group/others — a world-writable trash destination would let anything
* intercept "recovered" files.
*/
async function ensureSafeTrashDir(trashDir) {
	let stat;
	try {
		stat = await lstat(trashDir);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		await mkdir(trashDir, { mode: 448 });
		return;
	}
	if (!stat.isDirectory()) throw new Error(`${trashDir} is not a directory`);
	const uid = process.getuid?.();
	if (uid === void 0 || stat.uid !== uid) throw new Error(`${trashDir} is not owned by the current user`);
	if ((stat.mode & 18) !== 0) throw new Error(`${trashDir} is group- or other-writable`);
}
/** First free `name`, `name 2`, `name 3`, … inside the trash directory. */
async function reserveTrashName(trashDir, name) {
	for (let attempt = 1;; attempt += 1) {
		const candidate = join(trashDir, attempt === 1 ? name : `${name} ${attempt}`);
		try {
			await lstat(candidate);
		} catch (error) {
			if (error.code === "ENOENT") return candidate;
			throw error;
		}
	}
}
async function moveToTrash(path, home, io, trashBinUsable) {
	if (trashBinUsable) try {
		await io.runTrashCommand([path]);
		return;
	} catch (error) {
		console.warn(`[pc-manager] ${TRASH_BIN} failed, falling back to rename: ${String(error)}`);
	}
	const trashDir = join(home, ".Trash");
	await ensureSafeTrashDir(trashDir);
	const dest = await reserveTrashName(trashDir, basename(path));
	try {
		await io.rename(path, dest);
		return;
	} catch (error) {
		if (error.code !== "EXDEV") throw error;
	}
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
/** Remove every child of `dir`, keeping the directory itself. */
async function emptyDirectory(dir) {
	for (const entry of await readdir(dir)) await rm(join(dir, entry), {
		recursive: true,
		force: false
	});
}
/**
* Reclaim the selected junk items. All ids pass the structural validation
* chain first — one invalid id rejects the whole batch with zero deletions.
* Per item: vanished targets report `not_found`; re-measure failure skips the
* item untouched; trash mode tiers through /usr/bin/trash, rename into
* ~/.Trash, and cross-volume copy+remove. The `trash` kind empties its
* children in place (moving entries of the Trash back into the Trash would be
* a no-op). Failures surface per-item, never silently.
*/
async function cleanJunk(ids, mode, targets = resolveTargets(), options = {}) {
	assertMacOS();
	if (ids.length === 0) throw new PcManagerError("invalid_argument", "cleanJunk requires at least one junk item id.");
	const home = options.home ?? homedir();
	const io = {
		...defaultIo,
		...options.io
	};
	await validateJunkIds(ids, await expandGlobs(targets), home);
	const trashBinUsable = mode === "trash" && (options.io?.runTrashCommand !== void 0 || await canExecute("/usr/bin/trash"));
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
			if (kind === "trash") await emptyDirectory(path);
			else if (mode === "delete") await rm(path, {
				recursive: true,
				force: false
			});
			else await moveToTrash(path, home, io, trashBinUsable);
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
					type: "array",
					required: true,
					items: { type: "number" }
				}
			}
		},
		gpu: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: { usagePercent: nullable({ type: "number" }) }
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
		description: "Read one system status snapshot: CPU model/cores/utilization/load average, GPU utilization (best-effort), memory pressure breakdown with swap, disk I/O throughput and per-volume usage, battery/power, per-interface network counters, and ranked processes (CPU, memory, or network). Read-only; safe to call any time.",
		parameters: {},
		output: {
			schema: { oneOf: [STATUS_SCHEMA, ERROR_SCHEMA] },
			render: renderValue
		},
		execute: () => guarded(() => collectStatus(config.maxTopProcesses)),
		presentCall: () => present("System status", "read")
	}));
	ctx.tools.register(defineTool({
		name: "pc_junk_scan",
		description: "Enumerate reclaimable junk on this Mac — Trash, user caches/logs, system temp, iOS device backups, Xcode build artifacts, simulator leftovers, and package-manager caches — with per-item sizes, safety notes, and suggested commands for items that must not be deleted directly. Always a dry run: scanning deletes nothing. After scanning, present a per-category summary to the user and ask which categories or items to clean — prefer the ask_user_question tool for that choice when it is available — before ever calling pc_junk_clean.",
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
		description: "Reclaim the junk items whose exact ids were returned by pc_junk_scan. Only call this after the user has explicitly confirmed the exact selection and the destination (Trash by default, recoverable); restate the items and sizes when asking, prefer ask_user_question for the confirmation when available. Permanent deletion is only possible when the host config sets moveToTrash to false — say so instead of retrying if the user asks for it. Items from targets marked safeToClean:false are refused with unsafe_target; relay their suggested commands instead. Refuses with disabled_by_config until the host enables junk cleaning; a host-side approval prompt may also confirm the run.",
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
		description: "List installed applications (app bundles and Homebrew formulae/casks) with sizes and last-launch times when observable. Read-only.",
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
/** Runtime configuration schema. */
const Config = z.object({
	enableJunkClean: z.boolean().default(false),
	enableAppUninstall: z.boolean().default(false),
	moveToTrash: z.boolean().default(true),
	askBeforeJunkClean: z.boolean().default(true),
	maxTopProcesses: z.natural().default(10),
	dashboardPollMs: z.natural().default(DEFAULT_DASHBOARD_POLL_MS)
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
	listeners = /* @__PURE__ */ new Set();
	timer;
	running = false;
	latest;
	inflight;
	processSeen = /* @__PURE__ */ new Map();
	constructor(pollMs, maxTop) {
		this.pollMs = pollMs;
		this.maxTop = maxTop;
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
			const status = await collectStatus(this.maxTop, "cpu", { onProcessTable: (table) => {
				union = unionProcessRows(table, this.maxTop);
			} });
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
function serveDashboard(ctx, pollMs, defaultLimit) {
	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;
		const pump = new SnapshotPump(pollMs, defaultLimit);
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
					const status = requested === defaultLimit && requestedSort === "cpu" ? (await pump.ensureFresh()).status : await collectStatus(requested, requestedSort);
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
	serveDashboard(ctx, pollMs, maxTopProcesses);
	serveJunkFaces(ctx, config);
	registerPcManagerTools(ctx, {
		enableJunkClean: config.enableJunkClean ?? false,
		enableAppUninstall: config.enableAppUninstall ?? false,
		moveToTrash: config.moveToTrash ?? true,
		askBeforeJunkClean: config.askBeforeJunkClean ?? true,
		maxTopProcesses
	});
}
//#endregion
export { Config, DEFAULT_DASHBOARD_POLL_MS, MIN_DASHBOARD_POLL_MS, apply, inject, name };
