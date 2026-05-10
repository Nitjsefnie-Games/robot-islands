// DOM HUD overlay for the live island economy state.
//
// Plain DOM, no framework — matches the styling vocabulary of the existing
// `#info` strip (top-left) and `#ui-overlay` button panel (top-right). The
// HUD sits bottom-right so it doesn't fight either of those for screen
// real estate.
//
// `mountHud` creates and returns the panel + an `update` callback. The
// PixiJS ticker calls `update(state, net, power)` once per frame after
// `advanceIsland`. To support a per-frame colour change on the brownout
// factor without HTML reparse cost, the panel holds a stable three-node
// tree: text-node + span + text-node. Each frame writes only the three
// textContents and a single inline-style colour. This is faster than
// rebuilding innerHTML and avoids any node churn for a monospace block.
//
// Why DOM rather than PixiJS Text: the HUD updates every frame with
// changing strings, and the surrounding game UI (button panel) is already
// DOM. Mixing renderers for a static text overlay adds complexity without
// payoff. DOM text rendering is also crisper at any zoom level than PixiJS
// Text (which would need to be drawn at a fixed device pixel ratio).

import { type IslandState, type PowerBalance, xpForLevel } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

/**
 * Mounts a fixed-position panel and returns an `update` function. Calling
 * `update(state, net, power)` rewrites the panel's contents to match the
 * given state. The `net` argument carries per-resource net production rate
 * (units/sec), rendered alongside each inventory line. The `power` argument
 * carries the §5.1 electrical balance, rendered as its own line group above
 * Inventory; the `factor` field colour-codes brownout severity.
 */
export interface HudHandle {
  readonly el: HTMLDivElement;
  update(
    state: IslandState,
    net: Record<ResourceId, number>,
    power: PowerBalance,
  ): void;
}

// Brownout severity palette. Ramp from neutral text colour through warm
// amber to alert orange-red. Three tiers map to a glanceable engineering
// readout: nominal / marginal / critical.
const POWER_COLOR_NOMINAL = '#cdd6f4'; // factor === 1, matches default text
const POWER_COLOR_MARGINAL = '#f5a742'; // 0.5 ≤ factor < 1, warm amber
const POWER_COLOR_CRITICAL = '#e85d4a'; // factor < 0.5, alert orange-red

function powerColor(factor: number): string {
  if (factor >= 1) return POWER_COLOR_NOMINAL;
  if (factor >= 0.5) return POWER_COLOR_MARGINAL;
  return POWER_COLOR_CRITICAL;
}

export function mountHud(parentEl: HTMLElement): HudHandle {
  const panel = document.createElement('div');
  panel.id = 'hud-economy';
  panel.style.cssText = [
    'position: fixed',
    'bottom: 8px',
    'right: 8px',
    'min-width: 220px',
    'padding: 8px 10px',
    'background: rgba(20, 24, 32, 0.78)',
    'border: 1px solid #3a4452',
    'border-radius: 4px',
    'color: #cdd6f4',
    'font-family: ui-monospace, monospace',
    'font-size: 12px',
    'line-height: 1.5',
    'z-index: 100',
    'pointer-events: none',
    'white-space: pre',
    // Tabular numerals so digits line up in inventory rows.
    'font-variant-numeric: tabular-nums',
  ].join(';');
  parentEl.appendChild(panel);

  // Pre-build a stable two-node layout: one text node carries the
  // monospace block up to (and including) the literal "factor " marker;
  // a span carries just the numeric factor (so we can recolour it on
  // brownout); a trailing text node carries the rest. This keeps the
  // per-frame update O(small fixed) — three textContent assigns total —
  // and avoids re-parsing innerHTML each tick.
  const preNode = document.createTextNode('');
  const factorSpan = document.createElement('span');
  factorSpan.style.fontWeight = '600';
  const postNode = document.createTextNode('');
  panel.appendChild(preNode);
  panel.appendChild(factorSpan);
  panel.appendChild(postNode);

  /** Format a number for the HUD. Integers shown without decimal; otherwise
   *  one decimal place. The economy uses fractional inventories internally
   *  (rate × dt) so we round for display. */
  const fmt = (n: number): string => {
    if (Number.isInteger(n)) return n.toString();
    return n.toFixed(1);
  };

  /** Format a rate with sign and one decimal — small numbers around 0.1
   *  are typical for this tier. */
  const fmtRate = (n: number): string => {
    if (n === 0) return '   .   ';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}/s`;
  };

  function update(
    state: IslandState,
    net: Record<ResourceId, number>,
    power: PowerBalance,
  ): void {
    const need = xpForLevel(state.level + 1);
    const headerLines: string[] = [];
    headerLines.push(`Home Island`);
    headerLines.push(`Level ${state.level}   XP ${fmt(state.xp)} / ${fmt(need)}`);
    headerLines.push(`Skill points: ${state.unspentSkillPoints}`);
    headerLines.push(``);
    // Power line group. Format: `Power      <prod> / <con>  factor X.XX`.
    // Numbers right-padded so the columns don't jitter as production swings.
    const prodStr = fmt(power.produced).padStart(4, ' ');
    const conStr = fmt(power.consumed).padStart(4, ' ');
    const factorStr = power.factor.toFixed(2);
    headerLines.push(`Power      ${prodStr}W / ${conStr}W  factor `);
    // Render header → factor span → trailing inventory block.
    preNode.textContent = headerLines.join('\n');

    factorSpan.textContent = factorStr;
    factorSpan.style.color = powerColor(power.factor);

    const tailLines: string[] = [];
    tailLines.push(``);
    tailLines.push(`Inventory`);
    for (const r of ALL_RESOURCES) {
      const have = state.inventory[r] ?? 0;
      const cap = state.storageCaps[r] ?? 0;
      const rate = net[r] ?? 0;
      const name = (r + ':').padEnd(11, ' ');
      const have5 = fmt(have).padStart(5, ' ');
      const cap5 = fmt(cap).padStart(5, ' ');
      tailLines.push(`  ${name}${have5} / ${cap5}  ${fmtRate(rate)}`);
    }
    postNode.textContent = '\n' + tailLines.join('\n');
  }

  return { el: panel, update };
}
