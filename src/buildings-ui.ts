// Building Catalog modal — DOM overlay listing every BuildingDef in
// BUILDING_DEFS as a card grid, mounted on the shared ri-modal shell.

import {
  ALL_BUILDING_DEF_IDS,
  BUILDING_DEFS,
  buildingUnlocked,
  type BuildingCategory,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import { canPlaceOnAnyConstituent } from './placement.js';
import { hasOperationalBuilding } from './buildings.js';
import { BIOME_DEFS } from './biomes.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import type { IslandState } from './economy.js';
import { RECIPES, type Recipe } from './recipes.js';
import { effectiveTierShift, hasBiomeBypass, tierForLevel, type Tier } from './skilltree.js';
import type { IslandSpec } from './world.js';
import { mountModal } from './ui-modal.js';
import { fmtPower } from './format.js';

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
  production: 'Production',
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

export interface BuildingCardLockState {
  /** True if the island level (with any tier-bypass keystone) unlocks the def. */
  readonly unlocked: boolean;
  /** True if the def can sit on this island's biome (with any biome-bypass keystone). */
  readonly biomeOk: boolean;
  /** Unlocked but biome-locked — placeable nowhere on this island. */
  readonly placementLocked: boolean;
}

/** Lock state for a building catalog card. Mirrors `validatePlacement`'s skill
 *  relaxations (`placement.ts:282-289`) so the catalog UI and the backend
 *  validator agree: the `tierBypass` keystone (#146) unlocks a building one
 *  tier early, and the `biomeBypass` keystone (#145) clears its biome lock.
 *  Both skill helpers default to the standard catalog graph. */
export function buildingCardLockState(
  def: BuildingDef,
  state: IslandState,
  spec: IslandSpec,
): BuildingCardLockState {
  const hasSpaceport = hasOperationalBuilding(spec.buildings, 'spaceport');
  let unlocked = buildingUnlocked(
    state.level,
    def.id,
    state.aiCoreCrafted,
    state.ascendantCoreCrafted,
    hasSpaceport,
  );
  if (!unlocked) {
    const tierShift = effectiveTierShift(state, def.id);
    if (tierShift > 0 && def.tier <= 4) {
      unlocked = tierForLevel(state.level) >= def.tier - tierShift;
    }
  }
  const biomeOk = canPlaceOnAnyConstituent(def, spec) || hasBiomeBypass(state, def.id);
  const placementLocked = unlocked && !biomeOk;
  return { unlocked, biomeOk, placementLocked };
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
    subtitle: 'catalog',
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
      // §4 ocean-layer: ocean defs are reachable from the catalog; clicking
      // one routes through placement-ui's `attemptCommit` ocean branch
      // (`validateOceanPlacement` + anchor picker), not the land path.
      for (const id of ALL_BUILDING_DEF_IDS) {
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
        // §4 ocean-layer: ocean defs are first-class catalog cards; the
        // land validator's `def-is-ocean` reject remains as defense-in-depth
        // for any non-UI caller that still routes an ocean def the land path.
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
          const { unlocked, biomeOk } = buildingCardLockState(BUILDING_DEFS[defId], st, sp);
          if (!unlocked || !biomeOk) return;
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
      footerR.textContent = 'tiers gate by island level';
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
    const hasSpaceport = hasOperationalBuilding(spec.buildings, 'spaceport');
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
    const { unlocked, placementLocked } = buildingCardLockState(def, state, spec);

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
      chip.textContent = `+${fmtPower(def.power.produces)}`;
      ref.metaEl.appendChild(chip);
    }
    if (def.power?.consumes) {
      const chip = document.createElement('span');
      chip.className = 'ri-chip';
      chip.dataset.tone = 'warn';
      chip.textContent = `−${fmtPower(def.power.consumes)}`;
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
