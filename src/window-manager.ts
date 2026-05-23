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
//   Task 1 — types, pure helpers, blob I/O. Impure body stubbed.
//   Task 4 — makePanelDraggable / resetUiLayout bodies.

import { setPanelFree, panelRecordIds, restoreAllToZones } from './ui-zones.js';
import { Z } from './ui-tokens.js';

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

// ─── Module-level state ────────────────────────────────────────────────

/** In-memory mirror of the localStorage blob. Read once on first
 *  makePanelDraggable; written through to localStorage with a debounce. */
let blob: UiLayoutBlob = readBlob();

/** Set of panel ids the manager has already wired — idempotency guard. */
const wiredPanels = new Set<string>();

/** Debounce token for writeBlob. ~250ms keeps a fast drag to one write. */
let writeTimer: number | null = null;
function scheduleWriteBlob(): void {
  if (writeTimer !== null) return;
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    writeBlob(blob);
  }, 250);
}

/** Mutate the in-memory blob immutably and schedule a write. */
function updatePanelLayout(id: string, patch: Partial<PanelLayout>): void {
  const prev = blob.panels[id] ?? { x: 0, y: 0, w: 0, h: 0, zRank: 0 };
  const next: PanelLayout = {
    x: patch.x ?? prev.x,
    y: patch.y ?? prev.y,
    w: patch.w ?? prev.w,
    h: patch.h ?? prev.h,
    zRank: patch.zRank ?? prev.zRank,
  };
  blob = {
    v: 1,
    panels: { ...blob.panels, [id]: next },
    globalZCounter: blob.globalZCounter,
  };
  scheduleWriteBlob();
}

function bumpGlobalZ(): number {
  blob = { ...blob, globalZCounter: blob.globalZCounter + 1 };
  scheduleWriteBlob();
  return blob.globalZCounter;
}

// Track every wired panel's id → element so click-to-front can iterate
// the focus pool and rewrite z-indexes across panels. Chrome panels are
// NOT in this map.
const wiredEls = new Map<string, HTMLElement>();

function recomputeZIndexes(): void {
  // Sort all wired panels by their zRank ascending; assign z-index in
  // [Z.panel, Z.panel + 19]. Modulo-20 keeps z-index bounded even after
  // thousands of focus events.
  const ids = Array.from(wiredEls.keys());
  ids.sort((a, b) => (blob.panels[a]?.zRank ?? 0) - (blob.panels[b]?.zRank ?? 0));
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const el = wiredEls.get(id)!;
    el.style.zIndex = String(Z.panel + (i % 20));
  }
}

// ─── Public: makePanelDraggable ────────────────────────────────────────

