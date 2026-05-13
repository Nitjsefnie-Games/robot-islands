// Skill-tree panel — DOM overlay rendering §9.3 as four branch columns.
//
// Aesthetic: a refinement of the existing HUD/ui-overlay industrial-readout
// vocabulary (dark monospace, `#0a0e14` page void, `#cdd6f4` foreground,
// `#3a4452` borders, `rgba(20,24,32,0.78)` panel fill). The skill panel
// pushes that vocabulary toward an engineering-blueprint feel: branch
// columns separated by thin double rules, each sub-path framed by a
// vertical depth-rail with tick marks at each depth, node rows that read
// like a printed datasheet with cost / magnitude / tier columns aligned to
// tabular-nums, and a single accent colour (`#7dd3e8` — the vision-blue
// already in the world palette) for unlocked nodes. Locked nodes are
// rendered at half-saturation but full legibility, never greyed-out
// illegibly.
//
// Rationale: the HUD has already established the visual contract. A major
// panel that breaks it (CRT terminal, brutalist data-table, editorial
// blueprint) would feel like a different app glued on. Refinement-not-
// departure preserves continuity while raising hierarchy density.
//
// The panel is fixed-position, centered, dismissable by KeyK (registered in
// input.ts) or its close button. Pointer events on the panel intercept
// canvas pan/zoom — clicks outside the panel still reach the canvas.

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

