// Skill-tree panel — DOM overlay rendering §9.3 as four branch columns.
//
// Phase 4b.2: migrated to the shared ri-modal shell (mountModal from
// ui-modal.ts). Branch columns, specialization cards, and tier-reset row
// are rendered inside the modal body; footer hints live in buildFooter.
// Static inline styles are replaced with .ri-* classes where possible;
// dynamic state-driven colours use CSS custom properties.

import {
  BRANCH_LABEL,
  BRANCH_SUBPATHS,
  NODE_CATALOG,
  SUBPATH_LABEL,
  canSpend,
  nodeRequiredTier,
  spendPoint,
  tierForLevel,
  type BranchId,
  type SkillNode,
  type SubPathId,
} from './skilltree.js';
import { type IslandState, xpForLevel } from './economy.js';
import { ALL_ROLES, ROLE_DEFS, type RoleId } from './specialization.js';
import {
  TIER_RESET_COOLDOWN_MS,
  canTierReset,
  executeTierReset,
  tierResetCost,
} from './tier-reset.js';
import { mountModal } from './ui-modal.js';

export interface SkillTreeUi {
  readonly el: HTMLDivElement;
  /** Repaint the panel to match the current state. No-op while hidden so it's
   *  cheap to call every frame from the ticker. */
  refresh(): void;
  /** Show the panel. Idempotent. */
  show(): void;
  /** Hide the panel. Idempotent. */
  hide(): void;
  /** Toggle visibility; returns the new visible state. */
  toggle(): boolean;
  /** Whether the panel is currently visible. */
  isVisible(): boolean;
}

/** Optional hooks for the skill-tree panel. Step 10 adds `onDeclareRole`,
 *  invoked after the panel mutates `state.specializationRole` so callers
 *  can run additional bookkeeping (e.g., bumping a "declared role X"
 *  notification). The mutation happens inside the panel regardless. */
export interface SkillTreeUiOptions {
  readonly onDeclareRole?: (role: RoleId) => void;
}

/** Active-island getter injected at mount. The panel reads the active
 *  island's state through this every refresh / click — switching active
 *  retargets the panel without re-mount. */
export interface SkillTreeUiDeps {
  getState(): IslandState;
}

interface NodeRowRef {
  readonly row: HTMLDivElement;
  readonly statusDot: HTMLSpanElement;
  readonly tierTag: HTMLSpanElement;
  readonly costTag: HTMLSpanElement;
  readonly descEl: HTMLDivElement;
  readonly titleEl: HTMLDivElement;
}

