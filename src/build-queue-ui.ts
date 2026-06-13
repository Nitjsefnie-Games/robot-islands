// Build-queue panel — draggable windowed panel in Zone.TL showing RUNNING
// and QUEUED construction jobs for the active island, each with a CANCEL
// button that issues a full-refund cancelConstruction.
//
// Mirrors hud.ts / inspector-ui.ts panel idioms:
//   - DOM element created + mounted via mountPanel(Zone.TL).
//   - makePanelDraggable wired automatically by mountPanel (via ui-zones.ts).
//   - refresh() rebuilds body content in-place; called from main.ts ticker.
//   - Cancel buttons set a pending-cancel ref then dispatch the 'cancel-build'
//     action through the input registry (panel registers action handler per-
//     render by updating a mutable ref; registry call preserves the AGENTS.md
//     "every button through the registry" contract without a payload parameter).

import { BUILDING_DEFS } from './building-defs.js';
import { constructionProgress } from './construction.js';
import { rawFloorLevel } from './buildings.js';
import type { BuildJob, IslandState } from './economy.js';
import { defineAction, dispatchAction, type InputRegistry } from './input.js';
import {
  cancelConstruction,
  inProgressBuildCount,
  parallelBuildSlots,
  queuedBuildCount,
  queuedBuildSlots,
} from './placement.js';
import { mountPanel, Zone } from './ui-zones.js';
import type { IslandSpec } from './world.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BuildQueueDeps {
  /** Returns the currently-active island spec (called on every refresh). */
  getSpec(): IslandSpec;
  /** Returns the currently-active island state (called on every refresh). */
  getState(): IslandState;
  /**
   * Called after a successful cancelConstruction mutation so the caller can
   * rebuild world layers + trigger persistence save. Mirrors the
   * onDemolish / onUpgradeFloor callback pattern in inspector-ui.
   */
  onCancel(islandId: string): void;
}

export interface BuildQueueHandle {
  /** Rebuild the panel contents against the current active island. */
  refresh(): void;
}

// ── Pending cancel ref ─────────────────────────────────────────────────────
// Cancel requires a per-item buildingId. dispatchAction has no payload, so
// the cancel button sets this ref just before dispatching so the registered
// action handler can read it.

// Single-instance assumption: one build-queue panel is mounted; the cancel-build action + this ref are module-global, so a second mount would clobber the first's handler. Fine while the panel is mounted exactly once in main.ts.
let _pendingCancelBuildingId: string | null = null;

// ── Panel factory ──────────────────────────────────────────────────────────

