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

import { access } from 'node:fs/promises'
import { win32 } from 'node:path'

/** Candidates for the PowerShell interpreter, most preferred first. Windows
 * PowerShell 5.1 ships with every supported release; `pwsh` (7+) is optional. */
export function powershellCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  return [
    win32.join(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    win32.join(programFiles, 'PowerShell\\7\\pwsh.exe'),
  ]
}

/** Preamble every script starts with: UTF-8 stdout (so non-ASCII paths
 * survive) and a default of no terminating errors (a missing WMI class must
 * degrade a field, never the whole probe). */
export const PS_PREAMBLE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'SilentlyContinue';"

/** argv for one inline script; `-Command` is unaffected by the execution
 * policy, which only gates `.ps1` files and modules. */
export const PS_ARGV: readonly string[] = ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command']

let cachedPowershell: Promise<string | null> | undefined

/**
 * Resolve the PowerShell interpreter once per process; null when absent. The
 * cache holds the *promise*, not its result: two consumers can ask at the same
 * time (the SSE pump's collection round and an HTTP `/status` fallback, or a
 * probe round and a recycle command), and a value-shaped cache would hand the
 * second caller the still-unset sentinel instead of the interpreter.
 */
export function resolvePowershell(): Promise<string | null> {
  cachedPowershell ??= probePowershell()
  return cachedPowershell
}

async function probePowershell(): Promise<string | null> {
  for (const candidate of powershellCandidates()) {
    if (await access(candidate).then(() => true, () => false)) return candidate
  }
  return null
}

/** Test seam: forget the cached interpreter lookup. */
export function resetPowershellCache(): void {
  cachedPowershell = undefined
}

/**
 * Parse one PowerShell JSON payload. A leading BOM (Windows PowerShell writes
 * one under a forced UTF-8 console encoding), surrounding whitespace, and an
 * empty document are all tolerated → null.
 */
export function parsePowershellJson(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

/**
 * PowerShell unrolls a one-element array into an object, and an empty piped
 * list arrives as an empty string rather than `[]`; normalize all three.
 */
export function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  return [value]
}

/** Finite number or null; PowerShell sends numbers, but nulls and `""` occur. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Non-empty string or null (a PowerShell `$null` field arrives as null). */
export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Property access on a parsed JSON object without a cast at every step. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
