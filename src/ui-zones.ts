// Floating-panel zone manager.
//
// Why: previously every panel hand-picked `position: fixed` + a corner, so
// panels claiming the same corner stacked on top of each other (and the
// top:0 multi-island bar covered them all). This module gives each panel
// exactly one non-overlapping zone instead.
//
// Contract this module enforces:
//   - Every floating panel registers in exactly ONE zone.
//   - Zones are non-overlapping screen regions: TL, TR, BL, BR, L, R, TC.
//   - Within a zone, panels stack along the zone's primary axis with a
//     consistent gap. The first panel sits flush with the viewport edge;
//     each subsequent panel is offset by (prev.height + gap).
//   - The zone manager remeasures on window resize, scroll, and on each
//     panel's own size/visibility change (via ResizeObserver + a manual
//     `requestLayout()` exposed below).
//   - Modals (centered overlay) and toasts live OUTSIDE zones — they have
//     their own z-layer and don't interact with the floating panels.
//
// Usage in a `*-ui.ts` module:
//
//     import { mountPanel, Zone } from './ui-zones.js';
//
//     const panel = document.createElement('div');
//     panel.classList.add('ri-panel');
//     // … fill in panel children …
//
//     const handle = mountPanel(panel, {
//       zone: Zone.BR,
//       id: 'hud-economy',
//       order: 0,   // smaller = closer to corner
//     });
//     // call handle.requestLayout() if you mutate panel content in a way
//     // ResizeObserver might miss (e.g. quickly toggling display:none)
//     // call handle.setVisible(false) to remove from the stack
//     // call handle.destroy() on unmount

import { Z } from './ui-tokens.js';
import { makePanelDraggable } from './window-manager.js';

export const Zone = {
  /** Top-left. Stacks downward. Reserved for slim status hints. */
  TL: 'TL',
  /** Top-right. Stacks downward. Action button strip lives here. */
  TR: 'TR',
  /** Bottom-left. Stacks UPWARD. Objective + tutorial banner. */
  BL: 'BL',
  /** Bottom-right. Stacks UPWARD. HUD economy panel. */
  BR: 'BR',
  /** Top-center horizontal strip — multi-island chip bar lives here. */
  TC: 'TC',
  /** Left edge mid-height. Stacks downward. Tall side docks (drones, routes). */
  L:  'L',
  /** Right edge mid-height. Stacks downward. Inspector + sister side docks. */
  R:  'R',
} as const;
export type ZoneId = (typeof Zone)[keyof typeof Zone];

const ZONE_AXIS: Record<ZoneId, 'down' | 'up'> = {
  TL: 'down', TR: 'down', TC: 'down', L: 'down', R: 'down',
  BL: 'up',   BR: 'up',
};

const VIEWPORT_GUTTER = 12; // distance from each viewport edge in px
const PANEL_GAP = 8;        // gap between panels in the same zone

export interface PanelMountOptions {
  readonly id: string;
  readonly zone: ZoneId;
  /** Sort key within the zone. Lower number sits closer to the viewport edge. */
  readonly order?: number;
  /** Optional max-width/min-width to apply. Otherwise the panel sizes itself. */
  readonly minWidth?: number;
  readonly maxWidth?: number;
}

export interface PanelHandle {
  readonly el: HTMLElement;
  /** Force a re-stack of the panel's zone. Cheap to call. */
  requestLayout(): void;
  /** Show/hide the panel AND remove/restore its slot in the stack. */
  setVisible(v: boolean): void;
  /** Remove from the zone manager and detach from DOM. */
  destroy(): void;
}

interface PanelRecord {
  readonly el: HTMLElement;
  readonly id: string;
  readonly zone: ZoneId;
  readonly order: number;
  visible: boolean;
  /** True iff the window-manager has placed this panel at a free
   *  (x, y, w, h) position from the persisted layout. layoutZone skips
   *  free panels in the cursor stack — sibling panels in the same zone
   *  re-flow to fill the gap. Flipped via setPanelFree from
   *  window-manager.ts. */
  free: boolean;
}

const records = new Map<string, PanelRecord>();

let layoutScheduled = false;
function scheduleLayout(): void {
  if (layoutScheduled) return;
  layoutScheduled = true;
  requestAnimationFrame(() => {
    layoutScheduled = false;
    layout();
  });
}

function layout(): void {
  const buckets = new Map<ZoneId, PanelRecord[]>();
  for (const rec of records.values()) {
    if (!rec.visible) continue;
    if (rec.free) continue; // owned by window-manager, not the stack
    let arr = buckets.get(rec.zone);
    if (!arr) { arr = []; buckets.set(rec.zone, arr); }
    arr.push(rec);
  }
  for (const [zone, arr] of buckets) {
    arr.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    layoutZone(zone, arr);
  }
}

