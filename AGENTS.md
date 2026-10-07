# AGENTS.md

Working rules for coding agents in this repository (`dsh-pc-manager`, a DeepSeek Harness plugin
for system monitoring, junk cleanup and app uninstall).

## Normative reference

The DeepSeek Harness (dsh) source tree is the normative reference for plugin conventions, tool
APIs, patch formats and safety rules; when this repo's docs and the harness disagree, the harness
wins. The harness repo is expected to be checked out **side by side** (`../deepseek-harness`),
nested one level up, or pointed at via the `DSH_HARNESS_ROOT` env var. User-facing product facts
live in the READMEs: [README.md](README.md) (English, default) and [README.zh-CN.md](README.zh-CN.md)
(Chinese) — keep the two in sync section by section.

## Commands

- **Never `pnpm install` in this repo** — the toolchain (tsdown / vitest / tsc) resolves from the
  harness side; there is no `node_modules` of our own.
- `npm run build` — dual-entry build producing `lib/index.js` (host, ESM) and `lib/client.js`
  (client artifact). Uses the harness binaries via `DSH_HARNESS_ROOT` discovery.
- `npm test` — vitest + `tsc --noEmit`, both via the harness binaries.
- `npm run dev-setup` — link into a profile's node_modules + build (idempotent).
- Run: from the harness repo root,
  `pnpm dsh --patch <path-to-this-repo>/cordis.patch.yml --profile web`.
- `tsc` requires TypeScript 6+ (`tsconfig.json` sets `ignoreDeprecations: "6.0"`, which errors
  with `TS5103` on 5.x). `scripts/{build,test}.mjs` already handle Windows (`.bin/<name>.cmd`
  shims with `shell: true`); `dev-setup.mjs` uses junctions instead of symlinks there.

## Hard rules

- **`lib/` is committed build output.** After ANY source change, run `npm run build` and commit
  `lib/*.js` together with the source — git installs load the committed artifacts directly and
  never build at install time. `tests/e2e.win32.spec.ts` fails when `lib/` is stale, but do not
  rely on that catching it.
- ESM (`type: module`), TS strict, relative imports with the `.ts` suffix, JSDoc on exports.
- `src/index.ts` must have **no default export** — only the named `name` / `inject` / `Config` /
  `apply` (a mixed default export gets the namespace dropped by the Loader).
- **Domain modules stay pure**: `src/monitor.ts`, `src/junk.ts`, `src/apps.ts`, `src/win32.ts`
  must not import cordis / dsh-tools; pure parsers are exported explicitly for tests.
- **`src/tools.ts` is the only layer touching `defineTool` / `ctx.tools.register`.** Every tool
  output schema is `oneOf: [data, ERROR_SCHEMA]`; `guarded()` translates exceptions into the
  closed error union (`PcErrorCode`); never throw a raw exception across a tool boundary. The
  `SystemStatus` type, `STATUS_SCHEMA` and the actual snapshot output must stay field-aligned
  (`additionalProperties: false`) — three places, one contract.
- Array fields in `src/types.ts` must **not** be `readonly` (tool schema inference is mutable
  arrays; readonly breaks type compatibility).
- **Client half (`src/client/`)**: value imports only from the react family; everything
  `@deepseek-ai/*` is type-only (bundle purity — cross-plugin value imports violate the
  build/load contract; collaborate through ctx services). Styles are runtime-injected `<style>`,
  never CSS files.
- **No hardcoded tunables** — switches and thresholds go through the Config schema (TS interface
  + same-named Schemastery schema), never inline constants that users might need to tune.

## Security invariants (never violate)

- `pc_junk_scan` is **always dry-run**; scanning deletes nothing.
- Cleanup/uninstall accept only **exact ids returned by scan/list**; an unknown id rejects the
  whole call — never skip-and-continue.
- The two destructive tools (`pc_junk_clean` / `pc_app_uninstall`) are registered but default to
  `disabled_by_config` and refuse at execute time; the switches (`enableJunkClean` /
  `enableAppUninstall`) and `moveToTrash` (default true) live in the Config schema + patch config.
- Default destination is the Trash (the Recycle Bin on Windows); permanent deletion requires an
  explicit `moveToTrash: false`. Uninstall residuals are reported, never silently deleted.
- The **blocked red-line lists and protection lists are load-bearing** (macOS/Linux/Windows
  red lines, sensitive-cache protections, EDR/active-service prefixes, Windows system SIDs).
  Never weaken them; new registry rows must not shadow them.
- The id validation chain normalizes and compares each path by its **own flavor**
  (`path.posix` / `path.win32` chosen per literal, never by host default); trailing separators
  are stripped except on roots (a trailing slash must not turn a registry root into "a child").
- Probe failures degrade to null/empty + `console.warn` — a probe failure never fails the whole
  snapshot, and a missing capability stays silent (no warn spam, no fabricated zeros).
- `cordis.patch.yml` stays **purely additive** — never override or disable built-in plugins.
- Presenters (`presentCall` / `presentResult` / render) are pure functions: no I/O, no clock;
  model-visible output must be reconstructible from session logs.

## Language rules

- **Model-visible schema text (tool name / description / parameter descriptions) is English
  only** — a hard dsh rule.
- User-readable data values (`JunkItem.label` etc.) are Chinese; error messages and rationales
  trend bilingual.
- Docs: `README.md` is English (the default landing page), `README.zh-CN.md` is its Chinese
  counterpart; when changing either, mirror the change in the other.

## Tests

- vitest specs live in `tests/` only (never `src/__tests__`).
- `tests/*.win32.spec.ts` pin the Windows parsers/registry **host-independently** (path literals
  keep their own flavor); the main suites cover all POSIX parsers and the full junk domain.
- `tests/e2e.win32.spec.ts` runs on a real Windows host (snapshot self-consistency, read-only
  registry scan, real Recycle Bin round-trip, HTTP/tool faces via a stubbed cordis context, and
  the committed-`lib/` artifact contract).
- EACCES degradation cases need a non-root POSIX runner; they skip automatically under root or
  Windows.