export function mountSkillTreeUi(
  parentEl: HTMLElement,
  deps: SkillTreeUiDeps,
  options: SkillTreeUiOptions = {},
): SkillTreeUi {
  const getState = (): IslandState => deps.getState();
  const nodeRefs = new Map<string, NodeRowRef>();
  const subStatusRefs = new Map<SubPathId, HTMLSpanElement>();

  let refresh: () => void = () => undefined;

  // Mutable refs for elements that need updating after mount.
  const levelVal = document.createElement('span');
  levelVal.classList.add('ri-mono');
  const xpVal = document.createElement('span');
  xpVal.classList.add('ri-mono');
  const tierVal = document.createElement('span');
  tierVal.classList.add('ri-mono');
  const pointsVal = document.createElement('span');
  pointsVal.classList.add('ri-mono');
  const captionStatus = document.createElement('span');
  const cardGrid = document.createElement('div');
  const tierResetDetail = document.createElement('span');
  const tierResetBtn = document.createElement('button');

  interface CardRef {
    readonly card: HTMLDivElement;
    readonly topBorder: HTMLDivElement;
    readonly glyph: HTMLSpanElement;
    readonly tierChip: HTMLSpanElement;
    readonly nameEl: HTMLSpanElement;
    readonly datasheetEl: HTMLDivElement;
    readonly footerBtn: HTMLButtonElement;
    readonly activeStamp: HTMLSpanElement;
  }
  const cardRefs = new Map<RoleId, CardRef>();

  function nodeRow(node: SkillNode, branch: BranchId): HTMLDivElement {
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '14px 1fr auto auto';
    row.style.alignItems = 'baseline';
    row.style.gap = '9px';
    row.style.padding = '5px 9px 5px 6px';
    row.style.borderLeft = '2px solid var(--ri-fg-4)';
    row.style.marginLeft = '8px';
    row.style.transition = 'background 100ms ease, border-color 100ms ease';
    row.style.cursor = 'default';

    const tick = document.createElement('span');
    tick.textContent = String(node.depth).padStart(1, '0') + '.';
    tick.style.color = 'var(--ri-fg-4)';
    tick.style.fontSize = '10px';
    tick.style.letterSpacing = '0';

    const main = document.createElement('div');
    main.style.display = 'flex';
    main.style.flexDirection = 'column';
    main.style.gap = '1px';
    main.style.minWidth = '0';

    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'baseline';
    titleRow.style.gap = '7px';

    const statusDot = document.createElement('span');
    statusDot.textContent = '○';
    statusDot.style.color = 'var(--ri-fg-4)';
    statusDot.style.fontSize = '11px';

    const titleEl = document.createElement('div');
    titleEl.textContent = `${SUBPATH_LABEL[node.subPath]} ${node.depth}`;
    titleEl.style.color = 'var(--ri-fg-1)';
    titleEl.style.fontSize = '12px';
    titleEl.style.fontWeight = '500';

    titleRow.appendChild(statusDot);
    titleRow.appendChild(titleEl);
    main.appendChild(titleRow);

    const descEl = document.createElement('div');
    descEl.textContent = node.description;
    descEl.style.color = 'var(--ri-fg-3)';
    descEl.style.fontSize = '10.5px';
    main.appendChild(descEl);

    const tierTag = document.createElement('span');
    tierTag.textContent = `T${nodeRequiredTier(node)}`;
    tierTag.style.color = 'var(--ri-fg-3)';
    tierTag.style.fontSize = '10px';
    tierTag.style.letterSpacing = '0.08em';
    tierTag.style.border = '1px solid var(--ri-fg-4)';
    tierTag.style.padding = '1px 5px';
    tierTag.style.borderRadius = '2px';

    const costTag = document.createElement('span');
    costTag.textContent = `${node.cost} SP`;
    costTag.style.color = 'var(--ri-warn)';
    costTag.style.fontSize = '10.5px';
    costTag.style.letterSpacing = '0.04em';
    costTag.style.fontWeight = '600';
    costTag.style.minWidth = '38px';
    costTag.style.textAlign = 'right';

    row.appendChild(tick);
    row.appendChild(main);
    row.appendChild(tierTag);
    row.appendChild(costTag);

    row.addEventListener('click', () => {
      const state = getState();
      const r = canSpend(state, node.id);
      if (!r.ok) return;
      spendPoint(state, node.id);
      refresh();
      row.animate(
        [
          { backgroundColor: 'rgba(125, 211, 232, 0.18)' },
          { backgroundColor: 'rgba(125, 211, 232, 0)' },
        ],
        { duration: 380, easing: 'ease-out' },
      );
    });
    row.addEventListener('mouseenter', () => {
      const state = getState();
      const r = canSpend(state, node.id);
      if (r.ok) {
        row.style.background = 'var(--ri-hover)';
        row.style.borderLeftColor = 'var(--ri-accent)';
        row.style.cursor = 'pointer';
      }
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
      const ref = nodeRefs.get(node.id);
      if (ref) applyState(node, ref);
      row.style.cursor = 'default';
    });

    void branch;
    nodeRefs.set(node.id, { row, statusDot, tierTag, costTag, descEl, titleEl });
    return row;
  }

  // ---------------------------------------------------------------------------
  // Specialization helpers
  // ---------------------------------------------------------------------------

  const ROLE_GLYPHS: Readonly<Record<RoleId, string>> = {
    foundry: '▣',
    refinery: '◇',
    mining: '▽',
    logistics_hub: '⇄',
    research_beacon: '⊙',
  };
  const ROLE_CARD_NAMES: Readonly<Record<RoleId, string>> = {
    foundry: 'FOUNDRY',
    refinery: 'REFINERY',
    mining: 'MINING',
    logistics_hub: 'LOGISTICS HUB',
    research_beacon: 'RESEARCH BEACON',
  };

  function buildDatasheetRows(id: RoleId): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '3px';

    function row(label: string, valueSpan: HTMLElement): HTMLDivElement {
      const r = document.createElement('div');
      r.style.display = 'flex';
      r.style.justifyContent = 'space-between';
      r.style.alignItems = 'baseline';
      r.style.gap = '6px';
      const l = document.createElement('span');
      l.textContent = label;
      l.style.color = 'var(--ri-fg-3)';
      l.style.fontSize = '10px';
      l.style.letterSpacing = '0.06em';
      l.style.textTransform = 'uppercase';
      r.appendChild(l);
      r.appendChild(valueSpan);
      return r;
    }

    function valueSpan(text: string, colorVar: string): HTMLSpanElement {
      const s = document.createElement('span');
      s.textContent = text;
      s.style.color = colorVar;
      s.style.fontSize = '11px';
      s.style.fontWeight = '600';
      s.style.fontVariantNumeric = 'tabular-nums';
      return s;
    }

    const MIN = '−';

    switch (id) {
      case 'foundry':
        wrap.appendChild(row('SMELTING', valueSpan('+50%', 'var(--ri-accent)')));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}25%`, 'var(--ri-warn)')));
        break;
      case 'refinery':
        wrap.appendChild(row('CHEMISTRY', valueSpan('+50%', 'var(--ri-accent)')));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}25%`, 'var(--ri-warn)')));
        break;
      case 'mining':
        wrap.appendChild(row('EXTRACTION', valueSpan('+75%', 'var(--ri-accent)')));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}50%`, 'var(--ri-warn)')));
        break;
      case 'logistics_hub':
        wrap.appendChild(row('ROUTE CAP', valueSpan('+100% · STG +50%', 'var(--ri-accent)')));
        wrap.appendChild(row('PRODUCTION', valueSpan(`${MIN}25%`, 'var(--ri-warn)')));
        break;
      case 'research_beacon': {
        const mixed = document.createElement('span');
        mixed.style.fontSize = '11px';
        mixed.style.fontWeight = '600';
        mixed.style.fontVariantNumeric = 'tabular-nums';
        const xpPart = document.createElement('span');
        xpPart.textContent = '+50%';
        xpPart.style.color = 'var(--ri-accent)';
        const sep = document.createElement('span');
        sep.textContent = ' · RECIPES ';
        sep.style.color = 'var(--ri-fg-3)';
        const recipePart = document.createElement('span');
        recipePart.textContent = `${MIN}25%`;
        recipePart.style.color = 'var(--ri-warn)';
        mixed.appendChild(xpPart);
        mixed.appendChild(sep);
        mixed.appendChild(recipePart);
        wrap.appendChild(row('XP', mixed));
        break;
      }
      default: {
        const _exhaustive: never = id;
        void _exhaustive;
        break;
      }
    }
    return wrap;
  }

  const ROLE_CONFIRM_SUMMARY: Readonly<Record<RoleId, string>> = {
    foundry: '+50% smelting recipe rate, ×0.75 on all other production.',
    refinery: '+50% chemistry recipe rate, ×0.75 on all other production.',
    mining: '+75% extraction recipe rate, ×0.50 on all other production.',
    logistics_hub:
      '+100% route capacity, +50% storage caps, ×0.75 on all production.',
    research_beacon: '+50% skill XP on this island, ×0.75 on all recipe rates.',
  };

  function buildCard(id: RoleId): void {
    const def = ROLE_DEFS[id];
    const card = document.createElement('div');
    card.style.background = 'var(--ri-panel)';
    card.style.padding = '10px 9px 9px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '8px';
    card.style.position = 'relative';
    card.style.transition = 'opacity 100ms ease, background 100ms ease';

    const topBorder = document.createElement('div');
    topBorder.style.position = 'absolute';
    topBorder.style.top = '0';
    topBorder.style.left = '0';
    topBorder.style.right = '0';
    topBorder.style.height = '2px';
    topBorder.style.background = 'var(--ri-fg-4)';
    card.appendChild(topBorder);

    const glyphRow = document.createElement('div');
    glyphRow.style.display = 'flex';
    glyphRow.style.alignItems = 'center';
    glyphRow.style.justifyContent = 'space-between';
    glyphRow.style.gap = '6px';

    const glyph = document.createElement('span');
    glyph.textContent = ROLE_GLYPHS[id];
    glyph.style.color = 'var(--ri-fg-1)';
    glyph.style.fontSize = '16px';
    glyph.style.fontFamily = 'var(--ri-font-mono)';
    glyph.style.fontVariantNumeric = 'tabular-nums';
    glyph.style.lineHeight = '1';

    const tierChip = document.createElement('span');
    tierChip.textContent = `T${def.tierRequirement}`;
    tierChip.style.color = 'var(--ri-fg-3)';
    tierChip.style.fontSize = '9.5px';
    tierChip.style.letterSpacing = '0.08em';
    tierChip.style.border = '1px solid var(--ri-fg-4)';
    tierChip.style.padding = '0 4px';
    tierChip.style.borderRadius = '2px';
    tierChip.style.lineHeight = '1.3';

    glyphRow.appendChild(glyph);
    glyphRow.appendChild(tierChip);
    card.appendChild(glyphRow);

    const nameEl = document.createElement('span');
    nameEl.textContent = ROLE_CARD_NAMES[id];
    nameEl.style.color = 'var(--ri-fg-1)';
    nameEl.style.fontSize = '12px';
    nameEl.style.fontWeight = '600';
    nameEl.style.letterSpacing = '0.03em';
    nameEl.style.textTransform = 'uppercase';
    card.appendChild(nameEl);

    const datasheetEl = buildDatasheetRows(id);
    card.appendChild(datasheetEl);

    const footerBtn = document.createElement('button');
    footerBtn.className = 'ri-btn';
    footerBtn.style.width = '100%';
    footerBtn.style.marginTop = 'auto';
    footerBtn.style.cursor = 'not-allowed';
    footerBtn.style.opacity = '0.5';
    footerBtn.addEventListener('click', () => {
      const state = getState();
      const role = state.specializationRole;
      if (role !== null) return;
      if (tierForLevel(state.level) < def.tierRequirement) return;
      const proceed = window.confirm(
        `DECLARE ${ROLE_DEFS[id].displayName.toUpperCase()} ROLE\n\n` +
          `${ROLE_CONFIRM_SUMMARY[id]}\n\n` +
          'This commitment can only be reversed via Tier Reset (§9.7).\nProceed?',
      );
      if (!proceed) return;
      state.specializationRole = id;
      state.declaredAt = performance.now();
      options.onDeclareRole?.(id);
      refresh();
      footerBtn.blur();
    });
    card.addEventListener('mouseenter', () => {
      const state = getState();
      if (state.specializationRole !== null) return;
      if (tierForLevel(state.level) < def.tierRequirement) return;
      card.style.background = 'rgba(245, 167, 66, 0.06)';
    });
    card.addEventListener('mouseleave', () => {
      refreshSpecialization();
    });
    card.appendChild(footerBtn);

    const activeStamp = document.createElement('span');
    activeStamp.textContent = '● ACTIVE';
    activeStamp.style.position = 'absolute';
    activeStamp.style.top = '6px';
    activeStamp.style.right = '8px';
    activeStamp.style.color = 'var(--ri-accent)';
    activeStamp.style.fontSize = '9px';
    activeStamp.style.letterSpacing = '0.10em';
    activeStamp.style.border = '1px solid var(--ri-border-accent)';
    activeStamp.style.padding = '1px 4px';
    activeStamp.style.borderRadius = '2px';
    activeStamp.style.display = 'none';
    card.appendChild(activeStamp);

    cardGrid.appendChild(card);
    cardRefs.set(id, {
      card,
      topBorder,
      glyph,
      tierChip,
      nameEl,
      datasheetEl,
      footerBtn,
      activeStamp,
    });
  }

  // ---------------------------------------------------------------------------
  // Mount modal
  // ---------------------------------------------------------------------------

  const handle = mountModal(parentEl, {
    title: 'SKILL TREE',
    subtitle: '/ §9.3',
    onClose: () => handle.hide(),
    buildBody(body) {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '14px';

      // ---- Stats strip ------------------------------------------------------
      const statsStrip = document.createElement('div');
      statsStrip.style.display = 'flex';
      statsStrip.style.justifyContent = 'center';
      statsStrip.style.gap = '22px';
      statsStrip.style.fontSize = '11px';
      statsStrip.style.letterSpacing = '0.08em';
      statsStrip.style.textTransform = 'uppercase';

      function statBlock(label: string, valueEl: HTMLElement): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.alignItems = 'baseline';
        wrap.style.gap = '6px';
        const l = document.createElement('span');
        l.textContent = label;
        l.className = 'ri-muted';
        l.style.fontSize = '10px';
        wrap.appendChild(l);
        wrap.appendChild(valueEl);
        return wrap;
      }

      levelVal.style.color = 'var(--ri-fg-1)';
      levelVal.style.fontWeight = '600';
      xpVal.style.color = 'var(--ri-fg-1)';
      tierVal.style.color = 'var(--ri-accent)';
      tierVal.style.fontWeight = '600';
      pointsVal.style.color = 'var(--ri-warn)';
      pointsVal.style.fontWeight = '600';
      pointsVal.style.fontSize = '13px';

      statsStrip.appendChild(statBlock('LEVEL', levelVal));
      statsStrip.appendChild(statBlock('TIER', tierVal));
      statsStrip.appendChild(statBlock('XP', xpVal));
      statsStrip.appendChild(statBlock('UNSPENT', pointsVal));
      body.appendChild(statsStrip);

      // ---- Specialization section -------------------------------------------
      const specSection = document.createElement('div');
      specSection.style.display = 'flex';
      specSection.style.flexDirection = 'column';
      specSection.style.gap = '10px';
      specSection.style.padding = '12px 0 14px';
      specSection.style.borderTop = '1px solid var(--ri-rule)';
      specSection.style.borderBottom = '1px solid var(--ri-border-strong)';

      const captionRow = document.createElement('div');
      captionRow.style.display = 'flex';
      captionRow.style.alignItems = 'baseline';
      captionRow.style.justifyContent = 'space-between';
      captionRow.style.gap = '12px';

      const captionLeft = document.createElement('span');
      captionLeft.textContent = 'SPECIALIZATION';
      captionLeft.className = 'ri-caps';
      captionLeft.style.color = 'var(--ri-accent)';
      captionLeft.style.fontSize = '11px';
      captionLeft.style.letterSpacing = '0.22em';

      const captionSubtitle = document.createElement('span');
      captionSubtitle.textContent = '§9.4 / role declaration';
      captionSubtitle.className = 'ri-muted';
      captionSubtitle.style.fontSize = '10px';
      captionSubtitle.style.letterSpacing = '0.12em';
      captionSubtitle.style.textTransform = 'uppercase';
      captionSubtitle.style.flex = '1 1 auto';
      captionSubtitle.style.paddingLeft = '14px';

      captionStatus.style.fontSize = '11px';
      captionStatus.style.fontWeight = '600';
      captionStatus.style.letterSpacing = '0.10em';
      captionStatus.style.textTransform = 'uppercase';
      captionStatus.style.flex = '0 0 auto';

      captionRow.appendChild(captionLeft);
      captionRow.appendChild(captionSubtitle);
      captionRow.appendChild(captionStatus);
      specSection.appendChild(captionRow);

      cardGrid.style.display = 'grid';
      cardGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
      cardGrid.style.gap = '1px';
      cardGrid.style.background = 'var(--ri-border-strong)';
      specSection.appendChild(cardGrid);

      for (const id of ALL_ROLES) buildCard(id);

      // Tier-reset row
      const tierResetRow = document.createElement('div');
      tierResetRow.style.display = 'flex';
      tierResetRow.style.alignItems = 'center';
      tierResetRow.style.justifyContent = 'space-between';
      tierResetRow.style.gap = '12px';
      tierResetRow.style.borderTop = '1px solid var(--ri-border-strong)';
      tierResetRow.style.paddingTop = '10px';
      tierResetRow.style.marginTop = '4px';

      const tierResetLeft = document.createElement('div');
      tierResetLeft.style.display = 'flex';
      tierResetLeft.style.flexDirection = 'column';
      tierResetLeft.style.gap = '2px';

      const tierResetTitle = document.createElement('span');
      tierResetTitle.textContent = 'TIER RESET';
      tierResetTitle.style.color = 'var(--ri-warn)';
      tierResetTitle.style.fontSize = '11px';
      tierResetTitle.style.fontWeight = '600';
      tierResetTitle.style.letterSpacing = '0.18em';

      const tierResetSub = document.createElement('span');
      tierResetSub.textContent = '§9.7 / revert to T1, preserve construction';
      tierResetSub.className = 'ri-muted';
      tierResetSub.style.fontSize = '10px';
      tierResetSub.style.letterSpacing = '0.04em';

      tierResetDetail.className = 'ri-muted';
      tierResetDetail.style.fontSize = '10px';
      tierResetDetail.style.letterSpacing = '0.02em';

      tierResetLeft.appendChild(tierResetTitle);
      tierResetLeft.appendChild(tierResetSub);
      tierResetLeft.appendChild(tierResetDetail);

      tierResetBtn.className = 'ri-btn';
      tierResetBtn.style.color = 'var(--ri-warn)';
      tierResetBtn.style.borderColor = 'var(--ri-warn)';
      tierResetBtn.style.flex = '0 0 auto';
      tierResetBtn.addEventListener('click', () => {
        const state = getState();
        const now = performance.now();
        const r = canTierReset(state, now);
        if (!r.ok) return;
        const cost = tierResetCost(state.level);
        const proceed = window.confirm(
          'TIER RESET (§9.7)\n\n' +
            `Cost: ${cost.steel} steel, ${cost.gear} gear\n\n` +
            'Reverts this island to Tier 1.\n' +
            'Clears: level, XP, skill points, specialization role, sub-path commitments.\n' +
            'Preserves: buildings, inventory (minus cost), storage caps, modifiers.\n\n' +
            'T2+ buildings remain placed but stall until the island re-climbs.\n' +
            '24-hour cooldown before another reset on this island.\n\n' +
            'Proceed?',
        );
        if (!proceed) {
          tierResetBtn.blur();
          return;
        }
        executeTierReset(state, now);
        refresh();
        tierResetBtn.blur();
      });
      tierResetBtn.addEventListener('mouseenter', () => {
        if (tierResetBtn.style.cursor === 'pointer') {
          tierResetBtn.style.background = 'rgba(245, 167, 66, 0.10)';
        }
      });
      tierResetBtn.addEventListener('mouseleave', () => {
        tierResetBtn.style.background = '';
      });

      tierResetRow.appendChild(tierResetLeft);
      tierResetRow.appendChild(tierResetBtn);
      specSection.appendChild(tierResetRow);

      body.appendChild(specSection);

      // ---- Branch columns ---------------------------------------------------
      const branchGrid = document.createElement('div');
      branchGrid.style.display = 'grid';
      branchGrid.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
      branchGrid.style.gap = '1px';
      branchGrid.style.background = 'var(--ri-border-strong)';

      for (const branch of Object.keys(BRANCH_SUBPATHS) as BranchId[]) {
        const col = document.createElement('div');
        col.style.background = 'var(--ri-panel)';
        col.style.padding = '14px 12px 18px';
        col.style.display = 'flex';
        col.style.flexDirection = 'column';
        col.style.gap = '14px';

        const colHeader = document.createElement('div');
        colHeader.className = 'ri-sectionhead';
        colHeader.style.padding = '0 0 6px';

        const branchName = document.createElement('span');
        branchName.textContent = BRANCH_LABEL[branch].toUpperCase();
        branchName.style.color = 'var(--ri-accent)';
        branchName.style.fontSize = '11px';
        branchName.style.fontWeight = '600';
        branchName.style.letterSpacing = '0.2em';

        const branchSub = document.createElement('span');
        branchSub.textContent = '/ branch';
        branchSub.className = 'ri-muted';
        branchSub.style.fontSize = '9.5px';
        branchSub.style.letterSpacing = '0.1em';

        colHeader.appendChild(branchName);
        colHeader.appendChild(branchSub);
        col.appendChild(colHeader);

        for (const subPath of BRANCH_SUBPATHS[branch]) {
          const sub = document.createElement('div');
          sub.style.display = 'flex';
          sub.style.flexDirection = 'column';
          sub.style.gap = '2px';

          const subRow = document.createElement('div');
          subRow.className = 'ri-kv';
          subRow.style.padding = '2px 0';

          const subName = document.createElement('span');
          subName.className = 'ri-chip';
          subName.style.cursor = 'default';
          subName.textContent = SUBPATH_LABEL[subPath];

          const subStatus = document.createElement('span');
          subStatus.className = 'ri-kv__v';
          subStatus.style.fontSize = '10px';

          subRow.appendChild(subName);
          subRow.appendChild(subStatus);
          sub.appendChild(subRow);

          const subPathNodes = NODE_CATALOG
            .filter((n) => n.subPath === subPath)
            .slice()
            .sort((a, b) => a.depth - b.depth);
          for (const node of subPathNodes) {
            sub.appendChild(nodeRow(node, branch));
          }
          col.appendChild(sub);

          subStatusRefs.set(subPath, subStatus);
        }
        branchGrid.appendChild(col);
      }
      body.appendChild(branchGrid);
    },
    buildFooter(footer) {
      const footerL = document.createElement('span');
      footerL.textContent = 'click a node to spend a skill point';
      footerL.className = 'ri-muted';
      const footerR = document.createElement('span');
      footerR.textContent =
        'depth 1-2 require T2 · depth 3→T3 · depth 4→T4 · depth 5-7→T5 · depth 8+→T6 · costs grow 2^(depth-1)';
      footerR.className = 'ri-muted';
      footer.prepend(footerL);
      footer.appendChild(footerR);
    },
  });

  // ---------------------------------------------------------------------------
  // State-driven repaint helpers
  // ---------------------------------------------------------------------------

  function applyState(node: SkillNode, ref: NodeRowRef): void {
    const state = getState();
    const owned = state.unlockedNodes.has(node.id);
    const r = canSpend(state, node.id);
    if (owned) {
      ref.statusDot.textContent = '●';
      ref.statusDot.style.color = 'var(--ri-accent)';
      ref.titleEl.style.color = 'var(--ri-accent)';
      ref.descEl.style.color = 'var(--ri-fg-3)';
      ref.row.style.borderLeftColor = 'var(--ri-accent)';
      ref.costTag.style.color = 'var(--ri-accent-dim)';
      ref.costTag.style.textDecoration = 'line-through';
      ref.tierTag.style.borderColor = 'var(--ri-accent-dim)';
      ref.tierTag.style.color = 'var(--ri-accent-dim)';
      ref.row.style.opacity = '1';
    } else if (r.ok) {
      ref.statusDot.textContent = '◇';
      ref.statusDot.style.color = 'var(--ri-warn)';
      ref.titleEl.style.color = 'var(--ri-fg-1)';
      ref.descEl.style.color = 'var(--ri-fg-3)';
      ref.row.style.borderLeftColor = 'var(--ri-warn)';
      ref.costTag.style.color = 'var(--ri-warn)';
      ref.costTag.style.textDecoration = 'none';
      ref.tierTag.style.borderColor = 'var(--ri-fg-4)';
      ref.tierTag.style.color = 'var(--ri-fg-3)';
      ref.row.style.opacity = '1';
    } else if (r.reason === 'branch-locked') {
      // Sibling sub-path is committed-but-incomplete → this whole sub-path
      // is gated until that one finishes. Distinct danger-tinted readout
      // (vs tier-locked / prereq-missing fade) so players can see the lock
      // at a glance instead of discovering it via a rejected click.
      ref.statusDot.textContent = '⊘';
      ref.statusDot.style.color = 'var(--ri-danger)';
      ref.titleEl.style.color = 'var(--ri-fg-4)';
      ref.descEl.style.color = 'var(--ri-fg-4)';
      ref.row.style.borderLeftColor = 'var(--ri-danger)';
      ref.costTag.style.color = 'var(--ri-fg-4)';
      ref.costTag.style.textDecoration = 'line-through';
      ref.tierTag.style.borderColor = 'var(--ri-fg-4)';
      ref.tierTag.style.color = 'var(--ri-fg-4)';
      ref.row.style.opacity = '0.65';
    } else {
      ref.statusDot.textContent = '○';
      ref.statusDot.style.color = 'var(--ri-fg-4)';
      ref.titleEl.style.color = 'var(--ri-fg-3)';
      ref.descEl.style.color = 'var(--ri-fg-4)';
      ref.row.style.borderLeftColor = 'var(--ri-fg-4)';
      ref.costTag.style.color = 'var(--ri-fg-4)';
      ref.costTag.style.textDecoration = 'none';
      ref.tierTag.style.borderColor = 'var(--ri-fg-4)';
      ref.tierTag.style.color = 'var(--ri-fg-4)';
      ref.row.style.opacity = r.reason === 'tier-locked' ? '0.55' : '0.78';
    }
  }

  function refreshSpecialization(): void {
    const state = getState();
    const declared: RoleId | null = state.specializationRole;
    const tier = tierForLevel(state.level);
    const unlocked = tier >= 3;

    if (!unlocked && declared === null) {
      captionStatus.textContent = '◯ REQUIRES TIER 3';
      captionStatus.style.color = 'var(--ri-fg-4)';
    } else if (declared !== null) {
      const name = ROLE_DEFS[declared].displayName.toUpperCase();
      captionStatus.textContent = `● ROLE ACTIVE: ${name}`;
      captionStatus.style.color = 'var(--ri-accent)';
    } else {
      captionStatus.textContent = '◇ AWAITING DECLARATION';
      captionStatus.style.color = 'var(--ri-warn)';
    }

    for (const id of ALL_ROLES) {
      const ref = cardRefs.get(id);
      if (!ref) continue;
      const isActive = declared === id;
      const isOtherDeclared = declared !== null && declared !== id;
      if (isActive) {
        ref.card.style.background = 'rgba(125, 211, 232, 0.05)';
        ref.card.style.opacity = '1';
        ref.topBorder.style.background = 'var(--ri-accent)';
        ref.topBorder.style.height = '2px';
        ref.glyph.style.color = 'var(--ri-accent)';
        ref.glyph.style.textShadow = '0 0 6px rgba(125, 211, 232, 0.4)';
        ref.tierChip.style.color = 'var(--ri-accent)';
        ref.tierChip.style.borderColor = 'var(--ri-accent)';
        ref.nameEl.style.color = 'var(--ri-fg-1)';
        ref.datasheetEl.style.opacity = '1';
        ref.footerBtn.textContent = '● ACTIVE';
        ref.footerBtn.style.color = 'var(--ri-accent)';
        ref.footerBtn.style.borderColor = 'var(--ri-accent)';
        ref.footerBtn.style.cursor = 'default';
        ref.footerBtn.style.opacity = '1';
        ref.activeStamp.style.display = 'inline-block';
      } else if (isOtherDeclared) {
        ref.card.style.background = 'var(--ri-panel)';
        ref.card.style.opacity = '0.4';
        ref.topBorder.style.background = 'var(--ri-fg-4)';
        ref.topBorder.style.height = '1px';
        ref.glyph.style.color = 'var(--ri-fg-4)';
        ref.glyph.style.textShadow = 'none';
        ref.tierChip.style.color = 'var(--ri-fg-4)';
        ref.tierChip.style.borderColor = 'var(--ri-fg-4)';
        ref.nameEl.style.color = 'var(--ri-fg-4)';
        ref.datasheetEl.style.opacity = '1';
        ref.footerBtn.textContent = 'LOCKED · ROLE SET';
        ref.footerBtn.style.color = 'var(--ri-fg-4)';
        ref.footerBtn.style.borderColor = 'var(--ri-fg-4)';
        ref.footerBtn.style.cursor = 'not-allowed';
        ref.footerBtn.style.opacity = '0.6';
        ref.activeStamp.style.display = 'none';
      } else if (unlocked) {
        ref.card.style.background = 'var(--ri-panel)';
        ref.card.style.opacity = '1';
        ref.topBorder.style.background = 'var(--ri-warn)';
        ref.topBorder.style.height = '2px';
        ref.glyph.style.color = 'var(--ri-fg-1)';
        ref.glyph.style.textShadow = 'none';
        ref.tierChip.style.color = 'var(--ri-fg-3)';
        ref.tierChip.style.borderColor = 'var(--ri-fg-4)';
        ref.nameEl.style.color = 'var(--ri-fg-1)';
        ref.datasheetEl.style.opacity = '1';
        ref.footerBtn.textContent = '▶ DECLARE';
        ref.footerBtn.style.color = 'var(--ri-warn)';
        ref.footerBtn.style.borderColor = 'var(--ri-warn)';
        ref.footerBtn.style.cursor = 'pointer';
        ref.footerBtn.style.opacity = '1';
        ref.activeStamp.style.display = 'none';
      } else {
        ref.card.style.background = 'var(--ri-panel)';
        ref.card.style.opacity = '0.55';
        ref.topBorder.style.background = 'var(--ri-fg-4)';
        ref.topBorder.style.height = '2px';
        ref.glyph.style.color = 'var(--ri-fg-4)';
        ref.glyph.style.textShadow = 'none';
        ref.tierChip.style.color = 'var(--ri-fg-4)';
        ref.tierChip.style.borderColor = 'var(--ri-fg-4)';
        ref.nameEl.style.color = 'var(--ri-fg-3)';
        ref.datasheetEl.style.opacity = '0.8';
        ref.footerBtn.textContent = 'LOCKED · T3';
        ref.footerBtn.style.color = 'var(--ri-fg-4)';
        ref.footerBtn.style.borderColor = 'var(--ri-fg-4)';
        ref.footerBtn.style.cursor = 'not-allowed';
        ref.footerBtn.style.opacity = '0.5';
        ref.activeStamp.style.display = 'none';
      }
    }
  }

  function refreshTierReset(): void {
    const state = getState();
    const now = performance.now();
    const cost = tierResetCost(state.level);
    const r = canTierReset(state, now);
    let detail = `cost: ${cost.steel} steel · ${cost.gear} gear`;
    if (state.lastResetAt !== null) {
      const elapsed = now - state.lastResetAt;
      const remaining = TIER_RESET_COOLDOWN_MS - elapsed;
      if (remaining > 0) {
        const h = Math.floor(remaining / 3_600_000);
        const m = Math.floor((remaining % 3_600_000) / 60_000);
        detail += `  ·  cooldown: ${h}h ${m.toString().padStart(2, '0')}m`;
      }
    }
    tierResetDetail.textContent = detail;
    if (r.ok) {
      tierResetBtn.textContent = '▼ RESET';
      tierResetBtn.style.color = 'var(--ri-warn)';
      tierResetBtn.style.borderColor = 'var(--ri-warn)';
      tierResetBtn.style.cursor = 'pointer';
      tierResetBtn.style.opacity = '1';
    } else {
      let label: string;
      switch (r.reason) {
        case 'tier-too-low':
          label = 'LOCKED · T3+';
          break;
        case 'cooldown-active':
          label = 'COOLDOWN';
          break;
        case 'insufficient-resources':
          label = 'NEED STEEL+GEAR';
          break;
      }
      tierResetBtn.textContent = label;
      tierResetBtn.style.color = 'var(--ri-fg-4)';
      tierResetBtn.style.borderColor = 'var(--ri-fg-4)';
      tierResetBtn.style.cursor = 'not-allowed';
      tierResetBtn.style.opacity = '0.6';
    }
  }

  refresh = (): void => {
    if (!handle.isVisible()) return;
    const state = getState();
    const need = xpForLevel(state.level + 1);
    levelVal.textContent = String(state.level);
    xpVal.textContent = `${state.xp.toFixed(0)} / ${need.toFixed(0)}`;
    tierVal.textContent = `T${tierForLevel(state.level)}`;
    pointsVal.textContent = String(state.unspentSkillPoints);

    refreshSpecialization();
    refreshTierReset();

    for (const node of NODE_CATALOG) {
      const ref = nodeRefs.get(node.id);
      if (!ref) continue;
      applyState(node, ref);
    }

    for (const branch of Object.keys(BRANCH_SUBPATHS) as BranchId[]) {
      for (const sp of BRANCH_SUBPATHS[branch]) {
        const subEl = subStatusRefs.get(sp);
        if (!subEl) continue;
        const prog = state.subPathProgress.get(sp);
        if (prog?.complete) {
          subEl.textContent = '◉ complete';
          subEl.style.color = 'var(--ri-accent)';
        } else if (prog && prog.spent >= 3) {
          subEl.textContent = '◐ committed';
          subEl.style.color = 'var(--ri-warn)';
        } else if (prog && prog.spent > 0) {
          subEl.textContent = `◑ ${prog.spent} pt`;
          subEl.style.color = 'var(--ri-fg-3)';
        } else {
          // 0 spent — but if a sibling in this branch is committed-but-
          // not-complete, the whole sub-path is branch-locked. Surface that
          // distinctly so the player doesn't waste clicks discovering it.
          const probeNode = NODE_CATALOG.find((n) => n.subPath === sp);
          const probe = probeNode ? canSpend(state, probeNode.id) : null;
          if (probe && !probe.ok && probe.reason === 'branch-locked') {
            subEl.textContent = '⊘ blocked';
            subEl.style.color = 'var(--ri-danger)';
          } else {
            subEl.textContent = '◇ open';
            subEl.style.color = 'var(--ri-fg-4)';
          }
        }
      }
    }
  };

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