export function mountBuildQueuePanel(
  reg: InputRegistry,
  deps: BuildQueueDeps,
): BuildQueueHandle {
  // ── DOM shell ────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.classList.add('ri-panel');
  panel.id = 'build-queue-panel';

  // Header — title row with drag affordance (ri-panel__head).
  const head = document.createElement('div');
  head.classList.add('ri-panel__head');
  const titleEl = document.createElement('span');
  titleEl.classList.add('ri-panel__title');
  titleEl.textContent = 'BUILD QUEUE';
  head.appendChild(titleEl);
  panel.appendChild(head);

  // Body — rebuilt on each refresh().
  const body = document.createElement('div');
  body.classList.add('ri-panel__body');
  panel.appendChild(body);

  // Mount in Zone.TL; makePanelDraggable is invoked automatically by
  // mountPanel (ui-zones.ts line ~216) so no explicit call needed here.
  mountPanel(panel, {
    id: 'build-queue-panel',
    zone: Zone.TL,
    order: 0,
    minWidth: 220,
    maxWidth: 320,
  });

  // ── Register cancel-build action in the input registry ──────────────────
  // The handler reads the module-level _pendingCancelBuildingId ref set by
  // the cancel button's click handler just before dispatch. On success it
  // invokes deps.onCancel so main.ts can save + rebuild layers.
  defineAction(reg, 'cancel-build', () => {
    const buildingId = _pendingCancelBuildingId;
    _pendingCancelBuildingId = null;
    if (buildingId === null) return;
    const spec = deps.getSpec();
    const state = deps.getState();
    const result = cancelConstruction(spec, state, buildingId);
    if (!result.ok) return;
    deps.onCancel(spec.id);
    refresh();
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  interface QueueRowEntry {
    row: HTMLDivElement;
    rightSpan: HTMLSpanElement;
  }

  const rowCache = new Map<string, QueueRowEntry>();
  let lastQueueSig = '';

  function makeCachedRow(nameText: string, buildingId: string): QueueRowEntry {
    const row = document.createElement('div');
    row.classList.add('ri-kv');
    row.style.cssText = 'align-items: center; gap: 4px; flex-wrap: wrap;';

    const nameSpan = document.createElement('span');
    nameSpan.classList.add('ri-kv__k');
    nameSpan.textContent = nameText;
    nameSpan.style.cssText = 'flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

    const rightSpan = document.createElement('span');
    rightSpan.classList.add('ri-kv__v', 'ri-mono');

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel (full refund)';
    cancelBtn.style.cssText = [
      'background: transparent',
      'color: var(--ri-warn, #f5a742)',
      'border: 1px solid rgba(245,167,66,0.35)',
      'border-radius: 2px',
      'padding: 0 5px',
      'font-family: ui-monospace, monospace',
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'cursor: pointer',
      'flex: 0 0 auto',
      'line-height: 1.6',
    ].join(';');
    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = 'rgba(245,167,66,0.12)';
      cancelBtn.style.borderColor = 'var(--ri-warn, #f5a742)';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'transparent';
      cancelBtn.style.borderColor = 'rgba(245,167,66,0.35)';
    });
    cancelBtn.addEventListener('click', () => {
      _pendingCancelBuildingId = buildingId;
      dispatchAction(reg, 'cancel-build');
    });

    row.appendChild(nameSpan);
    row.appendChild(rightSpan);
    row.appendChild(cancelBtn);
    return { row, rightSpan };
  }

  // Persistent status row (no interactive elements — safe to update text).
  const statusRow = document.createElement('div');
  statusRow.classList.add('ri-kv');
  const statusK = document.createElement('span');
  statusK.classList.add('ri-kv__k');
  statusK.textContent = 'SLOTS';
  const statusV = document.createElement('span');
  statusV.classList.add('ri-kv__v', 'ri-mono');
  statusRow.appendChild(statusK);
  statusRow.appendChild(statusV);
  body.appendChild(statusRow);

  // ── Refresh ──────────────────────────────────────────────────────────────

  function refresh(): void {
    const spec = deps.getSpec();
    const state = deps.getState();

    const running = inProgressBuildCount(state);
    const runSlots = parallelBuildSlots(state);
    const queued = queuedBuildCount(state);
    const queueSlots = queuedBuildSlots(state);

    // Collect in-progress and queued buildings.
    const runningBuildings = spec.buildings.filter(
      (b) => (b.constructionRemainingMs ?? 0) > 0 && b.queued !== true,
    );
    const queuedPlacements = spec.buildings
      .filter((b) => b.queued === true)
      .slice()
      .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0));

    const jobs = (state.buildJobs ?? []).slice().sort((a, b) => a.seq - b.seq);

    // Compute per-building queue position (k) for upgrade-job labels.
    const jobsByBuilding = new Map<string, BuildJob[]>();
    for (const job of jobs) {
      const arr = jobsByBuilding.get(job.buildingId) ?? [];
      arr.push(job);
      jobsByBuilding.set(job.buildingId, arr);
    }

    interface QueuedItem {
      readonly kind: 'place' | 'upgrade';
      readonly key: string;
      readonly seq: number;
      readonly b: ReturnType<typeof deps.getSpec>['buildings'][number];
      readonly job?: BuildJob;
      readonly k?: number;
    }

    const queuedItems: QueuedItem[] = [];
    for (const b of queuedPlacements) {
      queuedItems.push({ kind: 'place', key: `place:${b.id}`, seq: b.queueSeq ?? 0, b });
    }
    for (const job of jobs) {
      const b = spec.buildings.find((x) => x.id === job.buildingId);
      if (!b) continue;
      const myJobs = jobsByBuilding.get(job.buildingId) ?? [];
      const k = myJobs.indexOf(job) + 1;
      queuedItems.push({ kind: 'upgrade', key: `job:${job.seq}`, seq: job.seq, b, job, k });
    }
    queuedItems.sort((a, b) => a.seq - b.seq);

    // Structural signature: which buildings exist and in which section, plus queued upgrade jobs.
    const sig = `r:${runningBuildings.map((b) => b.id).join(',')}|q:${queuedPlacements.map((b) => b.id).join(',')};j:${jobs.map((j) => j.seq).join(',')}`;

    // Update status text every frame (no interactive elements — safe).
    statusV.textContent = `${running}/${runSlots} run · ${queued}/${queueSlots} queue`;

    if (sig !== lastQueueSig) {
      lastQueueSig = sig;
      // Remove all children except the persistent status row.
      let child = body.firstChild;
      while (child) {
        const next = child.nextSibling;
        if (child !== statusRow) {
          body.removeChild(child);
        }
        child = next;
      }

      const hasAny = runningBuildings.length > 0 || queuedItems.length > 0;

      if (!hasAny) {
        const empty = document.createElement('div');
        empty.classList.add('ri-kv__k');
        empty.style.cssText = 'padding: 4px 0; color: var(--ri-fg-4, #3e4c5e); font-size: 11px;';
        empty.textContent = '— no active builds —';
        body.appendChild(empty);
        rowCache.clear();
        return;
      }

      const seen = new Set<string>();

      // Running section.
      if (runningBuildings.length > 0) {
        const sectionHead = document.createElement('div');
        sectionHead.classList.add('ri-sectionhead');
        sectionHead.textContent = 'Running';
        body.appendChild(sectionHead);

        for (const b of runningBuildings) {
          let entry = rowCache.get(b.id);
          if (!entry) {
            entry = makeCachedRow(BUILDING_DEFS[b.defId].displayName, b.id);
            rowCache.set(b.id, entry);
          }
          body.appendChild(entry.row);
          seen.add(b.id);
        }
      }

      // Queued section.
      if (queuedItems.length > 0) {
        const sectionHead = document.createElement('div');
        sectionHead.classList.add('ri-sectionhead');
        sectionHead.textContent = 'Queued';
        body.appendChild(sectionHead);

        for (const item of queuedItems) {
          const b = item.b;
          let entry = rowCache.get(item.key);
          if (!entry) {
            if (item.kind === 'place') {
              entry = makeCachedRow(BUILDING_DEFS[b.defId].displayName, b.id);
            } else {
              const displayedTarget = rawFloorLevel(b) + (item.k ?? 0) + 1;
              entry = makeCachedRow(`${BUILDING_DEFS[b.defId].displayName} \u2192 floor ${displayedTarget}`, item.job!.buildingId);
            }
            rowCache.set(item.key, entry);
          }
          body.appendChild(entry.row);
          seen.add(item.key);
        }
      }

      for (const id of [...rowCache.keys()]) {
        if (!seen.has(id)) rowCache.delete(id);
      }
    }

    // Update progress text every frame in place (row elements stay in the DOM).
    for (const b of runningBuildings) {
      const entry = rowCache.get(b.id);
      if (!entry) continue;
      const def = BUILDING_DEFS[b.defId];
      const remaining = b.constructionRemainingMs ?? 0;
      const pct = Math.round(constructionProgress(remaining, def, rawFloorLevel(b), b.constructionTotalMs) * 100);
      entry.rightSpan.textContent = `${pct}%`;
      entry.rightSpan.dataset.tone = 'success';
    }

    for (const item of queuedItems) {
      const entry = rowCache.get(item.key);
      if (!entry) continue;
      entry.rightSpan.textContent = 'queued';
      delete entry.rightSpan.dataset.tone;
    }
  }

  refresh();

  return { refresh };
}
