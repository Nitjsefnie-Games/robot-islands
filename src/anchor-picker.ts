// Ocean-layer §4 — anchor picker for ocean-placed buildings.
//
// Ocean platforms (the future Task 8 building catalog) are placed on an
// ocean cell but logically belong to a player-chosen "anchor" island —
// the colony that gets the output and (per §5.3) supplies the power. This
// module owns two responsibilities:
//
//   1. **`candidateAnchors`** (pure): list every populated island within
//      `ANCHOR_MAX_RANGE_CELLS` of the prospective placement cell, ordered
//      nearest-first. This is the data the picker UI renders.
//   2. **`mountAnchorPicker`** (DOM): a modal mirroring the
//      `cargo-label-picker.ts` shell — same pending-resolver pattern,
//      Escape / scrim / close-X resolve `null`, Enter commits the
//      currently-highlighted candidate.
//
// REVISED per commit a92efa2: anchor selection does NOT walk a cable
// component. The cable model is now route-based (`submarine_cable`
// RouteType, Task 4), so anchor selection is simply "any populated island
// in range." The previous `cablePoolComponentAt` helper is gone.
//
// **Integration status**: this file is *scaffolding* — `placement.ts` /
// `placement-ui.ts` are NOT wired today because no building def carries
// `oceanPlacement: true` yet (that flag arrives with the ocean catalog in
// Task 8). When Task 8 lands the catalog, the wiring is one call into
// `candidateAnchors` after the placement cell is committed plus a
// `mountAnchorPicker(...).pick(candidates)` await — both already exported
// from here.

