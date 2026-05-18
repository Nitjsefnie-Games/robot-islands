// Building Catalog modal — DOM overlay listing every BuildingDef in
// BUILDING_DEFS as a card grid.
//
// Phase 4b.3: migrated to the shared ri-modal shell (mountModal from
// ui-modal.ts). Datasheet rows replaced with .bgrid of .bcard tiles.
// Filter chips rendered in the modal filter strip; inline styles replaced
// with .ri-* classes where possible.

import {
  ALL_BUILDING_DEF_IDS,
  BUILDING_DEFS,
  buildingUnlocked,
  canPlaceOnIsland,
  type BuildingCategory,
  type BuildingDefId,
} from './building-defs.js';
import { BIOME_DEFS } from './biomes.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import type { IslandState } from './economy.js';
import { RECIPES, type Recipe } from './recipes.js';
import { tierForLevel, type Tier } from './skilltree.js';
import type { IslandSpec } from './world.js';
import { mountModal } from './ui-modal.js';

export interface BuildingsUi {
  readonly el: HTMLDivElement;
  refresh(): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

/** Optional callbacks mounted alongside the catalog. Step-2.5 wires
 *  `onPlaceRequested` to enter placement mode and hide the modal. */
export interface BuildingsUiOptions {
  readonly onPlaceRequested?: (defId: BuildingDefId) => void;
}

/** Active-island getters injected at mount. The catalog reads through these
 *  every refresh so a click-to-switch on the map updates the unlocked /
 *  biome-locked banding without a re-mount. */
export interface BuildingsUiDeps {
  getState(): IslandState;
  getSpec(): IslandSpec;
}

const CATEGORY_LABEL: Readonly<Record<BuildingCategory, string>> = {
  extraction: 'Extraction',
  smelting: 'Smelting',
  chemistry: 'Chemistry',
  manufacturing: 'Manufacturing',
  electronics: 'Electronics',
  power: 'Power',
  storage: 'Storage',
  logistics: 'Logistics',
  cooling: 'Cooling',
  special: 'Special',
};

const TIER_BREAKPOINT: Readonly<Record<Tier, number>> = {
  1: 1,
  2: 5,
  3: 15,
  4: 30,
  5: 50,
  6: Number.POSITIVE_INFINITY,
};

/** Render an inputs+outputs recipe summary into a compact text snippet:
 *  `iron_ore + coal → iron_ingot (8s)`. Empty inputs render as `· → out`;
 *  empty outputs (e.g. Coal Gen) render as `in → power (5s)`. */
function recipeSnippet(recipe: Recipe): string {
  const inParts: string[] = [];
  for (const [r, n] of Object.entries(recipe.inputs)) {
    if ((n ?? 0) === 0) continue;
    inParts.push((n ?? 0) === 1 ? r : `${n}× ${r}`);
  }
  const outParts: string[] = [];
  for (const [r, n] of Object.entries(recipe.outputs)) {
    if ((n ?? 0) === 0) continue;
    outParts.push((n ?? 0) === 1 ? r : `${n}× ${r}`);
  }
  const inStr = inParts.length === 0 ? '·' : inParts.join(' + ');
  const outStr = outParts.length === 0 ? 'power' : outParts.join(' + ');
  return `${inStr} → ${outStr} (${recipe.cycleSec}s)`;
}

interface CardRef {
  readonly card: HTMLDivElement;
  readonly recipeEl: HTMLDivElement;
  readonly metaEl: HTMLDivElement;
}

export function mountBuildingsUi(
  parentEl: HTMLElement,
  deps: BuildingsUiDeps,
  options: BuildingsUiOptions = {},
): BuildingsUi {
  const getState = (): IslandState => deps.getState();
  const getSpec = (): IslandSpec => deps.getSpec();
  const cardRefs = new Map<BuildingDefId, CardRef>();
  const categoryChipRefs = new Map<BuildingCategory | 'all', HTMLButtonElement>();

  let activeFilter: BuildingCategory | null = null;

  const handle = mountModal(parentEl, {
    title: 'BUILDINGS',
    subtitle: '§8 / catalog',
    onClose: () => handle.hide(),
    buildFilters(filters) {
      const filterLabel = document.createElement('span');
      filterLabel.textContent = 'FILTER';
      filterLabel.className = 'ri-muted';
      filterLabel.style.fontSize = '10px';
      filterLabel.style.letterSpacing = '0.14em';
      filterLabel.style.marginRight = '6px';
      filterLabel.style.alignSelf = 'center';
      filters.appendChild(filterLabel);

      function makeChip(
        category: BuildingCategory | 'all',
        label: string,
      ): HTMLButtonElement {
        const chip = document.createElement('button');
        chip.className = 'ri-chip';
        chip.textContent = label;
        chip.addEventListener('click', () => {
          activeFilter = category === 'all' ? null : category;
          paintFilterChips();
          paintCards();
          chip.blur();
        });
        categoryChipRefs.set(category, chip);
        return chip;
      }

      filters.appendChild(makeChip('all', 'All'));
      const presentCategories = new Set<BuildingCategory>();
      // Ocean-placement defs are excluded from the LAND catalog (they need a
      // separate ocean-catalog UI, deferred). Filter when computing the
      // category set so e.g. a category populated only by ocean defs doesn't
      // render an empty filter chip. Pairs with the iteration filter in
      // buildBody below and the `def-is-ocean` early-reject in
      // `validatePlacement` (placement.ts) — defense-in-depth for the routing
      // gap where a player could otherwise click "Seawater Intake Rig" in the
      // land catalog and place it on land tiles.
      for (const id of ALL_BUILDING_DEF_IDS) {
        if (BUILDING_DEFS[id].oceanPlacement === true) continue;
        presentCategories.add(BUILDING_DEFS[id].category);
      }
      for (const cat of Object.keys(CATEGORY_LABEL) as BuildingCategory[]) {
        if (!presentCategories.has(cat)) continue;
        filters.appendChild(makeChip(cat, CATEGORY_LABEL[cat]));
      }
      paintFilterChips();
    },
    buildBody(body) {
      const grid = document.createElement('div');
      grid.className = 'bgrid';

      for (const defId of ALL_BUILDING_DEF_IDS) {
        const def = BUILDING_DEFS[defId];
        // Skip ocean-placement defs entirely in the land catalog — they
        // route through the ocean placement flow (validateOceanPlacement +
        // anchor picker), not through `validatePlacement`. Rendering a
        // clickable card here would let the player route an ocean def
        // through the LAND placement path, which then fails (or worse,
        // succeeds with a land tile pre-Fix). The validator carries the
        // defense-in-depth reject; this is the UI half of the pair.
        if (def.oceanPlacement === true) continue;
        const card = document.createElement('div');
        card.className = 'bcard';
        card.dataset.defid = defId;

        const top = document.createElement('div');
        top.className = 'top';

        const ico = document.createElement('div');
        ico.className = 'ico';
        ico.textContent = def.glyph;

        const titleEl = document.createElement('h4');
        titleEl.textContent = def.displayName;

        const catEl = document.createElement('span');
        catEl.className = 'cat';
        catEl.textContent = `T${def.tier} · ${CATEGORY_LABEL[def.category].toUpperCase()}`;

        top.appendChild(ico);
        top.appendChild(titleEl);
        top.appendChild(catEl);

        const recipeEl = document.createElement('div');
        recipeEl.className = 'recipe';
        const recipe = RECIPES[defId];
        recipeEl.textContent = recipe
          ? recipeSnippet(recipe)
          : '— no recipe';

        const metaEl = document.createElement('div');
        metaEl.className = 'meta';

        card.appendChild(top);
        card.appendChild(recipeEl);
        card.appendChild(metaEl);

        card.addEventListener('click', () => {
          const st = getState();
          const sp = getSpec();
          const hasSp = sp.buildings.some((b) => b.defId === 'spaceport');
          if (
            !buildingUnlocked(
              st.level,
              defId,
              st.aiCoreCrafted,
              st.ascendantCoreCrafted,
              hasSp,
            )
          )
            return;
          if (!canPlaceOnIsland(BUILDING_DEFS[defId], sp)) return;
          options.onPlaceRequested?.(defId);
        });

        grid.appendChild(card);
        cardRefs.set(defId, { card, recipeEl, metaEl });
      }

      body.appendChild(grid);
    },
    buildFooter(footer) {
      const footerL = document.createElement('span');
      footerL.textContent = 'click a card to place · T rotates · esc cancels';
      footerL.className = 'ri-muted';
      const footerR = document.createElement('span');
      footerR.textContent = 'tiers gate by island level · §9.2';
      footerR.className = 'ri-muted';
      footer.prepend(footerL);
      footer.appendChild(footerR);
    },
  });

  function paintFilterChips(): void {
    for (const [key, chip] of categoryChipRefs) {
      const active =
        (key === 'all' && activeFilter === null) || key === activeFilter;
      chip.dataset.active = active ? 'true' : 'false';
    }
  }

  function lockReason(
    defId: BuildingDefId,
    state: IslandState,
    spec: IslandSpec,
  ): string {
    const def = BUILDING_DEFS[defId];
    const hasSpaceport = spec.buildings.some((b) => b.defId === 'spaceport');
    if (
      def.tier === 5 &&
      tierForLevel(state.level) >= 5 &&
      !state.aiCoreCrafted
    ) {
      return 'AI CORE';
    }
    if (def.tier === 6) {
      if (!state.ascendantCoreCrafted) return 'ASCENDANT CORE';
      if (!hasSpaceport) return 'SPACEPORT';
    }
    const breakpoint = TIER_BREAKPOINT[def.tier];
    if (state.level < breakpoint) {
      return `L${breakpoint}`;
    }
    return 'LOCKED';
  }

  function paintCard(defId: BuildingDefId, ref: CardRef): void {
    const def = BUILDING_DEFS[defId];
    const state = getState();
    const spec = getSpec();
    const hasSpaceport = spec.buildings.some((b) => b.defId === 'spaceport');
    const unlocked = buildingUnlocked(
      state.level,
      defId,
      state.aiCoreCrafted,
      state.ascendantCoreCrafted,
      hasSpaceport,
    );
    const biomeOk = canPlaceOnIsland(def, spec);
    const placementLocked = unlocked && !biomeOk;

    const matchesFilter =
      activeFilter === null || def.category === activeFilter;
    ref.card.style.display = matchesFilter ? '' : 'none';

    if (unlocked && !placementLocked) {
      ref.card.style.opacity = '1';
      ref.card.style.cursor = 'pointer';
    } else if (placementLocked) {
      ref.card.style.opacity = '0.78';
      ref.card.style.cursor = 'default';
    } else {
      ref.card.style.opacity = '0.55';
      ref.card.style.cursor = 'default';
    }

    const recipe = RECIPES[defId];
    ref.recipeEl.textContent = recipe
      ? recipeSnippet(recipe)
      : '— no recipe';
    ref.recipeEl.style.color = unlocked
      ? 'var(--ri-fg-2)'
      : 'var(--ri-fg-4)';

    while (ref.metaEl.firstChild)
      ref.metaEl.removeChild(ref.metaEl.firstChild);

    if (def.requiredBiomes && def.requiredBiomes.length > 0) {
      const biomeLabel = def.requiredBiomes
        .map((b) => BIOME_DEFS[b].displayName.toUpperCase())
        .join(' / ');
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.textContent = biomeLabel;
      if (placementLocked) chip.dataset.tone = 'warn';
      ref.metaEl.appendChild(chip);
    }

    const fpChip = document.createElement('span');
    fpChip.className = 'ri-chip';
    fpChip.textContent = `${shapeWidth(def.footprint)}×${shapeHeight(def.footprint)}`;
    ref.metaEl.appendChild(fpChip);

    if (def.power?.produces) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.dataset.tone = 'success';
      chip.textContent = `+${def.power.produces}W`;
      ref.metaEl.appendChild(chip);
    }
    if (def.power?.consumes) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.dataset.tone = 'warn';
      chip.textContent = `−${def.power.consumes}W`;
      ref.metaEl.appendChild(chip);
    }
    if (def.storage && def.storage.capacity > 0) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.textContent = `+${def.storage.capacity} cap`;
      ref.metaEl.appendChild(chip);
    }
    if (def.requiredTile && def.requiredTile.length > 0) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.textContent = def.requiredTile.join('/');
      ref.metaEl.appendChild(chip);
    }
    if (def.requiresHeat) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.textContent = 'HEAT';
      ref.metaEl.appendChild(chip);
    }

    if (placementLocked) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.dataset.tone = 'warn';
      chip.textContent = 'BIOME LOCKED';
      ref.metaEl.appendChild(chip);
    } else if (!unlocked) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.dataset.tone = 'warn';
      chip.textContent = `LOCKED · ${lockReason(defId, state, spec)}`;
      ref.metaEl.appendChild(chip);
    }
  }

  function paintCards(): void {
    for (const defId of ALL_BUILDING_DEF_IDS) {
      const ref = cardRefs.get(defId);
      if (!ref) continue;
      paintCard(defId, ref);
    }
  }

  function refresh(): void {
    if (!handle.isVisible()) return;
    paintCards();
    paintFilterChips();
  }

  function show(): void {
    if (handle.isVisible()) return;
    handle.show();
    refresh();
  }
  function hide(): void {
    if (!handle.isVisible()) return;
    handle.hide();
  }
  function toggle(): boolean {
    if (handle.isVisible()) hide();
    else show();
    return handle.isVisible();
  }

  return {
    el: handle.el,
    refresh,
    show,
    hide,
    toggle,
    isVisible: handle.isVisible,
  };
}