// Palette — derived from the world ocean palette + HUD foreground.
const PANEL_BG = 'rgba(14, 18, 26, 0.92)';
const PANEL_BORDER = '#3a4452';
const PANEL_HEADER_BORDER = '#4a5a72';
const FG = '#cdd6f4';
const FG_DIM = '#6c7791';
const FG_MUTED = '#4a5365';
const ACCENT = '#7dd3e8';
const ACCENT_DIM = '#3d6f7c';
const WARN = '#f5a742';
const STRIP_BG = 'rgba(20, 24, 32, 0.6)';

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  styled(
    b,
    [
      'background: #1a1f2a',
      `color: ${FG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'padding: 3px 9px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.04em',
      'text-transform: uppercase',
      'transition: background 80ms ease, border-color 80ms ease',
    ].join(';'),
  );
  b.addEventListener('mouseenter', () => {
    b.style.background = '#252b38';
    b.style.borderColor = ACCENT_DIM;
  });
  b.addEventListener('mouseleave', () => {
    b.style.background = '#1a1f2a';
    b.style.borderColor = PANEL_BORDER;
  });
  b.addEventListener('click', () => {
    onClick();
    b.blur();
  });
  return b;
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
  // Fresh reads on every closure entry — active island can swap mid-session.
  const getState = (): IslandState => deps.getState();
  // Forward-declared so the closures inside `nodeRow` can capture them. They
  // are populated before any `refresh()` call (which is itself bound at the
  // end of this function via the returned object).
  const nodeRefs = new Map<string, NodeRowRef>();
  const subStatusRefs = new Map<SubPathId, HTMLSpanElement>();

  // Mutable forward ref to `refresh` so click handlers can re-render after a
  // purchase. Assigned at the bottom of this function.
  let refresh: () => void = () => undefined;
  // Visibility flag — referenced by `refresh` to no-op while hidden.
  let visible = false;

  // Backdrop scrim — semi-transparent to dim the underlying canvas while the
  // panel is open. pointer-events: none so canvas pan/zoom outside the panel
  // still works as advertised.
  const scrim = document.createElement('div');
  scrim.id = 'skill-tree-scrim';
  styled(
    scrim,
    [
      'position: fixed',
      'inset: 0',
      'background: rgba(10, 14, 20, 0.55)',
      'z-index: 200',
      'display: none',
      'pointer-events: none',
      'backdrop-filter: blur(1.5px)',
    ].join(';'),
  );

  const panel = document.createElement('div');
  panel.id = 'skill-tree-panel';
  styled(
    panel,
    [
      'position: fixed',
      'top: 50%',
      'left: 50%',
      'transform: translate(-50%, -50%)',
      'width: min(1200px, calc(100vw - 32px))',
      'max-height: calc(100vh - 32px)',
      `background: ${PANEL_BG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'border-radius: 2px',
      'box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(125, 211, 232, 0.05)',
      'z-index: 201',
      'pointer-events: auto',
      `color: ${FG}`,
      'font-family: ui-monospace, monospace',
      'font-size: 12px',
      'line-height: 1.45',
      'font-variant-numeric: tabular-nums',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
    ].join(';'),
  );

  // -------------------------------------------------------------------------
  // Header strip — level / xp / unspent points + close button
  // -------------------------------------------------------------------------
  const header = document.createElement('div');
  styled(
    header,
    [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'padding: 10px 16px 9px',
      `border-bottom: 1px solid ${PANEL_HEADER_BORDER}`,
      `background: ${STRIP_BG}`,
      'gap: 14px',
    ].join(';'),
  );

  const headerTitle = document.createElement('div');
  styled(
    headerTitle,
    [
      'display: flex',
      'align-items: baseline',
      'gap: 10px',
      'flex: 0 0 auto',
    ].join(';'),
  );
  const title = document.createElement('span');
  title.textContent = 'SKILL TREE';
  styled(
    title,
    [
      `color: ${ACCENT}`,
      'font-size: 12px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const subtitle = document.createElement('span');
  subtitle.textContent = '§9.3';
  styled(
    subtitle,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.12em',
      'text-transform: uppercase',
    ].join(';'),
  );
  headerTitle.appendChild(title);
  headerTitle.appendChild(subtitle);

  const headerStats = document.createElement('div');
  styled(
    headerStats,
    [
      'flex: 1 1 auto',
      'display: flex',
      'justify-content: center',
      'gap: 22px',
      'font-size: 11px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
    ].join(';'),
  );

  function statBlock(label: string, valueEl: HTMLElement): HTMLDivElement {
    const wrap = document.createElement('div');
    styled(wrap, 'display: flex; align-items: baseline; gap: 6px');
    const l = document.createElement('span');
    l.textContent = label;
    styled(l, `color: ${FG_DIM}; font-size: 10px`);
    wrap.appendChild(l);
    wrap.appendChild(valueEl);
    return wrap;
  }

  const levelVal = document.createElement('span');
  styled(levelVal, `color: ${FG}; font-weight: 600`);
  const xpVal = document.createElement('span');
  styled(xpVal, `color: ${FG}`);
  const tierVal = document.createElement('span');
  styled(tierVal, `color: ${ACCENT}; font-weight: 600`);
  const pointsVal = document.createElement('span');
  styled(pointsVal, `color: ${WARN}; font-weight: 600; font-size: 13px`);

  headerStats.appendChild(statBlock('LEVEL', levelVal));
  headerStats.appendChild(statBlock('TIER', tierVal));
  headerStats.appendChild(statBlock('XP', xpVal));
  headerStats.appendChild(statBlock('UNSPENT', pointsVal));

  const closeBtn = makeButton('Close (K)', () => hide());
  styled(closeBtn,
    [
      closeBtn.style.cssText,
      'flex: 0 0 auto',
    ].join(';'),
  );

  header.appendChild(headerTitle);
  header.appendChild(headerStats);
  header.appendChild(closeBtn);

  // -------------------------------------------------------------------------
  // Body — four branch columns
  // -------------------------------------------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: grid',
      'grid-template-columns: 1fr 1fr 1fr 1fr',
      'gap: 1px',
      'background: #2a3140',
      'overflow-y: auto',
      'flex: 1 1 auto',
    ].join(';'),
  );

  function nodeRow(node: SkillNode, branch: BranchId): HTMLDivElement {
    const row = document.createElement('div');
    styled(
      row,
      [
        'display: grid',
        'grid-template-columns: 14px 1fr auto auto',
        'align-items: baseline',
        'gap: 9px',
        'padding: 5px 9px 5px 6px',
        `border-left: 2px solid ${FG_MUTED}`,
        'margin-left: 8px',
        'transition: background 100ms ease, border-color 100ms ease',
        'cursor: default',
      ].join(';'),
    );

    // Depth tick — a small monospaced indicator on the depth-rail.
    const tick = document.createElement('span');
    tick.textContent = String(node.depth).padStart(1, '0') + '.';
    styled(tick, `color: ${FG_MUTED}; font-size: 10px; letter-spacing: 0`);

    const main = document.createElement('div');
    styled(main, 'display: flex; flex-direction: column; gap: 1px; min-width: 0');

    const titleRow = document.createElement('div');
    styled(titleRow, 'display: flex; align-items: baseline; gap: 7px');
    const statusDot = document.createElement('span');
    statusDot.textContent = '○';
    styled(statusDot, `color: ${FG_MUTED}; font-size: 11px`);
    const titleEl = document.createElement('div');
    titleEl.textContent = `${SUBPATH_LABEL[node.subPath]} ${node.depth}`;
    styled(titleEl, `color: ${FG}; font-size: 12px; font-weight: 500`);
    titleRow.appendChild(statusDot);
    titleRow.appendChild(titleEl);
    main.appendChild(titleRow);

    const descEl = document.createElement('div');
    descEl.textContent = node.description;
    styled(descEl, `color: ${FG_DIM}; font-size: 10.5px`);
    main.appendChild(descEl);

    const tierTag = document.createElement('span');
    tierTag.textContent = `T${nodeRequiredTier(node)}`;
    styled(
      tierTag,
      [
        `color: ${FG_DIM}`,
        'font-size: 10px',
        'letter-spacing: 0.08em',
        `border: 1px solid ${FG_MUTED}`,
        'padding: 1px 5px',
        'border-radius: 2px',
      ].join(';'),
    );

    const costTag = document.createElement('span');
    costTag.textContent = `${node.cost} SP`;
    styled(
      costTag,
      [
        `color: ${WARN}`,
        'font-size: 10.5px',
        'letter-spacing: 0.04em',
        'font-weight: 600',
        'min-width: 38px',
        'text-align: right',
      ].join(';'),
    );

    row.appendChild(tick);
    row.appendChild(main);
    row.appendChild(tierTag);
    row.appendChild(costTag);

    // Click → attempt purchase. If allowed, mutate state and refresh.
    row.addEventListener('click', () => {
      const state = getState();
      const r = canSpend(state, node.id);
      if (!r.ok) return;
      spendPoint(state, node.id);
      refresh();
      // Bounce flash to confirm the purchase visually.
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
        row.style.background = 'rgba(125, 211, 232, 0.08)';
        row.style.borderLeftColor = ACCENT;
        row.style.cursor = 'pointer';
      }
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
      // Reset border colour based on current node state; refresh handles it.
      const ref = nodeRefs.get(node.id);
      if (ref) applyState(node, ref);
      row.style.cursor = 'default';
    });

    void branch; // reserved for future per-branch accent if needed
    nodeRefs.set(node.id, { row, statusDot, tierTag, costTag, descEl, titleEl });
    return row;
  }

  for (const branch of (Object.keys(BRANCH_SUBPATHS) as BranchId[])) {
    const col = document.createElement('div');
    styled(
      col,
      [
        `background: ${PANEL_BG}`,
        'padding: 14px 12px 18px',
        'display: flex',
        'flex-direction: column',
        'gap: 14px',
      ].join(';'),
    );

    const colHeader = document.createElement('div');
    styled(
      colHeader,
      [
        'display: flex',
        'align-items: baseline',
        'gap: 8px',
        `border-bottom: 1px solid ${PANEL_BORDER}`,
        'padding-bottom: 6px',
      ].join(';'),
    );
    const branchName = document.createElement('span');
    branchName.textContent = BRANCH_LABEL[branch].toUpperCase();
    styled(
      branchName,
      [
        `color: ${ACCENT}`,
        'font-size: 11px',
        'font-weight: 600',
        'letter-spacing: 0.2em',
      ].join(';'),
    );
    const branchSub = document.createElement('span');
    branchSub.textContent = '/ branch';
    styled(branchSub, `color: ${FG_DIM}; font-size: 9.5px; letter-spacing: 0.1em`);
    colHeader.appendChild(branchName);
    colHeader.appendChild(branchSub);
    col.appendChild(colHeader);

    for (const subPath of BRANCH_SUBPATHS[branch]) {
      const sub = document.createElement('div');
      styled(sub, 'display: flex; flex-direction: column; gap: 2px');

      const subHeader = document.createElement('div');
      styled(
        subHeader,
        [
          'display: flex',
          'align-items: baseline',
          'justify-content: space-between',
          'padding: 1px 0 3px',
        ].join(';'),
      );
      const subName = document.createElement('span');
      subName.textContent = SUBPATH_LABEL[subPath];
      styled(
        subName,
        [
          `color: ${FG}`,
          'font-size: 11.5px',
          'font-weight: 600',
          'letter-spacing: 0.03em',
        ].join(';'),
      );
      const subStatus = document.createElement('span');
      styled(
        subStatus,
        [
          `color: ${FG_DIM}`,
          'font-size: 9.5px',
          'letter-spacing: 0.06em',
          'text-transform: uppercase',
        ].join(';'),
      );
      subHeader.appendChild(subName);
      subHeader.appendChild(subStatus);
      sub.appendChild(subHeader);

      const subPathNodes = NODE_CATALOG
        .filter((n) => n.subPath === subPath)
        .slice()
        .sort((a, b) => a.depth - b.depth);
      for (const node of subPathNodes) {
        sub.appendChild(nodeRow(node, branch));
      }
      col.appendChild(sub);

      // Stash sub-status element for refresh.
      subStatusRefs.set(subPath, subStatus);
    }
    body.appendChild(col);
  }

  // -------------------------------------------------------------------------
  // Footer hint strip
  // -------------------------------------------------------------------------
  const footer = document.createElement('div');
  styled(
    footer,
    [
      'padding: 7px 16px',
      `border-top: 1px solid ${PANEL_HEADER_BORDER}`,
      `background: ${STRIP_BG}`,
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'display: flex',
      'justify-content: space-between',
      'text-transform: uppercase',
    ].join(';'),
  );
  const footerL = document.createElement('span');
  footerL.textContent = 'click a node to spend a skill point';
  const footerR = document.createElement('span');
  footerR.textContent = 'depth 1-2 require T2 · depth 3→T3 · depth 4→T4 · depth 5-7→T5 · depth 8+→T6 · costs grow 2^(depth-1)';
  footer.appendChild(footerL);
  footer.appendChild(footerR);

  // -------------------------------------------------------------------------
  // Specialization section — §9.4 role declaration (above the branch columns)
  // -------------------------------------------------------------------------
  //
  // Layout: section container with a caption row (left "SPECIALIZATION",
  // center subtitle, right status indicator), then a 5-column card grid
  // (one per RoleId). Each card has a top-band glyph + T3 chip, name,
  // datasheet rows, and a footer button (Locked / Declare / Active /
  // LockedRoleSet depending on state).
  const specSection = document.createElement('div');
  styled(
    specSection,
    [
      'padding: 12px 16px 14px',
      'background: rgba(20, 24, 32, 0.6)',
      `border-top: 1px solid ${PANEL_HEADER_BORDER}`,
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      'display: flex',
      'flex-direction: column',
      'gap: 10px',
    ].join(';'),
  );

  // Caption row.
  const captionRow = document.createElement('div');
  styled(
    captionRow,
    [
      'display: flex',
      'align-items: baseline',
      'justify-content: space-between',
      'gap: 12px',
    ].join(';'),
  );
  const captionLeft = document.createElement('span');
  captionLeft.textContent = 'SPECIALIZATION';
  styled(
    captionLeft,
    [
      `color: ${ACCENT}`,
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const captionSubtitle = document.createElement('span');
  captionSubtitle.textContent = '§9.4 / role declaration';
  styled(
    captionSubtitle,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.12em',
      'text-transform: uppercase',
      'flex: 1 1 auto',
      'padding-left: 14px',
    ].join(';'),
  );
  const captionStatus = document.createElement('span');
  styled(
    captionStatus,
    [
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.10em',
      'text-transform: uppercase',
      'flex: 0 0 auto',
    ].join(';'),
  );
  captionRow.appendChild(captionLeft);
  captionRow.appendChild(captionSubtitle);
  captionRow.appendChild(captionStatus);
  specSection.appendChild(captionRow);

  // 5-column card grid.
  const cardGrid = document.createElement('div');
  styled(
    cardGrid,
    [
      'display: grid',
      'grid-template-columns: repeat(5, 1fr)',
      'gap: 1px',
      'background: #2a3140',
    ].join(';'),
  );
  specSection.appendChild(cardGrid);

  // Per-role glyphs (verbatim from the visual spec).
  const ROLE_GLYPHS: Readonly<Record<RoleId, string>> = {
    foundry: '▣',           // ▣
    refinery: '◇',          // ◇
    mining: '▽',            // ▽
    logistics_hub: '⇄',     // ⇄
    research_beacon: '⊙',   // ⊙
  };
  // Display names for each card's title row — uppercased displayName, with
  // "LOGISTICS HUB" / "RESEARCH BEACON" reading more compact than the §9.4
  // catalog string ("Logistics Hub", "Research Beacon").
  const ROLE_CARD_NAMES: Readonly<Record<RoleId, string>> = {
    foundry: 'FOUNDRY',
    refinery: 'REFINERY',
    mining: 'MINING',
    logistics_hub: 'LOGISTICS HUB',
    research_beacon: 'RESEARCH BEACON',
  };

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

  // Build datasheet rows for a role. Returns the rendered container so the
  // card builder can attach it; the datasheet contents do not need to be
  // re-rendered per refresh (the role's effect doesn't change).
  function buildDatasheetRows(id: RoleId): HTMLDivElement {
    const wrap = document.createElement('div');
    styled(wrap, 'display: flex; flex-direction: column; gap: 3px');

    function row(label: string, valueSpan: HTMLElement): HTMLDivElement {
      const r = document.createElement('div');
      styled(
        r,
        [
          'display: flex',
          'justify-content: space-between',
          'align-items: baseline',
          'gap: 6px',
        ].join(';'),
      );
      const l = document.createElement('span');
      l.textContent = label;
      styled(
        l,
        [
          `color: ${FG_DIM}`,
          'font-size: 10px',
          'letter-spacing: 0.06em',
          'text-transform: uppercase',
        ].join(';'),
      );
      r.appendChild(l);
      r.appendChild(valueSpan);
      return r;
    }

    function valueSpan(text: string, color: string): HTMLSpanElement {
      const s = document.createElement('span');
      s.textContent = text;
      styled(
        s,
        [
          `color: ${color}`,
          'font-size: 11px',
          'font-weight: 600',
          'font-variant-numeric: tabular-nums',
        ].join(';'),
      );
      return s;
    }

    // U+2212 minus throughout (per spec) for clean typography vs ASCII '-'.
    const MIN = '−';

    switch (id) {
      case 'foundry':
        wrap.appendChild(row('SMELTING', valueSpan('+50%', ACCENT)));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}25%`, WARN)));
        break;
      case 'refinery':
        wrap.appendChild(row('CHEMISTRY', valueSpan('+50%', ACCENT)));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}25%`, WARN)));
        break;
      case 'mining':
        wrap.appendChild(row('EXTRACTION', valueSpan('+75%', ACCENT)));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}50%`, WARN)));
        break;
      case 'logistics_hub':
        wrap.appendChild(row('LOGISTICS', valueSpan('+100% · STG +50%', ACCENT)));
        wrap.appendChild(row('OTHERS', valueSpan(`${MIN}25%`, WARN)));
        break;
      case 'research_beacon': {
        // Mixed span: +50% in ACCENT, −25% in WARN, joined by " · ".
        const mixed = document.createElement('span');
        styled(
          mixed,
          [
            'font-size: 11px',
            'font-weight: 600',
            'font-variant-numeric: tabular-nums',
          ].join(';'),
        );
        const xpPart = document.createElement('span');
        xpPart.textContent = '+50%';
        styled(xpPart, `color: ${ACCENT}`);
        const sep = document.createElement('span');
        sep.textContent = ' · RECIPES ';
        styled(sep, `color: ${FG_DIM}`);
        const recipePart = document.createElement('span');
        recipePart.textContent = `${MIN}25%`;
        styled(recipePart, `color: ${WARN}`);
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

  // Short summary string used inside the confirm() prompt body. Matches the
  // datasheet contents at a sentence level so the confirmation reads like
  // a digest of the card. Plain ASCII — confirm() text renders consistently
  // across browsers without special glyph handling.
  const ROLE_CONFIRM_SUMMARY: Readonly<Record<RoleId, string>> = {
    foundry: '+50% smelting recipe rate, ×0.75 on all other production.',
    refinery: '+50% chemistry recipe rate, ×0.75 on all other production.',
    mining: '+75% extraction recipe rate, ×0.50 on all other production.',
    logistics_hub:
      '+100% logistics recipe rate, +50% storage caps, ×0.75 on all other production.',
    research_beacon: '+50% skill XP on this island, ×0.75 on all recipe rates.',
  };

  function buildCard(id: RoleId): void {
    const def = ROLE_DEFS[id];
    const card = document.createElement('div');
    styled(
      card,
      [
        'background: rgba(14, 18, 26, 0.92)',
        'padding: 10px 9px 9px',
        'display: flex',
        'flex-direction: column',
        'gap: 8px',
        'position: relative',
        'transition: opacity 100ms ease, background 100ms ease',
      ].join(';'),
    );

    // Top-border 2px (or 1px in the "others-after-declaration" state) drawn
    // as an absolute-positioned bar so we can swap its colour cleanly per
    // state without invalidating the card's padding box.
    const topBorder = document.createElement('div');
    styled(
      topBorder,
      [
        'position: absolute',
        'top: 0',
        'left: 0',
        'right: 0',
        'height: 2px',
        `background: ${FG_MUTED}`,
      ].join(';'),
    );
    card.appendChild(topBorder);

    // Glyph + T3 chip row.
    const glyphRow = document.createElement('div');
    styled(
      glyphRow,
      [
        'display: flex',
        'align-items: center',
        'justify-content: space-between',
        'gap: 6px',
      ].join(';'),
    );
    const glyph = document.createElement('span');
    glyph.textContent = ROLE_GLYPHS[id];
    styled(
      glyph,
      [
        `color: ${FG}`,
        'font-size: 16px',
        'font-family: ui-monospace, monospace',
        'font-variant-numeric: tabular-nums',
        'line-height: 1',
      ].join(';'),
    );
    const tierChip = document.createElement('span');
    tierChip.textContent = `T${def.tierRequirement}`;
    styled(
      tierChip,
      [
        `color: ${FG_DIM}`,
        'font-size: 9.5px',
        'letter-spacing: 0.08em',
        `border: 1px solid ${FG_MUTED}`,
        'padding: 0 4px',
        'border-radius: 2px',
        'line-height: 1.3',
      ].join(';'),
    );
    glyphRow.appendChild(glyph);
    glyphRow.appendChild(tierChip);
    card.appendChild(glyphRow);

    // Name (uppercase displayName).
    const nameEl = document.createElement('span');
    nameEl.textContent = ROLE_CARD_NAMES[id];
    styled(
      nameEl,
      [
        `color: ${FG}`,
        'font-size: 12px',
        'font-weight: 600',
        'letter-spacing: 0.03em',
        'text-transform: uppercase',
      ].join(';'),
    );
    card.appendChild(nameEl);

    // Datasheet rows.
    const datasheetEl = buildDatasheetRows(id);
    card.appendChild(datasheetEl);

    // Footer button. The default visual is "Declarable / WARN"; refresh()
    // recolours it per current state. Clicks are gated by current state at
    // dispatch time — the per-frame visual is independent of the listener.
    const footerBtn = document.createElement('button');
    styled(
      footerBtn,
      [
        'background: transparent',
        `color: ${FG_MUTED}`,
        `border: 1px solid ${FG_MUTED}`,
        'padding: 3px 9px',
        'font-family: ui-monospace, monospace',
        'font-size: 11px',
        'letter-spacing: 0.04em',
        'text-transform: uppercase',
        'cursor: not-allowed',
        'width: 100%',
        'margin-top: auto',
        'transition: background 80ms ease, color 80ms ease, border-color 80ms ease',
      ].join(';'),
    );
    footerBtn.addEventListener('click', () => {
      // Re-check state at click time — the button can be enabled by a level
      // up between paints.
      const state = getState();
      const role = state.specializationRole;
      if (role !== null) return; // already declared
      if (tierForLevel(state.level) < def.tierRequirement) return; // tier-locked
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
    // Hover wash for declarable cards. Refresh() repaints the base state on
    // mouseleave so a level-up mid-hover still settles correctly.
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

    // Absolute-positioned "● ACTIVE" stamp in top-right corner, shown only
    // when this card is the declared role. Hidden by default; refresh()
    // toggles its display.
    const activeStamp = document.createElement('span');
    activeStamp.textContent = '● ACTIVE';
    styled(
      activeStamp,
      [
        'position: absolute',
        'top: 6px',
        'right: 8px',
        `color: ${ACCENT}`,
        'font-size: 9px',
        'letter-spacing: 0.10em',
        `border: 1px solid rgba(125, 211, 232, 0.40)`,
        'padding: 1px 4px',
        'border-radius: 2px',
        'display: none',
      ].join(';'),
    );
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

  for (const id of ALL_ROLES) buildCard(id);

  // -------------------------------------------------------------------------
  // §9.7 Tier Reset row — sits inside the specialization section, just below
  // the role cards. The button is visible at T3+, shows cost + cooldown
  // countdown, and disables itself with a reason string when canTierReset
  // returns ok: false. Confirmation via window.confirm() — same pattern as
  // the §9.4 declaration buttons.
  // -------------------------------------------------------------------------
  const tierResetRow = document.createElement('div');
  styled(
    tierResetRow,
    [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'gap: 12px',
      `border-top: 1px solid ${PANEL_BORDER}`,
      'padding-top: 10px',
      'margin-top: 4px',
    ].join(';'),
  );
  const tierResetLeft = document.createElement('div');
  styled(tierResetLeft, 'display: flex; flex-direction: column; gap: 2px');
  const tierResetTitle = document.createElement('span');
  tierResetTitle.textContent = 'TIER RESET';
  styled(
    tierResetTitle,
    [
      `color: ${WARN}`,
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.18em',
    ].join(';'),
  );
  const tierResetSub = document.createElement('span');
  styled(
    tierResetSub,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.04em',
    ].join(';'),
  );
  tierResetSub.textContent = '§9.7 / revert to T1, preserve construction';
  tierResetLeft.appendChild(tierResetTitle);
  tierResetLeft.appendChild(tierResetSub);
  const tierResetDetail = document.createElement('span');
  styled(
    tierResetDetail,
    [`color: ${FG_DIM}`, 'font-size: 10px', 'letter-spacing: 0.02em'].join(';'),
  );
  tierResetLeft.appendChild(tierResetDetail);

  const tierResetBtn = document.createElement('button');
  styled(
    tierResetBtn,
    [
      'background: transparent',
      `color: ${WARN}`,
      `border: 1px solid ${WARN}`,
      'padding: 5px 12px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'transition: background 80ms ease, color 80ms ease, border-color 80ms ease',
      'flex: 0 0 auto',
    ].join(';'),
  );
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
    tierResetBtn.style.background = 'transparent';
  });
  tierResetRow.appendChild(tierResetLeft);
  tierResetRow.appendChild(tierResetBtn);
  specSection.appendChild(tierResetRow);

  /** Repaint the Tier Reset row from current state. The row is always
   *  visible inside the specialization section (so the player knows the
   *  feature exists), but the button label + enabled-state reflect the
   *  active gates: 'tier-too-low', 'cooldown-active' (with countdown),
   *  'insufficient-resources' (with cost + held amounts), or enabled. */
  function refreshTierReset(): void {
    const state = getState();
    const now = performance.now();
    const cost = tierResetCost(state.level);
    const r = canTierReset(state, now);
    // Detail line always shows the cost so the player can see the cost
    // grow as they level up. Append the cooldown remaining when relevant.
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
      tierResetBtn.style.color = WARN;
      tierResetBtn.style.borderColor = WARN;
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
      tierResetBtn.style.color = FG_MUTED;
      tierResetBtn.style.borderColor = FG_MUTED;
      tierResetBtn.style.cursor = 'not-allowed';
      tierResetBtn.style.opacity = '0.6';
    }
  }

  panel.appendChild(header);
  panel.appendChild(specSection);
  panel.appendChild(body);
  panel.appendChild(footer);

  parentEl.appendChild(scrim);
  parentEl.appendChild(panel);
  panel.style.display = 'none';

  function applyState(node: SkillNode, ref: NodeRowRef): void {
    const state = getState();
    const owned = state.unlockedNodes.has(node.id);
    const r = canSpend(state, node.id);
    if (owned) {
      ref.statusDot.textContent = '●';
      ref.statusDot.style.color = ACCENT;
      ref.titleEl.style.color = ACCENT;
      ref.descEl.style.color = FG_DIM;
      ref.row.style.borderLeftColor = ACCENT;
      ref.costTag.style.color = ACCENT_DIM;
      ref.costTag.style.textDecoration = 'line-through';
      ref.tierTag.style.borderColor = ACCENT_DIM;
      ref.tierTag.style.color = ACCENT_DIM;
      ref.row.style.opacity = '1';
    } else if (r.ok) {
      ref.statusDot.textContent = '◇';
      ref.statusDot.style.color = WARN;
      ref.titleEl.style.color = FG;
      ref.descEl.style.color = FG_DIM;
      ref.row.style.borderLeftColor = WARN;
      ref.costTag.style.color = WARN;
      ref.costTag.style.textDecoration = 'none';
      ref.tierTag.style.borderColor = FG_MUTED;
      ref.tierTag.style.color = FG_DIM;
      ref.row.style.opacity = '1';
    } else {
      ref.statusDot.textContent = '○';
      ref.statusDot.style.color = FG_MUTED;
      ref.titleEl.style.color = FG_DIM;
      ref.descEl.style.color = FG_MUTED;
      ref.row.style.borderLeftColor = FG_MUTED;
      ref.costTag.style.color = FG_MUTED;
      ref.costTag.style.textDecoration = 'none';
      ref.tierTag.style.borderColor = FG_MUTED;
      ref.tierTag.style.color = FG_MUTED;
      // Tier-locked deserves visual emphasis to communicate "can't spend yet,
      // come back at level N". Other locks (depth-prereq, branch-lock,
      // insufficient-points) stay dim but legible.
      ref.row.style.opacity = r.reason === 'tier-locked' ? '0.55' : '0.78';
    }
  }

  function refreshSpecialization(): void {
    const state = getState();
    const declared: RoleId | null = state.specializationRole;
    const tier = tierForLevel(state.level);
    const unlocked = tier >= 3;

    // Caption status — three branches: Locked / Awaiting / Active.
    if (!unlocked && declared === null) {
      captionStatus.textContent = '◯ REQUIRES TIER 3';
      captionStatus.style.color = FG_MUTED;
    } else if (declared !== null) {
      const name = ROLE_DEFS[declared].displayName.toUpperCase();
      captionStatus.textContent = `● ROLE ACTIVE: ${name}`;
      captionStatus.style.color = ACCENT;
    } else {
      captionStatus.textContent = '◇ AWAITING DECLARATION';
      captionStatus.style.color = WARN;
    }

    for (const id of ALL_ROLES) {
      const ref = cardRefs.get(id);
      if (!ref) continue;
      const isActive = declared === id;
      const isOtherDeclared = declared !== null && declared !== id;
      // Card-level state classification: Locked < tier 3, Declarable
      // (tier ≥ 3, no role), Active (this card), OtherDeclared.
      if (isActive) {
        ref.card.style.background = 'rgba(125, 211, 232, 0.05)';
        ref.card.style.opacity = '1';
        ref.topBorder.style.background = ACCENT;
        ref.topBorder.style.height = '2px';
        ref.glyph.style.color = ACCENT;
        ref.glyph.style.textShadow = '0 0 6px rgba(125, 211, 232, 0.4)';
        ref.tierChip.style.color = ACCENT;
        ref.tierChip.style.borderColor = ACCENT;
        ref.nameEl.style.color = FG;
        ref.datasheetEl.style.opacity = '1';
        ref.footerBtn.textContent = '● ACTIVE';
        ref.footerBtn.style.color = ACCENT;
        ref.footerBtn.style.borderColor = ACCENT;
        ref.footerBtn.style.cursor = 'default';
        ref.footerBtn.style.opacity = '1';
        ref.activeStamp.style.display = 'inline-block';
      } else if (isOtherDeclared) {
        ref.card.style.background = 'rgba(14, 18, 26, 0.92)';
        ref.card.style.opacity = '0.4';
        ref.topBorder.style.background = FG_MUTED;
        ref.topBorder.style.height = '1px';
        ref.glyph.style.color = FG_MUTED;
        ref.glyph.style.textShadow = 'none';
        ref.tierChip.style.color = FG_MUTED;
        ref.tierChip.style.borderColor = FG_MUTED;
        ref.nameEl.style.color = FG_MUTED;
        ref.datasheetEl.style.opacity = '1';
        ref.footerBtn.textContent = 'LOCKED · ROLE SET';
        ref.footerBtn.style.color = FG_MUTED;
        ref.footerBtn.style.borderColor = FG_MUTED;
        ref.footerBtn.style.cursor = 'not-allowed';
        ref.footerBtn.style.opacity = '0.6';
        ref.activeStamp.style.display = 'none';
      } else if (unlocked) {
        // Declarable.
        ref.card.style.background = 'rgba(14, 18, 26, 0.92)';
        ref.card.style.opacity = '1';
        ref.topBorder.style.background = WARN;
        ref.topBorder.style.height = '2px';
        ref.glyph.style.color = FG;
        ref.glyph.style.textShadow = 'none';
        ref.tierChip.style.color = FG_DIM;
        ref.tierChip.style.borderColor = FG_MUTED;
        ref.nameEl.style.color = FG;
        ref.datasheetEl.style.opacity = '1';
        ref.footerBtn.textContent = '▶ DECLARE';
        ref.footerBtn.style.color = WARN;
        ref.footerBtn.style.borderColor = WARN;
        ref.footerBtn.style.cursor = 'pointer';
        ref.footerBtn.style.opacity = '1';
        ref.activeStamp.style.display = 'none';
      } else {
        // Locked (tier < 3).
        ref.card.style.background = 'rgba(14, 18, 26, 0.92)';
        ref.card.style.opacity = '0.55';
        ref.topBorder.style.background = FG_MUTED;
        ref.topBorder.style.height = '2px';
        ref.glyph.style.color = FG_MUTED;
        ref.glyph.style.textShadow = 'none';
        ref.tierChip.style.color = FG_MUTED;
        ref.tierChip.style.borderColor = FG_MUTED;
        ref.nameEl.style.color = FG_DIM;
        ref.datasheetEl.style.opacity = '0.8';
        ref.footerBtn.textContent = 'LOCKED · T3';
        ref.footerBtn.style.color = FG_MUTED;
        ref.footerBtn.style.borderColor = FG_MUTED;
        ref.footerBtn.style.cursor = 'not-allowed';
        ref.footerBtn.style.opacity = '0.5';
        ref.activeStamp.style.display = 'none';
      }
    }
  }

  refresh = (): void => {
    // Skip work while hidden — the ticker calls this every frame.
    if (!visible) return;
    const state = getState();
    const need = xpForLevel(state.level + 1);
    levelVal.textContent = String(state.level);
    xpVal.textContent = `${state.xp.toFixed(0)} / ${need.toFixed(0)}`;
    tierVal.textContent = `T${tierForLevel(state.level)}`;
    pointsVal.textContent = String(state.unspentSkillPoints);

    // Specialization section refresh — caption status + per-card state.
    refreshSpecialization();
    // §9.7 Tier Reset row — refreshes the cost / cooldown / enabled state.
    refreshTierReset();

    for (const node of NODE_CATALOG) {
      const ref = nodeRefs.get(node.id);
      if (!ref) continue;
      applyState(node, ref);
    }

    // Sub-path summary status: "committed", "complete", "locked", "open".
    for (const branch of (Object.keys(BRANCH_SUBPATHS) as BranchId[])) {
      for (const sp of BRANCH_SUBPATHS[branch]) {
        const subEl = subStatusRefs.get(sp);
        if (!subEl) continue;
        const prog = state.subPathProgress.get(sp);
        if (prog?.complete) {
          subEl.textContent = '◉ complete';
          subEl.style.color = ACCENT;
        } else if (prog && prog.spent >= 3) {
          subEl.textContent = '◐ committed';
          subEl.style.color = WARN;
        } else if (prog && prog.spent > 0) {
          subEl.textContent = `◑ ${prog.spent} pt`;
          subEl.style.color = FG_DIM;
        } else {
          subEl.textContent = '◇ open';
          subEl.style.color = FG_MUTED;
        }
      }
    }
  };

  function show(): void {
    if (visible) return;
    visible = true;
    panel.style.display = 'flex';
    scrim.style.display = 'block';
    refresh();
  }
  function hide(): void {
    if (!visible) return;
    visible = false;
    panel.style.display = 'none';
    scrim.style.display = 'none';
  }
  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }

  // No initial paint — `refresh()` no-ops while hidden, and `show()` calls
  // it on transition. Nodes are built with neutral defaults; the first
  // `show()` recolors them correctly.
  return {
    el: panel,
    refresh,
    show,
    hide,
    toggle,
    isVisible: () => visible,
  };
}