export function makePanelDraggable(
  panel: HTMLElement,
  id: string,
  opts?: MakeDraggableOptions,
): void {
  if (CHROME_PANEL_IDS.has(id)) return;
  if (wiredPanels.has(id)) return;
  wiredPanels.add(id);
  wiredEls.set(id, panel);

  const minWidth = opts?.minWidth ?? 200;
  const minHeight = opts?.minHeight ?? 120;

  // 1) Append the .ri-resize grip (CSS-styled in Task 3).
  let grip = panel.querySelector<HTMLDivElement>(':scope > .ri-resize');
  if (!grip) {
    grip = document.createElement('div');
    grip.className = 'ri-resize';
    grip.setAttribute('role', 'button');
    grip.setAttribute('aria-label', 'Resize panel');
    panel.appendChild(grip);
  }

  // Preemptive handle stamp so the cursor:grab CSS rule applies before
  // the user clicks. For hud-economy this is a no-op at wire-time (head
  // is appended after mount); the lazy resolve in the pointerdown handler
  // catches it on first click. For the four side docks, the head is the
  // firstElementChild at wire-time, so this stamps it now.
  const handle0 = resolveDragHandle(panel);
  if (handle0 && !handle0.classList.contains('ri-panel__head')) {
    handle0.setAttribute('data-ri-drag-handle', '');
  }

  // 2) Apply any saved layout for this id immediately.
  const saved = blob.panels[id];
  if (saved) applySavedLayout(panel, id, saved);

  // 3) Click-to-front: capturing pointerdown anywhere in the panel
  // (not the grip, which has its own handler that also bumps z).
  panel.addEventListener('pointerdown', (_e) => {
    bringToFront(id);
    // Don't preventDefault — inner buttons / inputs need their event.
  }, true);

  // 4) Drag: resolve handle lazily so panels that build their header AFTER
  // mount (e.g. hud-economy in hud.ts) still work. data-ri-drag-handle is
  // stamped onto the resolved handle so the CSS cursor rule picks it up.
  panel.addEventListener('pointerdown', (e) => {
    if (!isPrimaryPointer(e)) return;
    const target = e.target as Element | null;
    if (!target) return;
    // Ignore clicks on interactive children OR the resize grip.
    if (target.closest('button, input, select, textarea, [draggable="true"], .ri-resize')) return;
    const handle = resolveDragHandle(panel);
    if (!handle) return;
    if (!handle.contains(target)) return;

    handle.setAttribute('data-ri-drag-handle', '');
    e.preventDefault();

    const rect = panel.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top;
    panel.setPointerCapture(e.pointerId);
    document.body.classList.add('ri-dragging');
    panel.dataset.riActiveMutation = '1';

    // First drag promotes a zone-anchored panel to free-positioned.
    promoteToFree(panel, id, rect);

    const move = (ev: PointerEvent): void => {
      const x = startLeft + (ev.clientX - startX);
      const y = startTop + (ev.clientY - startY);
      const clamped = clampToViewport(
        { x, y, w: rect.width, h: rect.height },
        { w: window.innerWidth, h: window.innerHeight },
      );
      panel.style.left = clamped.x + 'px';
      panel.style.top = clamped.y + 'px';
    };
    const up = (ev: PointerEvent): void => {
      panel.removeEventListener('pointermove', move);
      panel.removeEventListener('pointerup', up);
      panel.removeEventListener('pointercancel', up);
      document.body.classList.remove('ri-dragging');
      delete panel.dataset.riActiveMutation;
      try { panel.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      const after = panel.getBoundingClientRect();
      updatePanelLayout(id, { x: after.left, y: after.top });
    };
    panel.addEventListener('pointermove', move);
    panel.addEventListener('pointerup', up);
    panel.addEventListener('pointercancel', up);
  });

  // 5) Resize via the BR grip.
  grip.addEventListener('pointerdown', (e) => {
    if (!isPrimaryPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = rect.width, startH = rect.height;
    grip!.setPointerCapture(e.pointerId);
    panel.dataset.riActiveMutation = '1';
    promoteToFree(panel, id, rect);
    // Bring to front on resize-start too.
    bringToFront(id);

    const move = (ev: PointerEvent): void => {
      const w = Math.max(minWidth, startW + (ev.clientX - startX));
      const h = Math.max(minHeight, startH + (ev.clientY - startY));
      const clamped = clampToViewport(
        { x: rect.left, y: rect.top, w, h },
        { w: window.innerWidth, h: window.innerHeight },
      );
      panel.style.width = clamped.w + 'px';
      panel.style.height = clamped.h + 'px';
    };
    const up = (ev: PointerEvent): void => {
      grip!.removeEventListener('pointermove', move);
      grip!.removeEventListener('pointerup', up);
      grip!.removeEventListener('pointercancel', up);
      delete panel.dataset.riActiveMutation;
      try { grip!.releasePointerCapture(ev.pointerId); } catch { /* already */ }
      const after = panel.getBoundingClientRect();
      updatePanelLayout(id, { w: after.width, h: after.height });
    };
    grip!.addEventListener('pointermove', move);
    grip!.addEventListener('pointerup', up);
    grip!.addEventListener('pointercancel', up);
  });

  // 6) If we wired with a saved layout, recompute z-indexes so the saved
  // zRank takes effect immediately.
  if (saved) recomputeZIndexes();
}

function isPrimaryPointer(e: PointerEvent): boolean {
  return e.isPrimary && (e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === 'touch');
}

function resolveDragHandle(panel: HTMLElement): HTMLElement | null {
  // Prefer the explicit .ri-panel__head used by hud.ts; fall back to any
  // element already stamped data-ri-drag-handle; fall back to the panel's
  // first child (the stamped header inspector-ui / drones-ui / routes-ui
  // / settlement-ui all create as the first appendChild).
  const cls = panel.querySelector<HTMLElement>(':scope > .ri-panel__head');
  if (cls) return cls;
  const tagged = panel.querySelector<HTMLElement>(':scope > [data-ri-drag-handle]');
  if (tagged) return tagged;
  const first = panel.firstElementChild;
  return first instanceof HTMLElement ? first : null;
}

function applySavedLayout(panel: HTMLElement, id: string, layout: PanelLayout): void {
  const clamped = clampToViewport(
    { x: layout.x, y: layout.y, w: layout.w, h: layout.h },
    { w: window.innerWidth, h: window.innerHeight },
  );
  panel.style.position = 'fixed';
  panel.style.left = clamped.x + 'px';
  panel.style.top = clamped.y + 'px';
  panel.style.right = '';
  panel.style.bottom = '';
  panel.style.width = clamped.w + 'px';
  panel.style.height = clamped.h + 'px';
  panel.style.transform = '';
  panel.classList.add('ri-free');
  setPanelFree(id, true);
}

function promoteToFree(panel: HTMLElement, id: string, rect: DOMRect): void {
  if (panel.classList.contains('ri-free')) return;
  panel.style.position = 'fixed';
  panel.style.left = rect.left + 'px';
  panel.style.top = rect.top + 'px';
  panel.style.right = '';
  panel.style.bottom = '';
  panel.style.width = rect.width + 'px';
  panel.style.height = rect.height + 'px';
  panel.style.transform = '';
  panel.classList.add('ri-free');
  setPanelFree(id, true);
  updatePanelLayout(id, {
    x: rect.left, y: rect.top, w: rect.width, h: rect.height,
  });
}

function bringToFront(id: string): void {
  if (!wiredEls.has(id)) return;
  const z = bumpGlobalZ();
  updatePanelLayout(id, { zRank: z });
  recomputeZIndexes();
}

// ─── Public: resetUiLayout ─────────────────────────────────────────────

export function resetUiLayout(): void {
  blob = emptyBlob();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
    }
  } catch { /* storage unavailable — in-memory clear still applies */ }
  // Reset every wired panel's inline state. ui-zones.ts owns the actual
  // re-stack via restoreAllToZones.
  for (const el of wiredEls.values()) {
    el.classList.remove('ri-free');
    el.style.left = el.style.top = el.style.width = el.style.height = el.style.zIndex = '';
  }
  restoreAllToZones();
}

// ─── Window resize: re-clamp every free panel ──────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    for (const id of panelRecordIds()) {
      const el = wiredEls.get(id);
      const layout = blob.panels[id];
      if (!el || !layout) continue;
      const clamped = clampToViewport(
        { x: layout.x, y: layout.y, w: layout.w, h: layout.h },
        { w: window.innerWidth, h: window.innerHeight },
      );
      el.style.left = clamped.x + 'px';
      el.style.top = clamped.y + 'px';
      el.style.width = clamped.w + 'px';
      el.style.height = clamped.h + 'px';
      if (clamped.x !== layout.x || clamped.y !== layout.y ||
          clamped.w !== layout.w || clamped.h !== layout.h) {
        updatePanelLayout(id, clamped);
      }
    }
  });
}