function layoutZone(zone: ZoneId, panels: PanelRecord[]): void {
  let cursor = VIEWPORT_GUTTER;
  const axis = ZONE_AXIS[zone];
  for (const rec of panels) {
    const r = rec.el;
    r.style.position = 'fixed';
    r.style.zIndex = String(Z.panel);
    // Reset all edge anchors so re-layout from any prior zone works.
    r.style.top = r.style.bottom = r.style.left = r.style.right = '';
    switch (zone) {
      case 'TL':
        r.style.top = cursor + 'px';
        r.style.left = VIEWPORT_GUTTER + 'px';
        break;
      case 'TR':
        r.style.top = cursor + 'px';
        r.style.right = VIEWPORT_GUTTER + 'px';
        break;
      case 'BL':
        r.style.bottom = cursor + 'px';
        r.style.left = VIEWPORT_GUTTER + 'px';
        break;
      case 'BR':
        r.style.bottom = cursor + 'px';
        r.style.right = VIEWPORT_GUTTER + 'px';
        break;
      case 'TC':
        r.style.top = cursor + 'px';
        r.style.left = '50%';
        r.style.transform = 'translateX(-50%)';
        break;
      case 'L':
        r.style.top = `calc(${cursor}px + 25vh)`;
        r.style.left = VIEWPORT_GUTTER + 'px';
        break;
      case 'R':
        r.style.top = `calc(${cursor}px + 25vh)`;
        r.style.right = VIEWPORT_GUTTER + 'px';
        break;
    }
    const h = r.getBoundingClientRect().height;
    cursor += h + PANEL_GAP;
    // Safety net: if a zone's content overflows the viewport, the surplus
    // panels collapse into a scrollable overflow strip. (Practically the
    // game only mounts 1-3 panels per zone, so this is defensive.)
    if (axis === 'down' && cursor > window.innerHeight - VIEWPORT_GUTTER) {
      r.style.maxHeight = `calc(100vh - ${VIEWPORT_GUTTER * 2}px)`;
      r.style.overflow = 'auto';
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', scheduleLayout);
}

/** Mount a floating panel in a zone. Returns a handle for layout control. */
export function mountPanel(el: HTMLElement, opts: PanelMountOptions): PanelHandle {
  el.dataset.riPanel = opts.id;
  el.dataset.riZone = opts.zone;
  if (!el.parentElement) document.body.appendChild(el);
  if (opts.minWidth) el.style.minWidth = opts.minWidth + 'px';
  if (opts.maxWidth) el.style.maxWidth = opts.maxWidth + 'px';

  const rec: PanelRecord = {
    el, id: opts.id, zone: opts.zone,
    order: opts.order ?? 0, visible: true,
    free: false,
  };
  records.set(opts.id, rec);

  // Re-layout whenever the panel's intrinsic size changes (text content,
  // collapsed sections, etc.). Cheap — only the panel's zone gets re-stacked.
  const ro = new ResizeObserver(() => {
    // Window-manager sets riActiveMutation during user drag/resize. Bailing
    // here prevents the zone re-stack from fighting the user's pointer.
    if (el.dataset.riActiveMutation === '1') return;
    // Free panels are owned by window-manager — their size changes shouldn't
    // re-stack the zone either.
    if (rec.free) return;
    scheduleLayout();
  });
  ro.observe(el);

  scheduleLayout();
  // Hook the window-manager. The helper skips chrome panels via
  // CHROME_PANEL_IDS, so passing every mountPanel caller through it is
  // safe — chrome panels stay anchored and never gain drag affordances.
  makePanelDraggable(el, opts.id, {
    minWidth: opts.minWidth,
  });

  return {
    el,
    requestLayout: scheduleLayout,
    setVisible(v: boolean) {
      if (rec.visible === v) return;
      rec.visible = v;
      if (v) {
        const saved = el.dataset.riDisplay;
        el.style.display = saved === 'none' ? '' : (saved || '');
        delete el.dataset.riDisplay;
      } else {
        el.dataset.riDisplay = el.style.display;
        el.style.display = 'none';
      }
      scheduleLayout();
    },
    destroy() {
      ro.disconnect();
      records.delete(opts.id);
      if (el.parentElement) el.parentElement.removeChild(el);
      scheduleLayout();
    },
  };
}

/** Trigger a manual re-layout. Use after a batch mutation that may bypass
 *  ResizeObserver (e.g. switching active-island swaps a panel's content
 *  to one of an identical computed height — RO won't fire). */
export function requestZoneLayout(): void {
  scheduleLayout();
}

/** Flip a registered panel's `free` flag. When true, layoutZone skips it
 *  and the window-manager owns its inline left/top/width/height. When
 *  flipped back to false, the next scheduleLayout() pass will re-stack
 *  the panel into its zone. Called by window-manager.ts. */
export function setPanelFree(id: string, free: boolean): void {
  const rec = records.get(id);
  if (!rec) return;
  if (rec.free === free) return;
  rec.free = free;
  scheduleLayout();
}

/** Clear every panel's `free` flag and wipe the inline left/top/width/
 *  height/z-index/transform that the window-manager may have set; then
 *  request a re-stack. Called by resetUiLayout(). The transform clear is
 *  defensive (TC uses translateX(-50%), re-set by layoutZone) so this stays
 *  the canonical reset even if non-chrome panels gain transforms later. */
export function restoreAllToZones(): void {
  for (const rec of records.values()) {
    rec.free = false;
    const s = rec.el.style;
    // Leave dataset.riActiveMutation alone; pointer handlers clear it.
    s.left = s.top = s.width = s.height = s.zIndex = '';
    // Blanking transform is safe: layoutZone re-sets TC's translateX(-50%)
    // next pass, and other zones don't use transform.
    s.transform = '';
    rec.el.classList.remove('ri-free');
  }
  scheduleLayout();
}

/** Internal accessor for window-manager's cross-panel z-rank rewriting.
 *  Read-only view keeps the contract one-way: callers read, the zone
 *  manager owns mutation. */
export function panelRecordIds(): readonly string[] {
  return Array.from(records.keys());
}
