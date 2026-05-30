// §4.6 placement-time cargo-label picker — the modal the player sees BEFORE
// committing the placement of a generic-storage building (Crate today;
// Warehouse / future generic-category defs land here automatically because
// the picker keys off `def.storage?.category === 'generic'`, never a defId
// list).
//
// SPEC §4.6: "At placement, the player labels the building with the resource
// it will hold." The picker default-highlights `iron_ore` so a player who
// just hits Enter lands on the pre-picker historical default (no muscle-
// memory break for veterans). Escape / scrim-click / close-X resolves the
// picker promise as `null`, which `placement-ui.ts` interprets as
// "cancel the placement entirely" — no building is created in that path.
//
// Visual style: the shared `mountModal` shell so the chrome (header, scrim,
// close button) matches every other modal in the app. Body is a list of
// resource buttons grouped by storage category, using the same
// `STORAGE_CATEGORY_LABEL` labels the inspector relabel dropdown uses
// (see `inspector-ui.ts:81-87`) so the player sees consistent terminology
// across the placement-time picker and the post-placement relabel.
//
// Pure DOM — no PixiJS. Mirrors the one-file-per-modal pattern of
// `inventory-ui.ts`, `buildings-ui.ts`, etc.

import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  ALL_STORAGE_CATEGORIES,
  RESOURCE_STORAGE_CATEGORY,
  type StorageCategory,
} from './storage-categories.js';
import { DEFAULT_CARGO_LABEL } from './placement.js';
import { mountModal, type ModalHandle } from './ui-modal.js';

/** §4.6 storage-category display labels. Duplicates `inspector-ui.ts:81-87`
 *  intentionally — both modals surface category headers in the same prose so
 *  the player learns one taxonomy. If a future patch consolidates, lift this
 *  to `storage-categories.ts` (data) and import from both sites. */
const STORAGE_CATEGORY_LABEL: Readonly<Record<StorageCategory, string>> = {
  dry_goods: 'Dry Goods',
  liquid_gas: 'Liquids / Gases',
  temp_sensitive: 'Temp-Sensitive',
  components: 'Components',
  rare: 'Rare / Valuable',
};

export interface CargoLabelPickerHandle {
  /** Open the picker. Resolves with the player's pick, or `null` if cancelled
   *  (Escape, scrim-click, close button). Only one picker session may be
   *  open at a time — calling `pick()` while a previous promise is still
   *  pending resolves the previous one as `null` (treat as a re-arm). */
  pick(): Promise<ResourceId | null>;
}

