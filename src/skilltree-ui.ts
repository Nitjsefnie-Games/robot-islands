// Skill-tree panel — DOM overlay rendering §9.3 as a stats strip + tier-reset
// section + "Open Skill Graph" button. The full-page PixiJS graphview in
// `skilltree-graphview.ts` is the canonical rendering.

import { tierForLevel } from './skilltree.js';
import { type IslandState, xpForLevel } from './economy.js';

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

/** Active-island getter injected at mount. The panel reads the active
 *  island's state through this every refresh / click — switching active
 *  retargets the panel without re-mounting. */
export interface SkillTreeUiDeps {
  getState(): IslandState;
  openSkillGraph(): void;
}

export function mountSkillTreeUi(
  parentEl: HTMLElement,
  deps: SkillTreeUiDeps,
): SkillTreeUi {
  const getState = (): IslandState => deps.getState();

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
  const tierResetDetail = document.createElement('span');
  const tierResetBtn = document.createElement('button');

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

      // ---- Tier reset section -----------------------------------------------
      const tierSection = document.createElement('div');
      tierSection.style.display = 'flex';
      tierSection.style.flexDirection = 'column';
      tierSection.style.gap = '10px';
      tierSection.style.padding = '12px 0 14px';
      tierSection.style.borderTop = '1px solid var(--ri-rule)';
      tierSection.style.borderBottom = '1px solid var(--ri-border-strong)';

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
            'Clears: level, XP, skill points, graph unlocks.\n' +
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
      tierSection.appendChild(tierResetRow);

      body.appendChild(tierSection);

      // ---- Open Skill Graph button ------------------------------------------
      const openBtn = document.createElement('button');
      openBtn.className = 'ri-btn';
      openBtn.textContent = '\u2726 OPEN SKILL GRAPH';
      openBtn.style.alignSelf = 'center';
      openBtn.style.marginTop = '10px';
      openBtn.style.fontSize = '14px';
      openBtn.style.padding = '10px 22px';
      openBtn.addEventListener('click', () => {
        deps.openSkillGraph();
        handle.hide(); // modal yields to full-page overlay
      });
      body.appendChild(openBtn);
    },
    buildFooter(footer) {
      const footerL = document.createElement('span');
      footerL.textContent = 'graph-purchase: Dijkstra cheapest path from owned nodes';
      footerL.className = 'ri-muted';
      const footerR = document.createElement('span');
      footerR.textContent =
        'click a node to purchase via cheapest graph path \u00b7 keystone gates require all prereqs \u00b7 costs grow round(1.5^(depth-1))';
      footerR.className = 'ri-muted';
      footer.prepend(footerL);
      footer.appendChild(footerR);
    },
  });

  // ---------------------------------------------------------------------------
  // State-driven repaint helpers
  // ---------------------------------------------------------------------------

  function refreshTierReset(): void {
    const state = getState();
    const now = performance.now();
    const cost = tierResetCost(state.level);
    const r = canTierReset(state, now);
    let detail = `cost: ${cost.steel} steel \u00b7 ${cost.gear} gear`;
    if (state.lastResetAt !== null) {
      const elapsed = now - state.lastResetAt;
      const remaining = TIER_RESET_COOLDOWN_MS - elapsed;
      if (remaining > 0) {
        const h = Math.floor(remaining / 3_600_000);
        const m = Math.floor((remaining % 3_600_000) / 60_000);
        detail += `  \u00b7  cooldown: ${h}h ${m.toString().padStart(2, '0')}m`;
      }
    }
    tierResetDetail.textContent = detail;
    if (r.ok) {
      tierResetBtn.textContent = '\u25bc RESET';
      tierResetBtn.style.color = 'var(--ri-warn)';
      tierResetBtn.style.borderColor = 'var(--ri-warn)';
      tierResetBtn.style.cursor = 'pointer';
      tierResetBtn.style.opacity = '1';
    } else {
      let label: string;
      switch (r.reason) {
        case 'tier-too-low':
          label = 'LOCKED \u00b7 T3+';
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

    refreshTierReset();
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
