// Augments floating panels mounted via `ui-zones.mountPanel` with:
//   - header-drag to free-position
//   - bottom-right grip to resize
//   - per-browser persistence to localStorage (key: ri-ui-layout-v1)
//   - click-to-front z-order via a global rank counter
//
// Chrome panels (action-strip, island-bar) are skipped via CHROME_PANEL_IDS.
// Modals don't go through mountPanel at all so they're naturally out.
//
// This file lands in two passes:
//   Task 1 (this commit) — types, pure helpers, blob I/O. Impure body stubbed.
//   Task 4               — makePanelDraggable / resetUiLayout bodies.

/** localStorage key. Bump the trailing `:v1` when changing PanelLayout shape. */
export const LAYOUT_STORAGE_KEY = 'ri-ui-layout-v1';

/** Panels in this set are skipped by makePanelDraggable — they remain
 *  zone-anchored chrome. `island-bar` also uses `transform: translateX(-50%)`
 *  for centring which any drag would have to clear; safer to leave anchored. */
export const CHROME_PANEL_IDS: ReadonlySet<string> = new Set([
  'action-strip',
  'island-bar',
]);

export interface PanelLayout {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly zRank: number;
}

export interface UiLayoutBlob {
  readonly v: 1;
  readonly panels: Readonly<Record<string, PanelLayout>>;
  readonly globalZCounter: number;
}

export interface MakeDraggableOptions {
  /** Minimum width in px the user can resize to. Default 200. */
  readonly minWidth?: number;
  /** Minimum height in px the user can resize to. Default 120. */
  readonly minHeight?: number;
}

/** Construct a fresh empty layout blob. */
export function emptyBlob(): UiLayoutBlob {
  return { v: 1, panels: {}, globalZCounter: 0 };
}

/** Pure: validate a JSON-parsed blob shape. Returns null on shape mismatch
 *  so the caller falls back to an empty layout (mirrors persistence.ts'
 *  isValidSaveSnapshot pattern). Drops malformed panel entries silently. */
export function parseLayoutBlob(raw: unknown): UiLayoutBlob | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return null;
  if (typeof obj.panels !== 'object' || obj.panels === null || Array.isArray(obj.panels)) {
    return null;
  }
  const rawPanels = obj.panels as Record<string, unknown>;
  const panels: Record<string, PanelLayout> = {};
  for (const id of Object.keys(rawPanels)) {
    const p = rawPanels[id];
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue;
    const pp = p as Record<string, unknown>;
    const x = pp.x, y = pp.y, w = pp.w, h = pp.h, zRank = pp.zRank;
    if (
      typeof x !== 'number' || !Number.isFinite(x) ||
      typeof y !== 'number' || !Number.isFinite(y) ||
      typeof w !== 'number' || !Number.isFinite(w) || w <= 0 ||
      typeof h !== 'number' || !Number.isFinite(h) || h <= 0 ||
      typeof zRank !== 'number' || !Number.isFinite(zRank)
    ) continue;
    panels[id] = { x, y, w, h, zRank };
  }
  const gz = obj.globalZCounter;
  const globalZCounter =
    typeof gz === 'number' && Number.isFinite(gz) ? gz : 0;
  return { v: 1, panels, globalZCounter };
}

/** Read the layout blob from localStorage. Returns emptyBlob() if storage
 *  is unavailable, the key is unset, the JSON is malformed, or the parsed
 *  shape fails validation. Never throws. */
export function readBlob(): UiLayoutBlob {
  try {
    if (typeof localStorage === 'undefined') return emptyBlob();
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === null) return emptyBlob();
    const parsed: unknown = JSON.parse(raw);
    return parseLayoutBlob(parsed) ?? emptyBlob();
  } catch {
    return emptyBlob();
  }
}

/** Write the layout blob to localStorage. Swallows quota / disabled-storage
 *  errors with a console.warn — layout still works for the session, only
 *  persistence is lost. Mirrors persistence.ts' save-fallthrough pattern. */
export function writeBlob(blob: UiLayoutBlob): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(blob));
  } catch (err) {
    console.warn('[robot-islands] ui-layout writeBlob failed:', err);
  }
}

/** Pure: clamp a rectangle so a `minVisible`-px slice of its header is
 *  inside the viewport. Width/height are capped to viewport (minus the
 *  same minVisible margin). Exported for unit tests; called internally
 *  on load + on window.resize. */
export function clampToViewport(
  rect: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  minVisible: number = 80,
): { x: number; y: number; w: number; h: number } {
  const HEADER_BAND = 22; // header height that MUST stay reachable
  const w = Math.max(1, Math.min(rect.w, viewport.w));
  const h = Math.max(1, Math.min(rect.h, viewport.h));
  // x in [minVisible - w, vp.w - minVisible] keeps minVisible of the panel
  // width on-screen at all times.
  const minX = minVisible - w;
  const maxX = viewport.w - minVisible;
  const x = Math.max(minX, Math.min(rect.x, maxX));
  // y must keep the header band reachable: y in [0, vp.h - HEADER_BAND].
  const minY = 0;
  const maxY = Math.max(0, viewport.h - HEADER_BAND);
  const y = Math.max(minY, Math.min(rect.y, maxY));
  return { x, y, w, h };
}

// ─── Impure surface — bodies land in Task 4 ────────────────────────────

/** Augment `panel` with drag + resize + persistence. Idempotent: a second
 *  call on the same panel id is a no-op. Called from `mountPanel` after
 *  the panel is in the DOM and registered with the zone manager.
 *  Body added in Task 4 — this throw guards against accidental Task 1-only
 *  builds shipping with no drag behaviour. */
export function makePanelDraggable(
  _panel: HTMLElement,
  _id: string,
  _opts?: MakeDraggableOptions,
): void {
  throw new Error(
    '[window-manager] makePanelDraggable not yet implemented (Task 4)',
  );
}

/** Clear every persisted layout entry; restore zone-stack defaults for
 *  every floating panel. Triggered by the `reset-ui-layout` input action
 *  and the Settings UI button. Body added in Task 4. */
export function resetUiLayout(): void {
  throw new Error(
    '[window-manager] resetUiLayout not yet implemented (Task 4)',
  );
}
