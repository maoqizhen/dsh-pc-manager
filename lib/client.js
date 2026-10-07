window.__ModuleLoader__.load({ id: "dsh-pc-manager", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react_jsx_runtime = require("react/jsx-runtime");
let react = require("react");
//#region src/client/cleanup.ts
/**
* The floating monitor's cleanup trigger (§16.9): summons the junk-cleanup
* window — its own right-sidebar tab — which starts scanning on arrival.
* Until apply() wires the opener, the call is a no-op, so the widget stays
* context-free.
*/
let opener = null;
/** Wire the trigger to the plugin context; called once from apply(). */
function bindJunkCleanup(open) {
	opener = open;
}
/** Open (or focus) the junk-cleanup window; it auto-scans on summons. */
function openJunkCleanup() {
	opener?.();
}
//#endregion
//#region src/client/definition.tsx
/** The dashboard tab kind this package owns, and what `openTab` names. */
const PC_MANAGER_KIND = "pc-dashboard";
/** This implementation's identity in the tab system, and the key its body registers under. */
const PC_MANAGER_ID = "@deepseek-ai/dsh-pc-manager";
/** The junk-cleanup tab kind (§16.9): its own window beside System Monitor. */
const JUNK_MANAGER_KIND = "pc-junk";
/** Body seat key for the junk tab; unique from the dashboard's. */
const JUNK_MANAGER_ID = "@deepseek-ai/dsh-pc-manager/junk";
/** Self-drawn gauge glyph; the shared guide artworks cover only files/browser. */
function GuideArtworkGauge({ size = 36, className }) {
	const half = size / 2;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 36 36",
		className,
		"aria-hidden": true,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: half,
				cy: half,
				r: 13,
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .25,
				strokeWidth: 4
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M 8.5 24.5 A 11 11 0 1 1 27.5 24.5",
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .9,
				strokeWidth: 4,
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
				x1: half,
				y1: half,
				x2: 22.5,
				y2: 14,
				stroke: "currentColor",
				strokeWidth: 2.5,
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: half,
				cy: half,
				r: 2,
				fill: "currentColor"
			})
		]
	});
}
/**
* Self-drawn wastebasket glyph in the gauge's stroke language: round caps,
* currentColor, the 0.9/0.25 opacity ladder for body versus interior.
*/
function GuideArtworkTrash({ size = 36, className }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 36 36",
		className,
		"aria-hidden": true,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M 14 9.5 H 22",
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .9,
				strokeWidth: 3,
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M 9.5 13.5 H 26.5",
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .9,
				strokeWidth: 3,
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M 12 13.5 L 13.3 26.2 A 2.2 2.2 0 0 0 15.5 28.2 H 20.5 A 2.2 2.2 0 0 0 22.7 26.2 L 24 13.5",
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .9,
				strokeWidth: 3,
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M 15.6 18.5 L 16.1 23.5",
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .25,
				strokeWidth: 2.5,
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M 20.4 18.5 L 19.9 23.5",
				fill: "none",
				stroke: "currentColor",
				strokeOpacity: .25,
				strokeWidth: 2.5,
				strokeLinecap: "round"
			})
		]
	});
}
/**
* The dashboard type's registry definition.
* @param t - namespace-bound translate, read fresh on every label call.
* @returns the definition to register.
*/
function pcManagerDefinition(t) {
	return {
		id: PC_MANAGER_ID,
		kind: PC_MANAGER_KIND,
		title: () => t("type.label"),
		guide: [{
			id: "dashboard",
			order: 30,
			title: () => t("guide.title"),
			description: () => t("guide.description"),
			icon: GuideArtworkGauge
		}]
	};
}
/**
* The junk-cleanup type's registry definition: its own full pane (§16.9),
* opened from its guide entry or summoned by the floating monitor.
* @param t - namespace-bound translate, read fresh on every label call.
* @returns the definition to register.
*/
function junkManagerDefinition(t) {
	return {
		id: JUNK_MANAGER_ID,
		kind: JUNK_MANAGER_KIND,
		title: () => t("junk.type.label"),
		guide: [{
			id: "junk",
			order: 31,
			title: () => t("junk.guide.title"),
			description: () => t("junk.guide.description"),
			icon: GuideArtworkTrash
		}]
	};
}
//#endregion
//#region src/client/face.ts
/**
* The dashboard's shared data base: ONE EventSource over the host's
* `/pc-manager/stream` pump feeds every consumer (dashboard tab, floating
* widget, future surfaces). The store reference-counts live consumers — the
* connection opens with the first and closes with the last, so a fully hidden
* dashboard costs the server nothing. Rates arrive server-derived in each
* frame, so even the first frame is usable.
*/
/** Fallback poll interval until the first frame names the pump's interval. */
const DEFAULT_POLL_MS = 2e3;
let state$1 = {
	sample: null,
	history: {
		cpu: [],
		diskIo: [],
		netRx: [],
		netTx: []
	},
	pollMs: DEFAULT_POLL_MS,
	error: null,
	stale: false,
	connected: false
};
const history = {
	cpu: [],
	diskIo: [],
	netRx: [],
	netTx: []
};
const listeners$1 = /* @__PURE__ */ new Set();
let source;
let refCount = 0;
let lastFrameAt = 0;
let watchdog;
let reconnectTimer;
let lastReconnectAt = 0;
/** Force a reconnect no closer than this to the previous one (retry storm guard). */
const RECONNECT_FLOOR_MS = 2e3;
/** A connection this long without a frame is dead weight even if open. */
const FRAME_TIMEOUT_MS = 15e3;
function clearReconnectTimer() {
	if (reconnectTimer !== void 0) {
		clearTimeout(reconnectTimer);
		reconnectTimer = void 0;
	}
}
function scheduleReconnect() {
	clearReconnectTimer();
	if (refCount === 0) return;
	const waited = Date.now() - lastReconnectAt;
	const delay = Math.max(0, RECONNECT_FLOOR_MS - waited);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = void 0;
		if (refCount > 0) openStream();
	}, delay);
}
function stopWatchdog() {
	if (watchdog !== void 0) clearInterval(watchdog);
	watchdog = void 0;
}
function notify(patch) {
	state$1 = {
		...state$1,
		...patch
	};
	for (const listener of listeners$1) listener();
}
function push(key, value) {
	const buffer = history[key];
	buffer.push(value);
	if (buffer.length > 60) buffer.splice(0, buffer.length - 60);
}
function ingest(frame) {
	lastFrameAt = Date.now();
	const netRates = new Map(Object.entries(frame.netRates));
	const processRates = new Map(Object.entries(frame.processRates ?? {}).map(([pid, rate]) => [Number(pid), rate]));
	let rxPerSec = 0;
	let txPerSec = 0;
	for (const rate of netRates.values()) {
		rxPerSec += rate.rxPerSec;
		txPerSec += rate.txPerSec;
	}
	push("cpu", frame.status.cpu.usagePercent ?? 0);
	push("diskIo", frame.status.diskIo.totalBytesPerSec ?? 0);
	push("netRx", rxPerSec);
	push("netTx", txPerSec);
	notify({
		sample: {
			status: frame.status,
			netRates,
			processRates,
			topByNetwork: frame.topByNetwork ?? [],
			rxPerSec,
			txPerSec
		},
		history: {
			cpu: [...history.cpu],
			diskIo: [...history.diskIo],
			netRx: [...history.netRx],
			netTx: [...history.netTx]
		},
		pollMs: Math.max(500, frame.pollMs),
		error: null,
		stale: false
	});
}
function openStream() {
	source?.close();
	stopWatchdog();
	lastReconnectAt = Date.now();
	const stream = new EventSource("/pc-manager/stream");
	source = stream;
	stream.onopen = () => notify({
		connected: true,
		error: null
	});
	stream.onmessage = (event) => {
		try {
			ingest(JSON.parse(event.data));
		} catch (error) {
			notify({
				error: error instanceof Error ? error.message : String(error),
				stale: true
			});
		}
	};
	stream.onerror = () => {
		notify({
			connected: false,
			stale: state$1.sample !== null,
			error: null
		});
		if (stream.readyState === EventSource.CLOSED) {
			source = void 0;
			scheduleReconnect();
			return;
		}
	};
	watchdog = setInterval(() => {
		if (refCount === 0 || lastFrameAt === 0) return;
		if (Date.now() - lastFrameAt > FRAME_TIMEOUT_MS) openStream();
	}, 5e3);
}
function acquire() {
	refCount += 1;
	if (refCount === 1) {
		lastFrameAt = 0;
		openStream();
	}
	return () => {
		refCount = Math.max(0, refCount - 1);
		if (refCount === 0) {
			clearReconnectTimer();
			stopWatchdog();
			source?.close();
			source = void 0;
			notify({
				connected: false,
				stale: false
			});
		}
	};
}
function subscribe(listener) {
	listeners$1.add(listener);
	return () => listeners$1.delete(listener);
}
function getStoreState() {
	return state$1;
}
/** Force a reconnect (the retry affordance on the error banner). */
function refetchStream() {
	if (refCount > 0) openStream();
}
/**
* Fetch a non-default process ranking over the fallback HTTP route. Only the
* memory ranking needs this (full-table ranking, no cross-frame state); the
* network-by-rate ranking rides in every stream frame (`topByNetwork`),
* because only the pump can difference per-pid windows.
*/
function fetchProcessRows(sort, signal) {
	return fetch(`/pc-manager/status?processSort=${encodeURIComponent(sort)}`, { signal }).then((response) => {
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	}).then((status) => status.topProcesses);
}
/** One-shot read-only junk scan for the plan card; caller owns the abort. */
function fetchJunkPlan(signal) {
	return fetch("/pc-manager/junk/scan", { signal }).then((response) => {
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	});
}
/**
* Execute the checked ids directly from the plan card — no LLM involved. The
* host applies the same config gate and validation chain as the tool path.
* Resolves with the per-item outcomes; rejects with a code-tagged Error.
*/
function postJunkClean(ids, signal) {
	return fetch("/pc-manager/junk/clean", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids }),
		signal
	}).then(async (response) => {
		const payload = await response.json();
		if (!response.ok) {
			const err = payload;
			throw Object.assign(new Error(err.message !== void 0 ? err.message : `HTTP ${response.status}`), { code: err.code ?? "internal_error" });
		}
		return payload;
	});
}
/**
* Subscribe this component to the shared stream base. Every mounted consumer
* with `visible: true` holds one reference; the underlying EventSource opens
* with the first and closes with the last. All consumers see the same frames.
*/
function usePcStatus({ visible }) {
	const snapshot = (0, react.useSyncExternalStore)(subscribe, getStoreState);
	(0, react.useEffect)(() => visible ? acquire() : void 0, [visible]);
	return {
		sample: snapshot.sample,
		history: snapshot.history,
		pollMs: snapshot.pollMs,
		error: snapshot.error,
		loading: snapshot.sample === null,
		stale: snapshot.stale,
		refetch: refetchStream
	};
}
/** 1024-based byte size with a unit suffix (`10.9 GB`). */
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	const units = [
		"B",
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
/** Byte rate with a per-second suffix (`1.2 MB/s`). */
function formatRate(bytesPerSec) {
	return `${formatBytes(bytesPerSec)}/s`;
}
/** Load-average style two-decimal rendering (`2.54`). */
function formatLoad(value) {
	return Number.isFinite(value) ? (Math.round(value * 100) / 100).toString() : "—";
}
/** Uptime as a compact `2d 3h` / `3h 12m` / `45m` string. */
function formatUptime(seconds) {
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
/** Battery estimate as `3:12`. */
function formatMinutes(minutes) {
	if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return "—";
	return `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;
}
//#endregion
//#region src/client/float.tsx
/**
* The floating monitor: a small translucent, draggable overlay with the four
* headline metrics (CPU, GPU, memory, network rates), registered into the
* shell's overlay layer. Visibility and position live in a module store
* persisted to localStorage and shared with the dashboard's toggle button;
* the widget polls the status route on its own while visible and stops when
* hidden or closed.
*/
const STORAGE_KEY = "pc-manager.float.v1";
/** Approximate widget box for viewport clamping; generous beats clipping.
* Four metric rows plus the hairline-separated cleanup action row. */
const FLOAT_WIDTH = 200;
const FLOAT_HEIGHT = 178;
const FLOAT_MARGIN = 8;
/** First-run corner: bottom-left, above the left rail's Settings button. */
function initialPosition() {
	return {
		x: FLOAT_MARGIN,
		y: Math.max(FLOAT_MARGIN, window.innerHeight - FLOAT_HEIGHT - 76)
	};
}
function clampToViewport(x, y) {
	return {
		x: Math.min(Math.max(FLOAT_MARGIN, x), Math.max(FLOAT_MARGIN, window.innerWidth - FLOAT_WIDTH - FLOAT_MARGIN)),
		y: Math.min(Math.max(FLOAT_MARGIN, y), Math.max(FLOAT_MARGIN, window.innerHeight - FLOAT_HEIGHT - FLOAT_MARGIN))
	};
}
function load() {
	if (typeof window === "undefined") return {
		visible: false,
		x: 0,
		y: 0
	};
	const fallback = {
		visible: false,
		...initialPosition()
	};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === null) return fallback;
		const parsed = JSON.parse(raw);
		const position = clampToViewport(typeof parsed.x === "number" ? parsed.x : fallback.x, typeof parsed.y === "number" ? parsed.y : fallback.y);
		return {
			visible: parsed.visible === true,
			...position
		};
	} catch {
		return fallback;
	}
}
let state = load();
const listeners = /* @__PURE__ */ new Set();
/** The dashboard toggle and the widget both read/write through this store. */
function subscribeFloat(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
function getFloatState() {
	return state;
}
function setFloatState(patch) {
	const next = {
		...state,
		...patch
	};
	state = typeof patch.x === "number" || typeof patch.y === "number" ? {
		...next,
		...clampToViewport(next.x, next.y)
	} : next;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {}
	for (const listener of listeners) listener();
}
/** One metric line: muted label left, tabular value right. */
function FloatRow({ label, value }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-float-row",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pc-float-label",
			children: label
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pc-float-value",
			children: value
		})]
	});
}
/**
* The widget body registered in `shell.overlay`: renders nothing while hidden,
* so its poller (keyed on visibility) is dormant too. The whole card is the
* drag handle except the close button; pointercancel, lost capture, and
* pointerup all end the drag so an interrupted gesture never sticks.
*/
function FloatingMonitor({ t }) {
	const { visible } = (0, react.useSyncExternalStore)(subscribeFloat, getFloatState);
	const { sample, error, stale } = usePcStatus({
		visible,
		pollMs: DEFAULT_POLL_MS,
		sort: "cpu"
	});
	const dragRef = (0, react.useRef)(null);
	const [dragging, setDragging] = (0, react.useState)(false);
	(0, react.useEffect)(() => {
		const onResize = () => {
			const { x, y } = getFloatState();
			setFloatState(clampToViewport(x, y));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	const endDrag = (event) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {}
	};
	if (!visible) return null;
	const { x, y } = getFloatState();
	const status = sample?.status ?? null;
	const value = (readable) => error !== null ? "—" : readable ?? "…";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-float",
		"data-dragging": dragging,
		"data-stale": stale,
		role: "complementary",
		"aria-label": t("float.aria"),
		style: {
			left: x,
			top: y
		},
		onPointerDown: (event) => {
			if (event.target.closest("button") !== null) return;
			const position = getFloatState();
			dragRef.current = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				origX: position.x,
				origY: position.y
			};
			setDragging(true);
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		onPointerMove: (event) => {
			const drag = dragRef.current;
			if (drag === null || drag.pointerId !== event.pointerId) return;
			setFloatState({
				x: drag.origX + event.clientX - drag.startX,
				y: drag.origY + event.clientY - drag.startY
			});
		},
		onPointerUp: endDrag,
		onPointerCancel: endDrag,
		onLostPointerCapture: endDrag,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "pc-float-close",
				"aria-label": t("float.close"),
				onClick: () => setFloatState({ visible: false }),
				children: "✕"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FloatRow, {
				label: t("card.cpu"),
				value: value(status === null ? null : `${status.cpu.usagePercent?.toFixed(1) ?? "—"}%`)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FloatRow, {
				label: t("card.gpu"),
				value: value(status === null ? null : `${status.gpu.usagePercent?.toFixed(1) ?? "—"}%`)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FloatRow, {
				label: t("card.memory"),
				value: value(status === null ? null : `${formatBytes(status.memory.usedBytes)} / ${formatBytes(status.memory.totalBytes)}`)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FloatRow, {
				label: t("card.network"),
				value: value(sample === null ? null : `↓${formatRate(sample.rxPerSec)} ↑${formatRate(sample.txPerSec)}`)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-float-action",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-float-label",
					children: t("cleanup.label")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "pc-action-pill",
					onClick: () => openJunkCleanup(),
					children: t("cleanup.scan")
				})]
			})
		]
	});
}
//#endregion
//#region src/client/styles.ts
/**
* The plugin stylesheet, injected once per document. Lives outside the
* dashboard component on purpose: the floating widget renders in the shell
* overlay whether or not the dashboard tab is mounted, and its styles must
* not depend on any particular surface having mounted first.
*/
const CSS = `
.pc-manager-body { --pcm-warn: var(--dsw-alias-state-warn-primary, currentColor);
  --pcm-critical: var(--dsw-alias-state-error-primary, currentColor);
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  font-size: 12px; line-height: 1.45; min-height: 100%; box-sizing: border-box;
  container-type: inline-size; }
.pc-manager-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  padding: 0 2px 2px; }
.pc-manager-host { font-size: 13px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.pc-manager-uptime { color: color-mix(in srgb, currentColor 62%, transparent); white-space: nowrap; }
.pc-manager-header-right { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.pc-manager-float-toggle { font: inherit; font-size: 11px; padding: 2px 10px; min-height: 24px;
  border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: transparent; color: inherit; cursor: pointer; }
.pc-manager-float-toggle:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.pc-manager-float-toggle[data-active='true'] {
  background: color-mix(in srgb, currentColor 14%, transparent); font-weight: 600; }
.pc-float { position: fixed; min-width: 176px; max-width: 230px; padding: 8px 28px 8px 10px;
  display: flex; flex-direction: column; gap: 3px; font-size: 11px; line-height: 1.45;
  border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  background: color-mix(in srgb, currentColor 7%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 4px 14px color-mix(in srgb, currentColor 10%, transparent);
  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  transition: opacity 0.2s ease; }
.pc-float[data-stale='true'] { opacity: 0.55; }
.pc-float[data-dragging='true'] { cursor: grabbing; }
.pc-float-row { display: flex; justify-content: space-between; gap: 12px; }
.pc-float-label { color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-float-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.pc-float-action { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 4px; padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.pc-action-pill { font: inherit; font-size: 11px; padding: 2px 10px; min-height: 24px;
  border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
.pc-action-pill:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.pc-action-pill:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.pc-manager-cleanup-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pc-manager-cleanup-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pc-manager-cleanup-hint { font-size: 11px;
  color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-plan-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pc-manager-plan-hint { font-size: 11px;
  color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-junk { display: flex; flex-direction: column; gap: 10px; padding: 12px;
  font-size: 12px; line-height: 1.45; min-height: 100%; box-sizing: border-box; }
.pc-manager-junk-head { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 0 2px; }
.pc-manager-junk-lead { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; flex-wrap: wrap; }
.pc-manager-junk-sk { min-height: 120px; }
.pc-manager-plan-groups { display: flex; flex-direction: column; gap: 8px; }
.pc-manager-group { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pc-manager-group-head { display: flex; align-items: center; gap: 6px; }
.pc-manager-group-spacer { width: 13px; flex: none; }
.pc-manager-group-title { font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.pc-manager-group-bytes { margin-left: auto; font-size: 11px; white-space: nowrap;
  color: color-mix(in srgb, currentColor 62%, transparent);
  font-variant-numeric: tabular-nums; }
.pc-manager-group-sub { display: flex; align-items: center; gap: 6px; min-width: 0;
  padding-left: 19px; }
.pc-manager-group-preview { flex: 1; min-width: 0; font-size: 11px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-disclosure { font: inherit; font-size: 11px; min-height: 24px; padding: 2px 6px;
  border: none; background: none; color: color-mix(in srgb, currentColor 62%, transparent);
  cursor: pointer; white-space: nowrap; border-radius: 4px; }
.pc-manager-disclosure:hover { color: currentColor; }
.pc-manager-disclosure:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.pc-manager-itemlist { display: flex; flex-direction: column; gap: 2px; min-width: 0;
  max-height: 180px; overflow-y: auto; padding: 4px 0 4px 19px;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
.pc-manager-group-note { font-size: 11px;
  color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-group-note[data-tone='error'] { color: var(--pcm-critical); }
.pc-manager-confirm { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: 8px;
  background: color-mix(in srgb, currentColor 5%, transparent); }
.pc-manager-confirm-title { font-size: 12px; }
.pc-manager-confirm-actions { display: flex; justify-content: flex-end; gap: 6px; }
.pc-action-pill[data-primary='true'] { font-weight: 600;
  border-color: color-mix(in srgb, currentColor 45%, transparent);
  background: color-mix(in srgb, currentColor 12%, transparent); }
.pc-action-pill[data-primary='true']:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
.pc-manager-item { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pc-manager-item-name { flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.pc-manager-item-bytes { font-size: 11px; white-space: nowrap;
  color: color-mix(in srgb, currentColor 62%, transparent);
  font-variant-numeric: tabular-nums; }
.pc-manager-item[data-disabled='true'] { opacity: 0.55; }
.pc-manager-plan-foot { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.pc-manager-plan-sum { font-size: 11px;
  color: color-mix(in srgb, currentColor 62%, transparent);
  font-variant-numeric: tabular-nums; }
.pc-manager-plan-sum[data-empty='true'] { color: inherit; }
.pc-action-pill:disabled { opacity: 0.5; cursor: default; }
.pc-action-pill:disabled:hover { background: transparent; }
.pc-manager-plan input[type='checkbox'] { accent-color: currentColor;
  margin: 0; flex: none; width: 13px; height: 13px; cursor: pointer; }
.pc-manager-plan input[type='checkbox']:disabled { cursor: default; }
.pc-float-close { position: absolute; top: 2px; right: 2px; min-width: 24px; min-height: 24px;
  display: flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1;
  padding: 0; border: none; border-radius: 4px; background: none;
  color: color-mix(in srgb, currentColor 62%, transparent); cursor: pointer; }
.pc-float-close:hover { color: currentColor; }
.pc-float-close:focus-visible { outline: 1.5px solid currentColor; outline-offset: 1px; }
.pc-manager-cards { columns: 1; column-gap: 10px; min-width: 0;
  transition: opacity 0.25s ease; }
.pc-manager-cards > .pc-manager-card { break-inside: avoid; margin-bottom: 10px; }
@container (min-width: 900px) {
  .pc-manager-cards { columns: 2; }
}
.pc-manager-body[data-stale='true'] .pc-manager-cards { opacity: 0.55; }
.pc-manager-card { border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 8px; padding: 9px 10px; display: flex; flex-direction: column; gap: 6px;
  background: color-mix(in srgb, currentColor 3%, transparent); min-width: 0;
  box-sizing: border-box; }
.pc-manager-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.pc-manager-label { font-weight: 600; }
.pc-manager-value { font-variant-numeric: tabular-nums; }
.pc-manager-value[data-tone='critical'] { color: var(--pcm-critical); font-weight: 600; }
.pc-manager-muted { color: color-mix(in srgb, currentColor 62%, transparent);
  font-variant-numeric: tabular-nums; }
.pc-manager-wrap { display: flex; flex-wrap: wrap; gap: 2px 8px; }
.pc-manager-sub { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.pc-manager-bar { position: relative; height: 6px; border-radius: 3px; overflow: hidden;
  background: color-mix(in srgb, currentColor 12%, transparent); }
.pc-manager-bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px;
  background: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-bar-fill[data-tone='warn'] { background: var(--pcm-warn); }
.pc-manager-bar-fill[data-tone='critical'] { background: var(--pcm-critical); }
.pc-manager-spark { width: 100%; height: 26px; display: block; color: inherit;
  opacity: 0.75; }
.pc-manager-netrow { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pc-manager-netlabel { font-size: 11px;
  color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-vol { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pc-manager-tablewrap { overflow-x: auto; min-width: 0; border-radius: 4px;
  transition: opacity 0.2s ease; }
.pc-manager-tablewrap:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.pc-manager-tablewrap[data-loading='true'] { opacity: 0.65; }
.pc-manager-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.pc-manager-table th { text-align: right; font-weight: 500; font-size: 11px;
  color: color-mix(in srgb, currentColor 62%, transparent); padding: 1px 2px 3px; }
.pc-manager-table td { text-align: right; padding: 1px 2px; white-space: nowrap; }
.pc-manager-thbtn { font: inherit; font-size: 11px; padding: 2px 3px; min-height: 24px;
  color: color-mix(in srgb, currentColor 62%, transparent); background: none; border: none;
  cursor: pointer; font-variant-numeric: tabular-nums; }
.pc-manager-thbtn:hover { color: currentColor; }
.pc-manager-thbtn:focus-visible { outline: 2px solid currentColor; outline-offset: 1px;
  border-radius: 2px; }
.pc-manager-thbtn[data-active='true'] { color: currentColor; font-weight: 600; }
.pc-manager-table th.pc-manager-left, .pc-manager-table td.pc-manager-left { text-align: left; }
.pc-manager-cmd { max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
@container (max-width: 419px) {
  .pc-manager-col-optional { display: none; }
}
.pc-manager-error { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; font-size: 11px;
  border: 1px solid color-mix(in srgb, var(--pcm-critical) 45%, transparent);
  color: var(--pcm-critical); }
.pc-manager-error button { font: inherit; font-size: 11px; min-height: 24px; padding: 2px 10px;
  border-radius: 999px; border: 1px solid currentColor; background: transparent;
  color: inherit; cursor: pointer; }
.pc-manager-error button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.pc-manager-error button:disabled { opacity: 0.5; cursor: default; }
.pc-manager-state { padding: 20px 12px; text-align: center;
  color: color-mix(in srgb, currentColor 62%, transparent); }
.pc-manager-sr { position: absolute; width: 1px; height: 1px; clip-path: inset(50%);
  overflow: hidden; white-space: nowrap; }
.pc-manager-sk { min-height: 64px; animation: pcm-pulse 1.4s ease-in-out infinite; }
.pc-manager-sk-wide { min-height: 190px; }
@keyframes pcm-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .pc-manager-sk { animation: none; opacity: 0.7; }
  .pc-manager-cards, .pc-manager-tablewrap { transition: none; }
}
`;
/** Inject the card styles once per document; mirrors the loader's style tagging. */
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector("style[data-plugin-css=\"@deepseek-ai/dsh-pc-manager\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.pluginCss = "@deepseek-ai/dsh-pc-manager";
	tag.textContent = CSS;
	document.head.appendChild(tag);
}
//#endregion
//#region src/client/DashboardBody.tsx
/**
* The dashboard tab's body: metric cards over a polled status snapshot, drawn
* with hand-rolled SVG (usage bars and sparklines — the shell shares no chart
* library). Pure presentation: every value comes from the hook, every label
* from the locale dictionary. Color keeps the zero-palette discipline — every
* hue derives from currentColor, except the semantic state tones that come
* from the host's own tokens when it exposes them.
*/
/**
* Card corners and rhythm; opacity-based fills adapt to both color schemes.
* Semantic tones come from the host's state tokens with a currentColor
* fallback, so a shell without them degrades to the monochrome ladder.
* Layout: the body is a size container — cards snap to a two-column grid on
* wide panes, and optional table columns drop below 420px instead of
* overflowing.
*/
/** Percent with one decimal everywhere, matching the process table. */
function percentLabel(value) {
	return value === null ? "—" : `${value.toFixed(1)}%`;
}
/** Semantic load tone: glance-readable without reading the number. */
function toneOf(percent) {
	if (percent === null) return "ok";
	if (percent >= 95) return "critical";
	if (percent >= 85) return "warn";
	return "ok";
}
/** Battery tone is inverted by nature: a high charge is healthy, a low one
* is the warning — the load thresholds must not leak in here. */
function batteryTone(percent) {
	if (percent === null) return "ok";
	if (percent <= 20) return "critical";
	if (percent <= 35) return "warn";
	return "ok";
}
/** One usage bar with its 0–100 fill; doubles as a progressbar for assistive
* tech. `tone` overrides the load-derived tone (battery semantics differ). */
function UsageBar({ percent, label, tone }) {
	const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "pc-manager-bar",
		role: "progressbar",
		"aria-label": label,
		"aria-valuemin": 0,
		"aria-valuemax": 100,
		"aria-valuenow": percent === null ? void 0 : Math.round(clamped),
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "pc-manager-bar-fill",
			"data-tone": tone ?? toneOf(percent),
			style: { width: `${clamped}%` }
		})
	});
}
/** Filled sparkline over the sample history; scales to the window's (shared) max. */
function Sparkline({ values, max }) {
	if (values.length < 2) return null;
	const top = Math.max(...values, max ?? 1);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		className: "pc-manager-spark",
		viewBox: "0 0 100 24",
		preserveAspectRatio: "none",
		"aria-hidden": true,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", {
			points: values.map((value, index) => {
				const x = index / (values.length - 1) * 100;
				const y = 24 - value / top * 21;
				return `${x.toFixed(2)},${y.toFixed(2)}`;
			}).join(" "),
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.4,
			vectorEffect: "non-scaling-stroke"
		})
	});
}
function cardHeading(label, value, tone) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-manager-row",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pc-manager-label",
			children: label
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pc-manager-value",
			"data-tone": tone === "critical" ? "critical" : void 0,
			children: value
		})]
	});
}
/** The interface worth headlining: busiest by lifetime traffic, so an idle
* moment does not promote a dead interface over the one carrying history. */
function topInterface(sample) {
	let best = null;
	for (const iface of sample.status.network) {
		const rate = sample.netRates.get(iface.interface);
		if (rate === void 0) continue;
		const lifetime = iface.rxBytes + iface.txBytes;
		if (best === null || lifetime > best.lifetime) best = {
			name: iface.interface,
			rxPerSec: rate.rxPerSec,
			txPerSec: rate.txPerSec,
			lifetime
		};
	}
	return best === null ? null : {
		name: best.name,
		rxPerSec: best.rxPerSec,
		txPerSec: best.txPerSec
	};
}
/** Volume rows worth a dashboard card: the boot volume, its Data overlay, and
* user data mounts. Recovery is a frozen system volume; the domain snapshot
* keeps every volume for the model. */
function dashboardVolumes(disks) {
	return disks.filter((disk) => disk.mount === "/" || disk.mount === "/System/Volumes/Data" || disk.mount.startsWith("/Volumes/") && disk.mount !== "/Volumes/Recovery");
}
function CpuCard({ status, history, t }) {
	const usage = status.cpu.usagePercent;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "pc-manager-card",
		children: [
			cardHeading(t("card.cpu"), percentLabel(usage), toneOf(usage)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBar, {
				percent: usage,
				label: t("card.cpu")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Sparkline, { values: history.cpu }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-sub",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-muted",
					children: t("cpu.loadavg", {
						one: formatLoad(status.cpu.loadavg[0]),
						five: formatLoad(status.cpu.loadavg[1]),
						fifteen: formatLoad(status.cpu.loadavg[2])
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-muted",
					children: t("cpu.cores", { cores: status.cpu.cores })
				})]
			})
		]
	});
}
function MemoryCard({ status, t }) {
	const { memory } = status;
	const percent = memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes * 100 : null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "pc-manager-card",
		children: [
			cardHeading(t("card.memory"), `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`, toneOf(percent)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBar, {
				percent,
				label: t("card.memory")
			}),
			memory.swapTotalBytes !== null && memory.swapTotalBytes > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pc-manager-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-muted",
					children: t("memory.swap", {
						used: formatBytes(memory.swapUsedBytes ?? 0),
						total: formatBytes(memory.swapTotalBytes)
					})
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pc-manager-wrap",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-muted",
					children: t("memory.detail", {
						app: formatBytes(memory.appMemoryBytes),
						wired: formatBytes(memory.wiredBytes ?? 0),
						compressed: formatBytes(memory.compressedBytes ?? 0),
						cached: formatBytes(memory.cachedBytes ?? 0)
					})
				})
			})
		]
	});
}
function DisksCard({ status, t }) {
	const io = status.diskIo.totalBytesPerSec;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "pc-manager-card",
		children: [cardHeading(t("card.disks"), io === null ? "—" : `I/O ${formatRate(io)}`), dashboardVolumes(status.disks).map((disk) => {
			const percent = disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes * 100 : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-vol",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pc-manager-row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pc-manager-muted",
						children: disk.mount === "/" ? "macOS" : disk.mount
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "pc-manager-muted",
						children: [
							formatBytes(disk.usedBytes),
							" / ",
							formatBytes(disk.totalBytes)
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBar, {
					percent,
					label: disk.mount === "/" ? "macOS" : disk.mount
				})]
			}, disk.mount);
		})]
	});
}
function BatteryCard({ status, t }) {
	const battery = status.battery;
	if (battery === null) return null;
	const state = battery.charging === true ? t("battery.state.charging") : battery.powerSource === "AC Power" ? t("battery.state.ac") : t("battery.state.discharging");
	const facts = [battery.healthPercent !== null ? t("battery.health", { health: battery.healthPercent.toFixed(1) }) : null, battery.cycleCount !== null ? t("battery.cycles", { cycles: battery.cycleCount }) : null].filter((fact) => fact !== null);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "pc-manager-card",
		children: [
			cardHeading(t("card.battery"), `${battery.percent === null ? "—" : battery.percent.toFixed(1)}% · ${state}`),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBar, {
				percent: battery.percent,
				tone: batteryTone(battery.percent),
				label: t("card.battery")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-sub",
				children: [facts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-muted",
					children: facts.join(" · ")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}), battery.timeRemainingMinutes !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-muted",
					children: t("battery.remaining", { time: formatMinutes(battery.timeRemainingMinutes) })
				})]
			})
		]
	});
}
function NetworkCard({ sample, history, t }) {
	const top = topInterface(sample);
	const sharedMax = Math.max(...history.netRx, ...history.netTx, 1);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "pc-manager-card",
		children: [
			cardHeading(t("card.network"), top === null ? t("network.noData") : `${top.name} ↓${formatRate(top.rxPerSec)} ↑${formatRate(top.txPerSec)}`),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-netrow",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-netlabel",
					children: t("network.rxLabel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Sparkline, {
					values: history.netRx,
					max: sharedMax
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-netrow",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-netlabel",
					children: t("network.txLabel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Sparkline, {
					values: history.netTx,
					max: sharedMax
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "pc-manager-sr",
				children: t("network.trendSr")
			})
		]
	});
}
/** Process basename for the table (the full command stays in the title tooltip). */
function shortCommand(command) {
	return command.includes("/") ? command.split("/").pop() ?? command : command;
}
/** The column header label of a sort key, reused by aria-labels and the region name. */
function sortKeyLabel(key, t) {
	return t(key === "pid" ? "process.column.pid" : key === "mem" ? "process.column.mem" : key === "network" ? "process.column.net" : "process.column.cpu");
}
function ProcessCard({ rows, sort, dir, onSortChange, loading, processRates, t }) {
	const hasNet = rows.some((row) => row.netRxBytes !== null || row.netTxBytes !== null);
	const hasGpu = rows.some((row) => row.gpuPercent !== null);
	const hasDisk = rows.some((row) => row.diskReadBytes !== null || row.diskWrittenBytes !== null);
	const tableLabel = t("process.tableLabel", { sort: sortKeyLabel(sort, t) });
	const display = sort === "pid" ? [...rows].sort((left, right) => dir === "desc" ? right.pid - left.pid : left.pid - right.pid) : dir === "desc" ? rows : [...rows].reverse();
	const ariaSort = (key) => sort === key ? dir === "desc" ? "descending" : "ascending" : void 0;
	const sortButton = (key, label) => {
		const active = sort === key;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "pc-manager-thbtn",
			"data-active": active,
			"aria-label": t("process.sortBy", { sort: label }),
			onClick: () => onSortChange(key, active && dir === "desc" ? "asc" : "desc"),
			children: [label, active ? dir === "desc" ? " ▾" : " ▴" : ""]
		});
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "pc-manager-card",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "pc-manager-row",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "pc-manager-label",
				children: t("card.processes")
			})
		}), rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "pc-manager-muted",
			children: t("process.empty")
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "pc-manager-tablewrap",
			role: "region",
			"aria-label": tableLabel,
			tabIndex: 0,
			"aria-busy": loading,
			"data-loading": loading,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
				className: "pc-manager-table",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						className: "pc-manager-left",
						children: t("process.column.command")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						"aria-sort": ariaSort("pid"),
						children: sortButton("pid", t("process.column.pid"))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						"aria-sort": ariaSort("cpu"),
						children: sortButton("cpu", t("process.column.cpu"))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						"aria-sort": ariaSort("mem"),
						children: sortButton("mem", t("process.column.mem"))
					}),
					hasNet && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						className: "pc-manager-col-optional",
						"aria-sort": ariaSort("network"),
						children: sortButton("network", t("process.column.net"))
					}),
					hasGpu && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						className: "pc-manager-col-optional",
						children: t("process.column.gpu")
					}),
					hasDisk && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						className: "pc-manager-col-optional",
						children: t("process.column.disk")
					})
				] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: display.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
						className: "pc-manager-left pc-manager-cmd",
						title: row.command,
						children: shortCommand(row.command)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.pid }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [row.cpuPercent.toFixed(1), "%"] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatBytes(row.rssBytes) }),
					hasNet && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
						className: "pc-manager-col-optional",
						children: (() => {
							const rate = processRates.get(row.pid);
							return rate === void 0 ? t("process.unavailable") : `↓${formatRate(rate.rxPerSec)} ↑${formatRate(rate.txPerSec)}`;
						})()
					}),
					hasGpu && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
						className: "pc-manager-col-optional",
						children: row.gpuPercent === null ? t("process.unavailable") : `${row.gpuPercent}%`
					}),
					hasDisk && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
						className: "pc-manager-col-optional",
						children: row.diskReadBytes === null ? t("process.unavailable") : formatBytes(row.diskReadBytes)
					})
				] }, row.pid)) })]
			})
		})]
	});
}
/** Loading placeholder mirroring the card rhythm, so arrival does not jump. */
function SkeletonBody({ error, onRetry, loading, t }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-manager-body",
		children: [
			error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorBanner, {
				error,
				stale: false,
				onRetry,
				loading,
				t
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-cards",
				"aria-hidden": true,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "pc-manager-card pc-manager-sk" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "pc-manager-card pc-manager-sk" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "pc-manager-card pc-manager-sk" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "pc-manager-card pc-manager-sk pc-manager-sk-wide" })
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pc-manager-state",
				role: "status",
				children: t("loading")
			})
		]
	});
}
function ErrorBanner({ error, stale, onRetry, loading, t }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-manager-error",
		role: "alert",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("error.unavailable", { message: error }), stale ? ` ${t("error.stale")}` : ""] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			onClick: onRetry,
			disabled: loading,
			children: t("error.retry")
		})]
	});
}
/** The keyed tab body: poll, then draw each metric card. */
function DashboardBody(props) {
	const { useTabInfo, t } = props;
	ensureStyles();
	const { tab } = useTabInfo();
	const [sort, setSort] = (0, react.useState)("cpu");
	const [dir, setDir] = (0, react.useState)("desc");
	const floatVisible = (0, react.useSyncExternalStore)(subscribeFloat, getFloatState).visible;
	const fetchSort = sort === "pid" ? "cpu" : sort;
	const { sample, history, error, loading, stale, refetch } = usePcStatus({
		visible: tab.visible,
		pollMs: DEFAULT_POLL_MS,
		sort: fetchSort
	});
	const [rankedRows, setRankedRows] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		if (sort !== "mem") {
			setRankedRows(null);
			return;
		}
		const controller = new AbortController();
		fetchProcessRows(sort, controller.signal).then((rows) => setRankedRows(rows)).catch(() => void 0);
		return () => controller.abort();
	}, [sort, sample?.status.sampledAt ?? ""]);
	/** Header click: a new column starts descending; the active column flips. */
	const onSortChange = (next, nextDir) => {
		setSort(next);
		setDir(nextDir);
	};
	if (sample === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkeletonBody, {
		error,
		onRetry: refetch,
		loading,
		t
	});
	const { status } = sample;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-manager-body",
		"data-stale": stale,
		children: [
			error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorBanner, {
				error,
				stale,
				onRetry: refetch,
				loading,
				t
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-header",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "pc-manager-host",
					children: [status.hostname, status.osVersion !== null ? ` · macOS ${status.osVersion}` : ""]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "pc-manager-header-right",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pc-manager-uptime",
						children: t("uptime.label", { time: formatUptime(status.uptimeSeconds) })
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "pc-manager-float-toggle",
						"aria-pressed": floatVisible,
						"data-active": floatVisible,
						onClick: () => setFloatState({ visible: !floatVisible }),
						children: t("float.toggle")
					})]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-cards",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CpuCard, {
						status,
						history,
						t
					}),
					status.gpu.usagePercent !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "pc-manager-card",
						children: [cardHeading(t("card.gpu"), percentLabel(status.gpu.usagePercent), toneOf(status.gpu.usagePercent)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBar, {
							percent: status.gpu.usagePercent,
							label: t("card.gpu")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryCard, {
						status,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisksCard, {
						status,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BatteryCard, {
						status,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NetworkCard, {
						sample,
						history,
						t
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProcessCard, {
				rows: sort === "network" ? sample.topByNetwork : rankedRows ?? status.topProcesses,
				sort,
				dir,
				onSortChange,
				loading,
				processRates: sample.processRates,
				t
			})
		]
	});
}
//#endregion
//#region src/client/JunkBody.tsx
/**
* The junk-cleanup tab's body (§16.9): the whole plan — scan, kind selection,
* confirmation, execution, brief — as one full pane with zero LLM
* round-trips. Kinds are the selection unit (a screenful of rows, never a
* wall of checkboxes); per-item detail stays folded inside each kind's
* disclosure for surgical edits. The confirm strip is the dashboard-side
* counterpart of the tool path's approval gate: unconditional, one extra
* explicit click, destination and recoverability spelled out.
*
* Navigation params carry the float's summons: `{ autoScan: true }` starts a
* scan on mount and again on every repeated openTab (the navigation revision
* increments each time, even with identical params).
*/
function buildGroups(data, checked) {
	const metaByKind = new Map(data.kindMeta.map((meta) => [meta.kind, meta]));
	const itemsByKind = /* @__PURE__ */ new Map();
	for (const item of data.items) {
		const list = itemsByKind.get(item.kind) ?? [];
		list.push(item);
		itemsByKind.set(item.kind, list);
	}
	return [...itemsByKind.entries()].map(([kind, items]) => {
		const meta = metaByKind.get(kind);
		return {
			kind,
			label: meta?.label ?? kind,
			safeToClean: meta?.safeToClean ?? true,
			recommended: meta?.recommended ?? false,
			rationale: meta?.rationale ?? "",
			items,
			totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
			checkedCount: items.reduce((count, item) => count + (checked.has(item.id) ? 1 : 0), 0)
		};
	}).sort((left, right) => right.totalBytes - left.totalBytes);
}
/** Muted preview of a kind's biggest entries: the "affected apps" glance line. */
function groupPreview(group, t) {
	const names = group.items.slice(0, 2).map((item) => item.label);
	if (group.items.length > 2) return `${names.join(" · ")} ${t("cleanup.previewMore", { count: group.items.length - 2 })}`;
	return names.join(" · ");
}
/** The keyed tab body: summonable plan-and-clean pane. */
function JunkBody(props) {
	const { t, useTabInfo } = props;
	const { tab } = useTabInfo();
	const [phase, setPhase] = (0, react.useState)({ type: "idle" });
	const [checked, setChecked] = (0, react.useState)(/* @__PURE__ */ new Set());
	const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
	const [confirming, setConfirming] = (0, react.useState)(false);
	const [executing, setExecuting] = (0, react.useState)(false);
	const [cleanError, setCleanError] = (0, react.useState)(null);
	const abortRef = (0, react.useRef)(null);
	const runScan = (0, react.useCallback)(() => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setPhase({ type: "scanning" });
		setConfirming(false);
		setCleanError(null);
		fetchJunkPlan(controller.signal).then((data) => {
			setPhase({
				type: "plan",
				data
			});
			setChecked(new Set(data.items.filter((item) => item.recommendedDefault).map((item) => item.id)));
		}).catch((error) => {
			if (controller.signal.aborted) return;
			setPhase({
				type: "error",
				message: error instanceof Error ? error.message : String(error)
			});
		});
	}, []);
	const navRevision = tab.navigation.revision;
	const navParams = tab.navigation.params;
	(0, react.useEffect)(() => {
		if (navParams?.autoScan === true) runScan();
	}, [
		navRevision,
		navParams,
		runScan
	]);
	(0, react.useEffect)(() => () => abortRef.current?.abort(), []);
	const groups = (0, react.useMemo)(() => phase.type === "plan" ? buildGroups(phase.data, checked) : [], [phase, checked]);
	const selected = (0, react.useMemo)(() => phase.type === "plan" ? phase.data.items.reduce((acc, item) => checked.has(item.id) ? {
		count: acc.count + 1,
		bytes: acc.bytes + item.sizeBytes
	} : acc, {
		count: 0,
		bytes: 0
	}) : {
		count: 0,
		bytes: 0
	}, [phase, checked]);
	const toggleItem = (id) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const toggleGroup = (group) => {
		setChecked((prev) => {
			const next = new Set(prev);
			const allOn = group.checkedCount === group.items.length;
			for (const item of group.items) if (allOn) next.delete(item.id);
			else next.add(item.id);
			return next;
		});
	};
	const toggleDisclosure = (kind) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});
	};
	const execute = () => {
		if (phase.type !== "plan") return;
		const ids = phase.data.items.filter((item) => checked.has(item.id)).map((item) => item.id);
		const controller = new AbortController();
		abortRef.current = controller;
		setExecuting(true);
		setCleanError(null);
		postJunkClean(ids, controller.signal).then((result) => {
			setExecuting(false);
			setConfirming(false);
			setPhase({
				type: "done",
				data: phase.data,
				result
			});
		}).catch((error) => {
			if (controller.signal.aborted) return;
			setExecuting(false);
			setCleanError(error instanceof Error ? error.message : String(error));
		});
	};
	const head = (onRescan) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-manager-junk-head",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pc-manager-host",
			children: t("junk.type.label")
		}), onRescan && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: "pc-action-pill",
			onClick: runScan,
			children: t("cleanup.rescan")
		})]
	});
	if (phase.type === "done") {
		const { data, result } = phase;
		const kindOf = new Map(data.items.map((item) => [item.id, item]));
		const failed = result.outcomes.filter((outcome) => outcome.error !== void 0);
		const byKind = /* @__PURE__ */ new Map();
		for (const outcome of result.outcomes) {
			const key = kindOf.get(outcome.id)?.kind ?? "—";
			const agg = byKind.get(key) ?? {
				bytes: 0,
				failed: 0
			};
			if (outcome.error === void 0) agg.bytes += outcome.reclaimedBytes;
			else agg.failed += 1;
			byKind.set(key, agg);
		}
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "pc-manager-junk",
			children: [
				head(true),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-host",
					children: t("cleanup.doneTitle", { size: formatBytes(result.totalReclaimedBytes) })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-group-note",
					children: result.mode === "trash" ? t("cleanup.doneNoteTrash") : t("cleanup.doneNoteDelete")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pc-manager-plan-groups",
					children: [[...byKind.entries()].map(([kind, agg]) => {
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pc-manager-group",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "pc-manager-group-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pc-manager-group-title",
									children: data.kindMeta.find((candidate) => candidate.kind === kind)?.label ?? kind
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pc-manager-group-bytes",
									children: agg.failed > 0 ? t("cleanup.failedCount", { count: agg.failed }) : formatBytes(agg.bytes)
								})]
							})
						}, kind);
					}), failed.map((outcome) => {
						const meta = kindOf.get(outcome.id);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pc-manager-item",
							"data-disabled": "true",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pc-manager-item-name",
								title: outcome.error,
								children: meta?.label ?? outcome.id
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pc-manager-item-bytes",
								title: outcome.error,
								children: outcome.error
							})]
						}, outcome.id);
					})]
				})
			]
		});
	}
	if (phase.type === "plan") {
		const destination = phase.data.moveToTrash ? t("cleanup.destinationTrash") : t("cleanup.destinationDelete");
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "pc-manager-junk",
			children: [
				head(true),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-plan-hint",
					children: t("cleanup.planHint")
				}),
				confirming && !executing && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pc-manager-confirm",
					role: "alertdialog",
					"aria-label": t("cleanup.confirmYes"),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pc-manager-confirm-title",
						children: t("cleanup.confirmTitle", {
							count: selected.count,
							size: formatBytes(selected.bytes),
							destination
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pc-manager-confirm-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "pc-action-pill",
							onClick: () => setConfirming(false),
							children: t("cleanup.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "pc-action-pill",
							"data-primary": "true",
							onClick: execute,
							children: t("cleanup.confirmYes")
						})]
					})]
				}),
				cleanError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-group-note",
					"data-tone": "error",
					children: t("cleanup.cleanError", { message: cleanError })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "pc-manager-plan-groups",
					children: groups.map((group) => {
						const open = expanded.has(group.kind);
						const indeterminate = group.checkedCount > 0 && group.checkedCount < group.items.length;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pc-manager-group",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pc-manager-group-head",
									children: [
										group.safeToClean ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											"aria-label": group.kind,
											ref: (el) => {
												if (el !== null) el.indeterminate = indeterminate;
											},
											checked: group.checkedCount === group.items.length,
											onChange: () => toggleGroup(group)
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "pc-manager-group-spacer" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "pc-manager-group-title",
											title: group.rationale,
											children: group.label
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "pc-manager-group-bytes",
											children: formatBytes(group.totalBytes)
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pc-manager-group-sub",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pc-manager-group-preview",
										children: groupPreview(group, t)
									}), group.safeToClean && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "pc-manager-disclosure",
										"aria-expanded": open,
										onClick: () => toggleDisclosure(group.kind),
										children: [t("cleanup.detail", { count: group.items.length }), open ? " ▴" : " ▸"]
									})]
								}),
								!group.safeToClean && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "pc-manager-group-note",
									children: [
										t("cleanup.manualOnly"),
										" · ",
										group.rationale
									]
								}),
								group.safeToClean && !group.recommended && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pc-manager-group-note",
									children: t("cleanup.nonRegenerable")
								}),
								open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pc-manager-itemlist",
									children: group.items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "pc-manager-item",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												"aria-label": item.id,
												checked: checked.has(item.id),
												onChange: () => toggleItem(item.id)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "pc-manager-item-name",
												title: item.path,
												children: item.label
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "pc-manager-item-bytes",
												children: formatBytes(item.sizeBytes)
											})
										]
									}, item.id))
								})
							]
						}, group.kind);
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pc-manager-plan-foot",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pc-manager-plan-sum",
						"data-empty": selected.count === 0,
						children: selected.count === 0 ? t("cleanup.planHint") : t("cleanup.selected", {
							count: selected.count,
							size: formatBytes(selected.bytes)
						})
					}), executing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "pc-action-pill",
						disabled: true,
						"aria-busy": "true",
						children: t("cleanup.executing")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "pc-action-pill",
						"data-primary": "true",
						disabled: selected.count === 0,
						onClick: () => setConfirming(true),
						children: t("cleanup.clean")
					})]
				})
			]
		});
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "pc-manager-junk",
		children: [
			head(false),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pc-manager-junk-lead",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pc-manager-cleanup-hint",
					children: phase.type === "error" ? t("cleanup.scanError", { message: phase.message }) : t("cleanup.hint")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "pc-action-pill",
					onClick: runScan,
					disabled: phase.type === "scanning",
					"aria-busy": phase.type === "scanning",
					children: phase.type === "error" ? t("error.retry") : t("cleanup.scan")
				})]
			}),
			phase.type === "scanning" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pc-manager-sk pc-manager-junk-sk",
				"aria-hidden": true
			})
		]
	});
}
//#endregion
//#region src/client/locales.ts
/** Simplified Chinese dictionary and key-set source of truth. */
const zh = {
	"type.label": "系统监控",
	"guide.title": "系统监控",
	"guide.description": "CPU、内存、GPU、磁盘、电池与网络的实时仪表盘",
	"junk.type.label": "垃圾清理",
	"junk.guide.title": "垃圾清理",
	"junk.guide.description": "扫描可回收空间，确认后清理",
	"float.toggle": "悬浮窗",
	"float.aria": "系统状态悬浮窗",
	"float.close": "关闭悬浮窗",
	"cleanup.label": "垃圾清理",
	"cleanup.hint": "扫描可回收空间，确认后清理",
	"cleanup.scan": "扫描",
	"cleanup.rescan": "重新扫描",
	"cleanup.planHint": "勾选要清理的类别；默认只列 ≥1 MB 的项",
	"cleanup.detail": "明细 ({count})",
	"cleanup.previewMore": "+{count} 项",
	"cleanup.selected": "已选 {count} 项 · {size}",
	"cleanup.clean": "清理已选",
	"cleanup.confirmTitle": "将清理 {count} 项 · {size} → {destination}",
	"cleanup.destinationTrash": "废纸篓（可恢复）",
	"cleanup.destinationDelete": "永久删除（不可恢复）",
	"cleanup.confirmYes": "确认清理",
	"cleanup.cancel": "取消",
	"cleanup.executing": "清理中…",
	"cleanup.doneTitle": "已回收 {size}",
	"cleanup.doneNoteTrash": "已移入废纸篓，清空前可恢复",
	"cleanup.doneNoteDelete": "已永久删除",
	"cleanup.failedCount": "{count} 项失败",
	"cleanup.nonRegenerable": "不可再生，默认不选",
	"cleanup.manualOnly": "不可直接清理",
	"cleanup.scanError": "扫描失败：{message}",
	"cleanup.cleanError": "清理失败：{message}",
	loading: "正在读取系统状态…",
	"error.unavailable": "状态读取失败：{message}",
	"error.retry": "重试",
	"error.stale": "以下数据可能已过期",
	"card.cpu": "CPU",
	"card.gpu": "GPU",
	"card.memory": "内存",
	"card.disks": "磁盘",
	"card.battery": "电池",
	"card.network": "网络",
	"card.processes": "进程",
	"cpu.loadavg": "负载 {one} / {five} / {fifteen}",
	"cpu.cores": "{cores} 核",
	"uptime.label": "已运行 {time}",
	"memory.swap": "交换分区 {used} / {total}",
	"memory.detail": "App {app} · 有线 {wired} · 压缩 {compressed} · 缓存 {cached}",
	"battery.health": "健康 {health}%",
	"battery.cycles": "循环 {cycles} 次",
	"battery.state.charging": "充电中",
	"battery.state.discharging": "使用电池",
	"battery.state.ac": "已接电源",
	"battery.remaining": "剩余 {time}",
	"network.noData": "无网络数据",
	"network.rxLabel": "↓ 接收 · 全部接口",
	"network.txLabel": "↑ 发送 · 全部接口",
	"network.trendSr": "最近两分钟接收与发送趋势",
	"process.sortBy": "按 {sort} 排序",
	"process.empty": "暂无进程数据",
	"process.tableLabel": "进程表 · {sort}",
	"process.column.pid": "PID",
	"process.column.command": "进程",
	"process.column.cpu": "CPU",
	"process.column.mem": "内存",
	"process.column.net": "网络",
	"process.column.gpu": "GPU",
	"process.column.disk": "磁盘",
	"process.unavailable": "—"
};
/** English dictionary, checked against the Chinese key set. */
const en = {
	"type.label": "System Monitor",
	"guide.title": "System Monitor",
	"guide.description": "Live CPU, memory, GPU, disk, battery, and network gauges",
	"junk.type.label": "Junk Cleanup",
	"junk.guide.title": "Junk Cleanup",
	"junk.guide.description": "Scan reclaimable space; clean after confirmation",
	"float.toggle": "Floating",
	"float.aria": "System status floating widget",
	"float.close": "Close floating widget",
	"cleanup.label": "Junk Cleanup",
	"cleanup.hint": "Scan reclaimable space; clean after confirmation",
	"cleanup.scan": "Scan",
	"cleanup.rescan": "Rescan",
	"cleanup.planHint": "Check the categories to clean; items under 1 MB are hidden",
	"cleanup.detail": "Details ({count})",
	"cleanup.previewMore": "+{count} more",
	"cleanup.selected": "{count} selected · {size}",
	"cleanup.clean": "Clean selected",
	"cleanup.confirmTitle": "Clean {count} items · {size} → {destination}",
	"cleanup.destinationTrash": "Trash (recoverable)",
	"cleanup.destinationDelete": "permanent deletion (not recoverable)",
	"cleanup.confirmYes": "Confirm cleanup",
	"cleanup.cancel": "Cancel",
	"cleanup.executing": "Cleaning…",
	"cleanup.doneTitle": "Reclaimed {size}",
	"cleanup.doneNoteTrash": "Moved to the Trash; recoverable until it is emptied",
	"cleanup.doneNoteDelete": "Permanently deleted",
	"cleanup.failedCount": "{count} failed",
	"cleanup.nonRegenerable": "Not regenerable; off by default",
	"cleanup.manualOnly": "Not directly cleanable",
	"cleanup.scanError": "Scan failed: {message}",
	"cleanup.cleanError": "Clean failed: {message}",
	loading: "Reading system status…",
	"error.unavailable": "Failed to read status: {message}",
	"error.retry": "Retry",
	"error.stale": "Data below may be stale",
	"card.cpu": "CPU",
	"card.gpu": "GPU",
	"card.memory": "Memory",
	"card.disks": "Disks",
	"card.battery": "Battery",
	"card.network": "Network",
	"card.processes": "Processes",
	"cpu.loadavg": "Load {one} / {five} / {fifteen}",
	"cpu.cores": "{cores} cores",
	"uptime.label": "Up {time}",
	"memory.swap": "Swap {used} / {total}",
	"memory.detail": "App {app} · Wired {wired} · Compressed {compressed} · Cached {cached}",
	"battery.health": "Health {health}%",
	"battery.cycles": "{cycles} cycles",
	"battery.state.charging": "Charging",
	"battery.state.discharging": "On battery",
	"battery.state.ac": "On AC power",
	"battery.remaining": "{time} remaining",
	"network.noData": "No network data",
	"network.rxLabel": "↓ Received · all interfaces",
	"network.txLabel": "↑ Sent · all interfaces",
	"network.trendSr": "Receive and send trend, last two minutes",
	"process.sortBy": "Sort by {sort}",
	"process.empty": "No process data",
	"process.tableLabel": "Processes · {sort}",
	"process.column.pid": "PID",
	"process.column.command": "Process",
	"process.column.cpu": "CPU",
	"process.column.mem": "Memory",
	"process.column.net": "Network",
	"process.column.gpu": "GPU",
	"process.column.disk": "Disk",
	"process.unavailable": "—"
};
//#endregion
//#region src/client/index.ts
/** This package's copy namespace. */
const NS = "pcManager";
/** Required browser services: the registries, the keyed seats, copy, and the
* sidebar controller the floating monitor summons the junk window through. */
const inject = [
	"slots",
	"locale",
	"sidebarRightTabs",
	"sidebarRight"
];
/**
* Client plugin body: register the dictionaries, both tab types, their keyed
* bodies, and the floating overlay.
* @param ctx - client root context carrying the registries, the slots, and copy.
*/
function apply(ctx) {
	ensureStyles();
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "pc-manager: dictionaries");
	ctx.effect(() => ctx.sidebarRightTabs.register(pcManagerDefinition(t)), "pc-manager: tab type");
	ctx.effect(() => ctx.sidebarRightTabs.register(junkManagerDefinition(t)), "pc-manager: junk tab type");
	ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
		name: "sidebar.right.pane.tab",
		key: PC_MANAGER_ID,
		locale: NS
	}, DashboardBody)), "pc-manager: tab body");
	ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
		name: "sidebar.right.pane.tab",
		key: JUNK_MANAGER_ID,
		locale: NS
	}, JunkBody)), "pc-manager: junk tab body");
	ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "pc-manager.float",
		locale: NS
	}, FloatingMonitor)), "pc-manager: float overlay");
	bindJunkCleanup(() => ctx.sidebarRight.openTab(JUNK_MANAGER_KIND, { params: { autoScan: true } }));
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
//# sourceMappingURL=client.js.map