export function mountCargoLabelPicker(
  parentEl: HTMLElement,
): CargoLabelPickerHandle {
  // The currently-pending resolver. Set when `pick()` opens the modal,
  // cleared when the player picks / cancels / a fresh `pick()` supersedes.
  // The "supersede" case resolves the old promise as `null` first — callers
  // never see a hanging promise.
  let pending: ((value: ResourceId | null) => void) | null = null;

  /** Currently-highlighted resource. Renders with the active-chip style and
   *  is the value `pick()` resolves to when the player hits Enter. Resets
   *  to `DEFAULT_CARGO_LABEL` on every fresh `pick()` so each placement
   *  starts from the same well-known default. */
  let selected: ResourceId = DEFAULT_CARGO_LABEL;

  /** Optional search-filter substring (lower-cased). Empty string = no
   *  filter. Filter applies per-resource id and per-display-name (display
   *  name being the id itself today — no separate prettifier yet). */
  let filterText = '';

  const buttonByResource = new Map<ResourceId, HTMLButtonElement>();

  function resolveWith(value: ResourceId | null): void {
    if (pending) {
      pending(value);
      pending = null;
    }
    handle.hide();
  }

  /** Close the modal as a cancel. Bound to Escape, the scrim click, and the
   *  header close-X — every dismissal path. */
  function cancel(): void {
    resolveWith(null);
  }

  /** Commit the currently-selected resource and close. */
  function commit(): void {
    resolveWith(selected);
  }

  function repaintSelection(): void {
    for (const [r, btn] of buttonByResource) {
      btn.dataset['active'] = r === selected ? 'true' : 'false';
    }
  }

  function applyFilter(): void {
    const f = filterText.trim().toLowerCase();
    for (const [r, btn] of buttonByResource) {
      const visible = f === '' || r.toLowerCase().includes(f);
      btn.style.display = visible ? '' : 'none';
    }
    // Section headers should hide when every child is filtered out. We tag
    // them with a `data-category` and check sibling visibility on each
    // repaint — cheap enough at ~150 buttons.
    for (const cat of ALL_STORAGE_CATEGORIES) {
      const header = sectionHeaders.get(cat);
      const grid = sectionGrids.get(cat);
      if (!header || !grid) continue;
      let anyVisible = false;
      for (const child of Array.from(grid.children) as HTMLElement[]) {
        if (child.style.display !== 'none') {
          anyVisible = true;
          break;
        }
      }
      header.style.display = anyVisible ? '' : 'none';
      grid.style.display = anyVisible ? '' : 'none';
    }
  }

  const sectionHeaders = new Map<StorageCategory, HTMLDivElement>();
  const sectionGrids = new Map<StorageCategory, HTMLDivElement>();

  const handle: ModalHandle = mountModal(parentEl, {
    title: 'LABEL STORAGE',
    subtitle: 'Choose the resource this building will hold (§4.6).',
    onClose: cancel,
    buildFilters(filters): void {
      // Search input — same `.ri-search` class as inventory-ui.
      const searchInput = document.createElement('input');
      searchInput.className = 'ri-search';
      searchInput.placeholder = 'Filter resources…';
      searchInput.type = 'text';
      searchInput.style.flex = '1 1 200px';
      searchInput.addEventListener('input', () => {
        filterText = searchInput.value;
        applyFilter();
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      });
      filters.appendChild(searchInput);
    },
    buildBody(body): void {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '12px';

      // Group resources by storage category — same five buckets the
      // specialized-storage buildings use (§4.6). Within each group, sort
      // resources alphabetically so the player can scan deterministically.
      const byCategory = new Map<StorageCategory, ResourceId[]>();
      for (const cat of ALL_STORAGE_CATEGORIES) byCategory.set(cat, []);
      for (const r of ALL_RESOURCES) {
        const cat = RESOURCE_STORAGE_CATEGORY[r];
        byCategory.get(cat)!.push(r);
      }
      for (const list of byCategory.values()) {
        list.sort((a, b) => a.localeCompare(b));
      }

      for (const cat of ALL_STORAGE_CATEGORIES) {
        const list = byCategory.get(cat) ?? [];
        if (list.length === 0) continue;
        const header = document.createElement('div');
        header.textContent = STORAGE_CATEGORY_LABEL[cat].toUpperCase();
        header.className = 'ri-muted';
        header.style.fontSize = '10px';
        header.style.letterSpacing = '0.14em';
        header.style.padding = '0 2px';
        sectionHeaders.set(cat, header);
        body.appendChild(header);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns =
          'repeat(auto-fill, minmax(160px, 1fr))';
        grid.style.gap = '4px';
        sectionGrids.set(cat, grid);

        for (const r of list) {
          const btn = document.createElement('button');
          btn.className = 'ri-chip';
          btn.textContent = r.replace(/_/g, ' ');
          btn.title = r;
          btn.style.justifyContent = 'flex-start';
          btn.style.textAlign = 'left';
          btn.dataset['active'] = r === selected ? 'true' : 'false';
          btn.addEventListener('click', () => {
            selected = r;
            repaintSelection();
          });
          // Double-click = pick + commit, a faster path for confident
          // players who don't want to chase the footer button.
          btn.addEventListener('dblclick', () => {
            selected = r;
            commit();
          });
          buttonByResource.set(r, btn);
          grid.appendChild(btn);
        }
        body.appendChild(grid);
      }
    },
    buildFooter(footer): void {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ri-btn';
      cancelBtn.textContent = 'CANCEL';
      cancelBtn.addEventListener('click', cancel);
      footer.appendChild(cancelBtn);

      const okBtn = document.createElement('button');
      okBtn.className = 'ri-btn ri-btn--primary';
      okBtn.textContent = 'PLACE';
      okBtn.addEventListener('click', commit);
      footer.appendChild(okBtn);
    },
  });

  // Global keydown — Escape cancels, Enter commits. Bound to the document
  // (scoped to "this modal is visible") rather than the scrim so the search
  // input handler above doesn't have to be the only Enter/Escape source.
  const onDocKey = (e: KeyboardEvent): void => {
    if (!handle.isVisible()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      // Don't double-fire when focus is in the search input (which has its
      // own Enter handler). The check uses the active element's class.
      const ae = document.activeElement;
      if (ae instanceof HTMLInputElement) return;
      e.preventDefault();
      commit();
    }
  };
  document.addEventListener('keydown', onDocKey);

  return {
    pick(): Promise<ResourceId | null> {
      // Supersede any previous pending promise — should never happen in
      // production (the placement flow only opens one picker at a time),
      // but defends against a UI bug from leaving an unresolved promise.
      if (pending) {
        const prev = pending;
        pending = null;
        prev(null);
      }
      selected = DEFAULT_CARGO_LABEL;
      filterText = '';
      repaintSelection();
      applyFilter();
      handle.show();
      return new Promise<ResourceId | null>((resolve) => {
        pending = resolve;
      });
    },
  };
}