import { CELL_SIZE_TILES } from './constants.js';
import { mountModal, type ModalHandle } from './ui-modal.js';
import type { WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

/** Maximum distance (in cells) from the placement cell to consider an
 *  island as an anchor candidate. Appendix-A placeholder per the spec;
 *  tuning the player loop. Inclusive bound — exactly `==` this value is
 *  still in range. */
export const ANCHOR_MAX_RANGE_CELLS = 50;

/** One row in the picker list — the island's id, display name, and its
 *  great-circle distance to the placement cell expressed in cells. The
 *  spec's Appendix-A draft also lists `inventoryHeadroom` (headroom on
 *  the platform's main output cap) but the brief defers that to a follow-
 *  up so the API stays minimal; add it here when Task 8's economy wiring
 *  needs it. */
export interface AnchorCandidate {
  readonly islandId: string;
  readonly islandName: string;
  readonly distanceCells: number;
}

/** Compute the candidate anchor islands for a prospective ocean
 *  placement at `(placementCellX, placementCellY)` (cell coords).
 *
 *  Pure: reads only `world.islands`. Returns a fresh array sorted
 *  nearest-first; ties keep input order via `Array.prototype.sort`'s
 *  stability guarantee (modern V8).
 *
 *  Island centres (`IslandSpec.cx/cy`) are in **tile** units; the
 *  placement cell is in **cell** units. We convert the placement to
 *  tiles, take the Euclidean distance in tiles, then divide by
 *  `CELL_SIZE_TILES` to express the result in cells (so the
 *  `ANCHOR_MAX_RANGE_CELLS` threshold reads naturally). */
export function candidateAnchors(
  world: WorldState,
  placementCellX: number,
  placementCellY: number,
): AnchorCandidate[] {
  const placementTileX = placementCellX * CELL_SIZE_TILES;
  const placementTileY = placementCellY * CELL_SIZE_TILES;
  const out: AnchorCandidate[] = [];
  for (const isl of world.islands) {
    if (!isl.populated) continue;
    const distTiles = Math.hypot(isl.cx - placementTileX, isl.cy - placementTileY);
    const distCells = distTiles / CELL_SIZE_TILES;
    if (distCells > ANCHOR_MAX_RANGE_CELLS) continue;
    out.push({
      islandId: isl.id,
      islandName: isl.name,
      distanceCells: distCells,
    });
  }
  out.sort((a, b) => a.distanceCells - b.distanceCells);
  return out;
}

// ---------------------------------------------------------------------------
// Modal picker (DOM)
// ---------------------------------------------------------------------------

/** Public handle returned by `mountAnchorPicker`. Single-method surface
 *  so consumers don't accidentally drive show/hide directly — the picker
 *  owns its visibility lifecycle. Mirrors `CargoLabelPickerHandle`. */
export interface AnchorPickerHandle {
  /** Open the picker. Resolves with the chosen island id, or `null` if
   *  cancelled (Escape, scrim click, Cancel button, close-X). Calling
   *  `pick()` while a previous promise is still pending resolves the
   *  previous one as `null` first — defensive against UI bugs that
   *  could leave an unresolved promise. */
  pick(candidates: AnchorCandidate[]): Promise<string | null>;
}

/** Mount the anchor-picker modal onto `parentEl`. Hidden by default; each
 *  `pick(candidates)` call populates the list, opens the modal, and
 *  returns a promise that resolves on commit / cancel.
 *
 *  Pure DOM — mirrors `mountCargoLabelPicker` so the chrome (header,
 *  scrim, close button, footer buttons) matches every other modal. */
export function mountAnchorPicker(parentEl: HTMLElement): AnchorPickerHandle {
  let pending: ((value: string | null) => void) | null = null;
  let candidates: AnchorCandidate[] = [];
  let selectedId: string | null = null;

  const buttonByIsland = new Map<string, HTMLButtonElement>();
  let listEl: HTMLDivElement | null = null;
  let emptyEl: HTMLDivElement | null = null;

  function resolveWith(value: string | null): void {
    if (pending) {
      pending(value);
      pending = null;
    }
    handle.hide();
  }

  function cancel(): void {
    resolveWith(null);
  }

  function commit(): void {
    if (selectedId === null) {
      // No candidates / nothing selected → treat Enter as cancel rather
      // than committing nothing. Keeps the contract "resolve with chosen
      // id OR null" intact.
      resolveWith(null);
      return;
    }
    resolveWith(selectedId);
  }

  function repaintSelection(): void {
    for (const [id, btn] of buttonByIsland) {
      btn.dataset['active'] = id === selectedId ? 'true' : 'false';
    }
  }

  function rebuildList(): void {
    if (!listEl || !emptyEl) return;
    listEl.replaceChildren();
    buttonByIsland.clear();

    if (candidates.length === 0) {
      emptyEl.style.display = '';
      listEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.style.display = '';

    for (const cand of candidates) {
      const btn = document.createElement('button');
      btn.className = 'ri-chip';
      btn.style.justifyContent = 'space-between';
      btn.style.textAlign = 'left';
      btn.style.width = '100%';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = cand.islandName;
      btn.appendChild(nameSpan);

      const distSpan = document.createElement('span');
      distSpan.className = 'ri-muted';
      distSpan.style.marginLeft = '12px';
      distSpan.textContent = `${cand.distanceCells.toFixed(1)} cells`;
      btn.appendChild(distSpan);

      btn.dataset['active'] = cand.islandId === selectedId ? 'true' : 'false';
      btn.addEventListener('click', () => {
        selectedId = cand.islandId;
        repaintSelection();
      });
      // Double-click = pick + commit (mirrors cargo-label-picker's UX).
      btn.addEventListener('dblclick', () => {
        selectedId = cand.islandId;
        commit();
      });
      buttonByIsland.set(cand.islandId, btn);
      listEl.appendChild(btn);
    }
  }

  const handle: ModalHandle = mountModal(parentEl, {
    title: 'CHOOSE ANCHOR ISLAND',
    subtitle: 'Ocean platforms attach to a populated island within range (§4).',
    onClose: cancel,
    buildBody(body): void {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '8px';

      emptyEl = document.createElement('div');
      emptyEl.className = 'ri-muted';
      emptyEl.style.padding = '12px 4px';
      emptyEl.textContent =
        `No populated island within ${ANCHOR_MAX_RANGE_CELLS} cells.`;
      emptyEl.style.display = 'none';
      body.appendChild(emptyEl);

      listEl = document.createElement('div');
      listEl.style.display = 'flex';
      listEl.style.flexDirection = 'column';
      listEl.style.gap = '4px';
      body.appendChild(listEl);
    },
    buildFooter(footer): void {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ri-btn';
      cancelBtn.textContent = 'CANCEL';
      cancelBtn.addEventListener('click', cancel);
      footer.appendChild(cancelBtn);

      const okBtn = document.createElement('button');
      okBtn.className = 'ri-btn ri-btn--primary';
      okBtn.textContent = 'ANCHOR';
      okBtn.addEventListener('click', commit);
      footer.appendChild(okBtn);
    },
  });

  // Global keydown — Escape cancels, Enter commits. Scoped to "modal is
  // visible" so it doesn't fight other listeners when hidden.
  const onDocKey = (e: KeyboardEvent): void => {
    if (!handle.isVisible()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };
  document.addEventListener('keydown', onDocKey);

  return {
    pick(next: AnchorCandidate[]): Promise<string | null> {
      // Supersede any pending promise — defensive (the placement flow
      // should only open one picker at a time).
      if (pending) {
        const prev = pending;
        pending = null;
        prev(null);
      }
      candidates = next;
      // Default-highlight the nearest candidate (input is sorted
      // nearest-first by `candidateAnchors`). If the list is empty, leave
      // `selectedId = null` and let the empty-state message render.
      selectedId = candidates[0]?.islandId ?? null;
      rebuildList();
      handle.show();
      return new Promise<string | null>((resolve) => {
        pending = resolve;
      });
    },
  };
}
