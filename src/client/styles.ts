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
`

/** Inject the card styles once per document; mirrors the loader's style tagging. */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="@deepseek-ai/dsh-pc-manager"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = '@deepseek-ai/dsh-pc-manager'
  tag.textContent = CSS
  document.head.appendChild(tag)
}
