/**
 * The floating monitor's cleanup trigger (§16.9): summons the junk-cleanup
 * window — its own right-sidebar tab — which starts scanning on arrival.
 * Until apply() wires the opener, the call is a no-op, so the widget stays
 * context-free.
 */

let opener: (() => void) | null = null

/** Wire the trigger to the plugin context; called once from apply(). */
export function bindJunkCleanup(open: () => void): void {
  opener = open
}

/** Open (or focus) the junk-cleanup window; it auto-scans on summons. */
export function openJunkCleanup(): void {
  opener?.()
}
