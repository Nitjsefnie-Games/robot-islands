// §14 T6 Orbital launch modal + canvas reticle target picker.
//
// Mirrors the §11 drone launch flow (see `drones-ui.ts` `mountDronesUi`):
// arm-launch → click target on canvas → `launchSatellite` called with the
// chosen target coords → toast + reopen-modal on commit; right-click /
// Escape to cancel. Reticle colour: cyan = reachable, amber = out of range
// for the variant's onboard fuel reserve.

import { Container, Graphics } from 'pixi.js';

import type { IslandState } from './economy.js';
import { TILE_PX } from './island.js';
import {
  SAT_FUEL_PER_TILE,
  dispatchRepairDrone,
  launchSatellite,
  requestSatMove,
  upgradeSpaceport,
  type Satellite,
  type SatelliteVariant,
} from './orbital.js';
import type { ResourceId } from './recipes.js';
import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { findOperationalBuilding, hasOperationalBuilding } from './buildings.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import { mountModal, type ModalHandle } from './ui-modal.js';
import { VISION_BLUE, type WorldState } from './world.js';
import { getToastHandle } from './toast.js';
import { type GatewayReturn, type MutationGateway } from './mutation-gateway.js';

export interface OrbitalUiHandle {
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
  /** Repaint the body — call when the modal is open so resource counts +
   *  satellite roster stay live. Cheap when hidden (early-return). */
  refresh(): void;
  /** Whether a launch is currently armed (reticle active on canvas). The
   *  canvas mousedown / mousemove handlers in main.ts read this to route
   *  the click to `attemptLaunch` and to keep the reticle in sync. */
  isLaunchMode(): boolean;
  /** Force launch mode on/off externally. Used by main.ts to enforce
   *  mode mutual-exclusion when a sister panel arms its own launch. */
  setLaunchMode(on: boolean): void;
  /** Update the reticle's screen position (canvas mousemove). No-op when
   *  not in launch mode. */
  setReticleScreenPos(x: number, y: number): void;
  /** Hide the reticle (canvas mouseleave). */
  hideReticle(): void;
  /** Try to launch the armed (islandId, variant) toward a world-tile target.
   *  Called by main.ts on a small canvas click in launch mode. Returns the
   *  dispatch result so main.ts can show feedback. */
  attemptLaunch(targetWorldTileX: number, targetWorldTileY: number, nowMs: number): {
    ok: boolean;
    reason?: string;
  };
  /** Container for the launch reticle (lives in screen space). Add directly
   *  to the stage, not the world container — it shouldn't pan/zoom. */
  readonly reticleLayer: Container;
}

export interface OrbitalUiDeps {
  readonly world: WorldState;
  readonly islandStates: Map<string, IslandState>;
  /** Mutation gateway — optional so tests can keep wiring only the fields
   *  they already have. */
  gateway?: MutationGateway;
  /** Convert a screen-pixel point to a world-tile point (fed by main.ts
   *  using the camera). Used by the reticle to colour by reachability. */
  screenToWorldTile(screenX: number, screenY: number): { x: number; y: number };
  /** Called whenever launch-mode toggles on/off. Used by main.ts to disarm
   *  sister modes (drones / settlement / placement) so a canvas click can't
   *  ambiguously route to multiple consumers. */
  onLaunchModeChanged?(armed: boolean): void;
}

interface VariantSpec {
  readonly variant: SatelliteVariant;
  readonly label: string;
  readonly payload: ResourceId;
  readonly summary: string;
}

const VARIANTS: ReadonlyArray<VariantSpec> = [
  {
    variant: 'scanner',
    label: 'Scanner Sat',
    payload: 'scanner_sat',
    summary: 'Extends ocean fog vision around its current cell',
  },
  {
    variant: 'relay',
    label: 'Relay Sat',
    payload: 'relay_sat',
    summary: 'Relays buffered packets between distant Spaceports',
  },
  {
    variant: 'sweeper',
    label: 'Sweeper Sat',
    payload: 'sweeper_sat',
    summary: 'Removes debris fragments from its cell over time',
  },
  {
    variant: 'mirror',
    label: 'Mirror Sat',
    payload: 'mirror_sat',
    summary: 'Reflects sunlight, boosting solar output on islands in range (also at night)',
  },
];

const COMMON_RESOURCES: ReadonlyArray<ResourceId> = [
  'orbital_insertion_package',
  'antimatter_propellant',
];

const FAIL_REASON_LABEL: Readonly<Record<string, string>> = {
  'no-island': 'island missing',
  'no-spaceport': 'no Spaceport on this island',
  'no-ascendant-core': 'no Ascendant Core crafted',
  'insufficient-resources': 'missing materials',
  'launch-failure': 'launch failed',
  'target-at-source': 'target is the launch pad',
  'target-out-of-range': 'target out of onboard-fuel range',
  'no-satellite': 'satellite missing',
  'repair-pending': 'repair already in progress',
  'pending-repair': 'repair in progress',
  'insufficient-repair-pack': 'no Repair Pack on hand',
  'insufficient-fuel': 'not enough maneuvering fuel',
  'already-moving': 'satellite already in transit',
  'not-locked': 'satellite is not parked',
  'no-distance': 'target is the current position',
};

function inv(state: IslandState, id: ResourceId): number {
  return state.inventory[id] ?? 0;
}

function nameForIsland(world: WorldState, id: string): string {
  const spec = world.islands.find((i) => i.id === id);
  return spec?.name ?? id;
}

/** Compute the launch spawn tile (Spaceport footprint centre) for an island.
 *  Returns null when the island spec or its Spaceport can't be located —
 *  callers (reticle reachability colouring) treat null as "no launch
 *  possible right now" and degrade gracefully. */
function spaceportSpawn(
  world: WorldState,
  state: IslandState,
): { x: number; y: number } | null {
  const spec = world.islands.find((i) => i.id === state.id);
  if (!spec) return null;
  const sp = findOperationalBuilding(state.buildings, 'spaceport');
  if (!sp) return null;
  const def = BUILDING_DEFS[sp.defId as BuildingDefId];
  return {
    x: spec.cx + sp.x + (shapeWidth(def.footprint) - 1) / 2,
    y: spec.cy + sp.y + (shapeHeight(def.footprint) - 1) / 2,
  };
}

/** Maximum launch distance in tiles for the configured `satFuelReserve`
 *  skill multiplier. Matches the validator inside `launchSatellite`:
 *  `(100 * satFuelReserve) / SAT_FUEL_PER_TILE`. */
function maxLaunchRangeForIsland(state: IslandState): number {
  const skill = effectiveSkillMultipliers(state);
  return (100 * skill.satFuelReserve) / SAT_FUEL_PER_TILE;
}

export function mountOrbitalUi(
  parentEl: HTMLElement,
  deps: OrbitalUiDeps,
): OrbitalUiHandle {
  let bodyEl: HTMLDivElement | null = null;
  let footerEl: HTMLDivElement | null = null;
  let lastFlash: { msg: string; until: number } | null = null;
  let lastBodySig = '';

  // ----- Armed-launch state ------------------------------------------------
  // While `armed !== null` the modal is hidden and a canvas reticle follows
  // the cursor. Clicking the canvas commits a launch with the captured
  // (islandId, variant) pair; Escape / right-click cancels.
  // A launch arms an (island, variant) pair; a move arms an existing satellite.
  // Both share the canvas reticle + click-commit path (attemptLaunch dispatches
  // on `kind`), so main.ts needs no change — `isLaunchMode()` covers both.
  let armed:
    | { kind: 'launch'; islandId: string; variant: SatelliteVariant }
    | { kind: 'move'; satId: string; islandId: string }
    | null = null;

  const flash = (msg: string): void => {
    lastFlash = { msg, until: performance.now() + 4000 };
    render();
  };

  // ----- Reticle (screen-space Pixi layer) --------------------------------
  // Mirror of the drone-launch reticle: a crosshair drawn in screen pixels
  // so it stays the same size regardless of zoom. Colour buckets are pre-
  // painted and swapped on cursor moves only when the bucket changes
  // (cyan = reachable, amber = out of range).
  const reticleLayer = new Container();
  reticleLayer.label = 'orbital-launch-reticle';
  reticleLayer.visible = false;
  const reticleGfx = new Graphics();
  const RETICLE_OK = VISION_BLUE;
  const RETICLE_WARN = 0xf5a742;
  let reticlePainted = -1;
  function paintReticle(color: number): void {
    reticleGfx.clear();
    reticleGfx.circle(0, 0, 14).stroke({ width: 2, color, alpha: 0.85 });
    reticleGfx.circle(0, 0, 6).stroke({ width: 1, color, alpha: 0.7 });
    const inner = 3;
    const outer = 18;
    reticleGfx.moveTo(-outer, 0).lineTo(-inner, 0).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.moveTo(inner, 0).lineTo(outer, 0).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.moveTo(0, -outer).lineTo(0, -inner).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.moveTo(0, inner).lineTo(0, outer).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.rect(-1, -1, 2, 2).fill({ color, alpha: 0.9 });
  }
  function ensurePainted(color: number): void {
    if (reticlePainted === color) return;
    reticlePainted = color;
    paintReticle(color);
  }
  ensurePainted(RETICLE_OK);
  reticleLayer.addChild(reticleGfx);

  // Reachable-range ring around the armed Spaceport — drawn in WORLD space
  // so the radius reads correctly in tiles at any zoom. Sister to the
  // drones-ui range ring; visibility tracks `armed`.
  const rangeRingLayer = new Container();
  rangeRingLayer.label = 'orbital-launch-range-ring';
  rangeRingLayer.visible = false;
  const rangeRingGfx = new Graphics();
  rangeRingLayer.addChild(rangeRingGfx);
  function repaintRangeRing(): void {
    rangeRingGfx.clear();
    // Only launches draw the fixed Spaceport range ring; a move's reach is from
    // the satellite's own position and is left to gateway validation.
    if (!armed || armed.kind !== 'launch') return;
    const state = deps.islandStates.get(armed.islandId);
    if (!state) return;
    const spawn = spaceportSpawn(deps.world, state);
    if (!spawn) return;
    const radiusTiles = maxLaunchRangeForIsland(state);
    if (radiusTiles <= 0) return;
    const radiusPx = radiusTiles * TILE_PX;
    const cx = spawn.x * TILE_PX;
    const cy = spawn.y * TILE_PX;
    rangeRingGfx.circle(cx, cy, radiusPx).fill({ color: VISION_BLUE, alpha: 0.05 });
    rangeRingGfx.circle(cx, cy, radiusPx).stroke({ width: 2, color: VISION_BLUE, alpha: 0.55 });
    const cross = TILE_PX;
    rangeRingGfx.moveTo(cx - cross, cy).lineTo(cx + cross, cy)
      .stroke({ width: 1, color: VISION_BLUE, alpha: 0.5 });
    rangeRingGfx.moveTo(cx, cy - cross).lineTo(cx, cy + cross)
      .stroke({ width: 1, color: VISION_BLUE, alpha: 0.5 });
  }
  // Range ring lives in world space, reticle in screen space — they stay
  // separate layers so the ring's radius reads correctly in tiles at any zoom.

  // ----- setLaunchMode (canonical entry point) ----------------------------
  function setLaunchMode(on: boolean, target?: { islandId: string; variant: SatelliteVariant }): void {
    if (on) {
      if (!target) {
        // Defensive: caller asked to arm without a (islandId, variant). No-op
        // — there's nothing to commit to. Sister panels use this branch to
        // signal "make sure orbital is disarmed".
        if (armed) {
          armed = null;
          reticleLayer.visible = false;
          rangeRingLayer.visible = false;
          deps.onLaunchModeChanged?.(false);
        }
        return;
      }
      armed = { kind: 'launch', islandId: target.islandId, variant: target.variant };
      reticleLayer.visible = true;
      repaintRangeRing();
      rangeRingLayer.visible = true;
      deps.onLaunchModeChanged?.(true);
    } else {
      if (!armed) return;
      armed = null;
      reticleLayer.visible = false;
      rangeRingLayer.visible = false;
      deps.onLaunchModeChanged?.(false);
    }
  }

  // Arm a satellite relocation (§14.6). Mirrors a launch arm: the modal hides
  // (done by the caller) and the next canvas click commits via attemptLaunch →
  // attemptMove. No fixed range ring — the move's reach is from the sat itself.
  function armMove(satId: string, islandId: string): void {
    armed = { kind: 'move', satId, islandId };
    reticleLayer.visible = true;
    rangeRingGfx.clear();
    rangeRingLayer.visible = false;
    deps.onLaunchModeChanged?.(true);
  }

  // Normalize a gateway return (sync LOCAL or async REMOTE) or a pure-fn result
  // to a uniform { ok, reason }. Pure results carry `reason`; gateway errors
  // carry `error` (mapped to reason here).
  async function normalizeResult(
    r: GatewayReturn<unknown> | { ok: boolean; reason?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const res = await r;
    if (res.ok) return { ok: true };
    const reason = 'reason' in res && res.reason !== undefined
      ? res.reason
      : 'error' in res ? res.error : undefined;
    return { ok: false, reason };
  }

  // ----- attemptLaunch (canvas click commit) ------------------------------
  function attemptLaunch(
    targetWorldTileX: number,
    targetWorldTileY: number,
    nowMs: number,
  ): { ok: boolean; reason?: string } {
    if (!armed) return { ok: false, reason: 'not-armed' };
    if (armed.kind === 'move') {
      return attemptMove(armed.satId, targetWorldTileX, targetWorldTileY, nowMs);
    }
    const armedCapture = armed;
    const gatewayResult = deps.gateway
      ? deps.gateway.launchSatellite(armedCapture.islandId, armedCapture.variant, targetWorldTileX, targetWorldTileY, nowMs)
      : undefined;
    if (gatewayResult instanceof Promise) {
      void (async () => {
        const result = await gatewayResult;
        const toast = getToastHandle();
        if (result.ok) {
          const msg = `Launched ${armedCapture.variant} sat from ${nameForIsland(deps.world, armedCapture.islandId)}`;
          flash(msg);
          toast?.show(msg, 'success');
          setLaunchMode(false);
          modal.show();
          render();
          return;
        }
        const failReason = result.reason ?? 'unknown';
        const label = FAIL_REASON_LABEL[failReason] ?? failReason;
        const msg = `Launch failed: ${label}`;
        flash(msg);
        toast?.show(msg, 'failure');
        if (failReason !== 'target-at-source' && failReason !== 'target-out-of-range') {
          setLaunchMode(false);
          modal.show();
          render();
        }
      })();
      return { ok: false };
    }
    const result = gatewayResult ?? launchSatellite(
      deps.world,
      armedCapture.islandId,
      armedCapture.variant,
      targetWorldTileX,
      targetWorldTileY,
      nowMs,
    );
    const toast = getToastHandle();
    if (result.ok) {
      const msg = `Launched ${armed.variant} sat from ${nameForIsland(deps.world, armed.islandId)}`;
      flash(msg);
      toast?.show(msg, 'success');
      // Disarm + reopen modal so the player sees the updated roster.
      setLaunchMode(false);
      modal.show();
      render();
      return { ok: true };
    }
    const failReason = result.reason ?? 'unknown';
    const label = FAIL_REASON_LABEL[failReason] ?? failReason;
    const msg = `Launch failed: ${label}`;
    flash(msg);
    toast?.show(msg, 'failure');
    // Keep launch mode armed on a target-validation failure so the player
    // can pick a different target without re-arming. On other rejections
    // (insufficient-resources, etc.) the modal would be more useful — disarm
    // and reopen so the player can see what's missing.
    if (failReason !== 'target-at-source' && failReason !== 'target-out-of-range') {
      setLaunchMode(false);
      modal.show();
      render();
    }
    return { ok: false, reason: result.reason };
  }

  // ----- attemptMove (canvas click commit for a relocation) ---------------
  function attemptMove(
    satId: string,
    targetWorldTileX: number,
    targetWorldTileY: number,
    nowMs: number,
  ): { ok: boolean; reason?: string } {
    void (async () => {
      const res = await normalizeResult(
        deps.gateway
          ? deps.gateway.moveSatellite(satId, targetWorldTileX, targetWorldTileY, nowMs)
          : requestSatMove(deps.world, satId, targetWorldTileX, targetWorldTileY, nowMs),
      );
      const toast = getToastHandle();
      if (res.ok) {
        const msg = `Relocating satellite ${satId}`;
        flash(msg);
        toast?.show(msg, 'success');
      } else {
        const label = FAIL_REASON_LABEL[res.reason ?? ''] ?? res.reason ?? 'unknown';
        const msg = `Move failed: ${label}`;
        flash(msg);
        toast?.show(msg, 'failure');
      }
      // Either way, disarm and reopen the roster so the player sees the result.
      setLaunchMode(false);
      modal.show();
      render();
    })();
    return { ok: true };
  }

  // ----- Reticle position + reachability colour ---------------------------
  function setReticleScreenPos(x: number, y: number): void {
    if (!armed) return;
    reticleGfx.position.set(x, y);
    // A move has no fixed origin ring; keep the reticle neutral (gateway
    // validates reach on commit).
    if (armed.kind !== 'launch') {
      ensurePainted(RETICLE_OK);
      return;
    }
    const state = deps.islandStates.get(armed.islandId);
    if (!state) return;
    const spawn = spaceportSpawn(deps.world, state);
    if (!spawn) return;
    const wp = deps.screenToWorldTile(x, y);
    const dx = wp.x - spawn.x;
    const dy = wp.y - spawn.y;
    const dist = Math.hypot(dx, dy);
    const maxRange = maxLaunchRangeForIsland(state);
    ensurePainted(dist > maxRange || dist <= 0 ? RETICLE_WARN : RETICLE_OK);
  }
  function hideReticleFn(): void {
    reticleGfx.position.set(-9999, -9999);
  }

  // ----- Modal body (island cards + roster) ------------------------------
  const renderIslandCard = (state: IslandState): HTMLDivElement => {
    const card = document.createElement('div');
    card.classList.add('ri-orbital-card');
    card.style.cssText = `
      border: 1px solid var(--ri-line);
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    `;

    const spaceport = findOperationalBuilding(state.buildings, 'spaceport');
    const tier = spaceport?.tier ?? 1;
    const ascendant = state.ascendantCoreCrafted === true;

    const head = document.createElement('div');
    head.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 12px;';
    const title = document.createElement('strong');
    title.textContent = nameForIsland(deps.world, state.id);
    title.style.color = 'var(--ri-accent)';
    head.appendChild(title);
    const meta = document.createElement('span');
    meta.style.cssText = 'color: var(--ri-fg-2); letter-spacing: 0.08em;';
    meta.textContent = `SPACEPORT T${tier} · ${ascendant ? 'GATE OPEN' : 'NO ASCENDANT CORE'}`;
    if (!ascendant) meta.style.color = 'var(--ri-warn, #e6b800)';
    head.appendChild(meta);
    card.appendChild(head);

    // Common-resource row.
    const commons = document.createElement('div');
    commons.style.cssText = 'color: var(--ri-fg-2); display: flex; gap: 14px; flex-wrap: wrap;';
    for (const r of COMMON_RESOURCES) {
      const cell = document.createElement('span');
      cell.textContent = `${r.replace(/_/g, ' ')}: ${inv(state, r)}`;
      commons.appendChild(cell);
    }
    card.appendChild(commons);

    // §14.2 Spaceport tier I/II/III upgrade affordance. Hidden once at
    // max tier; cost preview ahead of the button so the player can see
    // what the next tier will require before committing.
    if (tier < 3) {
      const nextTier = tier + 1;
      const upgradeCost: Partial<Record<ResourceId, number>> = tier === 1
        ? { phase_converter: 5, memetic_core: 2, cryogenic_hydrogen: 50 }
        : { reality_anchor: 10, memetic_core: 5, antimatter_propellant: 100 };
      const upgradeRow = document.createElement('div');
      upgradeRow.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 4px 0; border-top: 1px dashed var(--ri-border-strong); padding-top: 8px;';
      const upgradeLeft = document.createElement('div');
      upgradeLeft.style.cssText = 'flex: 1; display: flex; flex-direction: column;';
      const upgradeTitle = document.createElement('span');
      upgradeTitle.textContent = `Upgrade to T${nextTier}`;
      upgradeTitle.style.color = 'var(--ri-accent)';
      upgradeLeft.appendChild(upgradeTitle);
      const upgradeCostLine = document.createElement('span');
      const costParts: string[] = [];
      let canAfford = true;
      for (const [r, amt] of Object.entries(upgradeCost)) {
        const have = inv(state, r as ResourceId);
        const need = amt ?? 0;
        if (have < need) canAfford = false;
        costParts.push(`${r}: ${have}/${need}`);
      }
      upgradeCostLine.textContent = costParts.join('  ·  ');
      upgradeCostLine.style.cssText = `color: ${canAfford ? 'var(--ri-fg-2)' : 'var(--ri-warn)'}; font-size: 11px;`;
      upgradeLeft.appendChild(upgradeCostLine);
      upgradeRow.appendChild(upgradeLeft);
      const upgradeBtn = document.createElement('button');
      upgradeBtn.textContent = 'Upgrade';
      upgradeBtn.classList.add('ri-btn');
      upgradeBtn.style.cssText = `
        background: var(--ri-elev);
        color: var(--ri-accent);
        border: 1px solid var(--ri-accent);
        padding: 4px 12px;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        cursor: pointer;
        border-radius: 3px;
      `;
      if (!canAfford) {
        upgradeBtn.disabled = true;
        upgradeBtn.style.opacity = '0.4';
        upgradeBtn.style.cursor = 'not-allowed';
        upgradeBtn.title = 'Missing materials';
      }
      upgradeBtn.addEventListener('click', async () => {
        if (!canAfford) return;
        const r = deps.gateway
          ? await deps.gateway.upgradeSpaceport(state.id)
          : upgradeSpaceport(deps.world, state.id);
        const toast = getToastHandle();
        if (r.ok) {
          flash(`Spaceport upgraded to T${nextTier}`);
          toast?.show(`Spaceport upgraded to T${nextTier}`, 'success');
        } else {
          flash(`Upgrade failed: ${r.reason}`);
          toast?.show(`Upgrade failed: ${r.reason}`, 'failure');
        }
        render();
      });
      upgradeRow.appendChild(upgradeBtn);
      card.appendChild(upgradeRow);
    }

    // Per-variant arm-launch row.
    for (const v of VARIANTS) {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 4px 0;';
      const left = document.createElement('div');
      left.style.cssText = 'flex: 1; display: flex; flex-direction: column;';
      const lbl = document.createElement('span');
      lbl.textContent = `${v.label} · payload ${inv(state, v.payload)}`;
      lbl.style.color = 'var(--ri-fg-1)';
      left.appendChild(lbl);
      const desc = document.createElement('span');
      desc.textContent = v.summary;
      desc.style.cssText = 'color: var(--ri-fg-2); font-size: 11px;';
      left.appendChild(desc);
      row.appendChild(left);

      const btn = document.createElement('button');
      btn.textContent = 'Arm Launch';
      btn.classList.add('ri-btn');
      btn.style.cssText = `
        background: var(--ri-elev);
        color: var(--ri-accent);
        border: 1px solid var(--ri-accent);
        padding: 4px 12px;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        cursor: pointer;
        border-radius: 3px;
      `;
      const hasMaterials =
        inv(state, v.payload) >= 1 &&
        inv(state, 'orbital_insertion_package') >= 1 &&
        inv(state, 'antimatter_propellant') >= 1;
      const hasSpaceport = hasOperationalBuilding(state.buildings, 'spaceport');
      const enabled = ascendant && hasMaterials && hasSpaceport;
      if (!enabled) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.style.cursor = 'not-allowed';
        btn.title = !ascendant
          ? 'Craft an Ascendant Core first'
          : !hasSpaceport
            ? 'No Spaceport on this island'
            : 'Missing materials';
      }
      btn.addEventListener('click', () => {
        if (!enabled) return;
        // Hide the modal and arm the reticle. The next canvas click commits
        // the launch via attemptLaunch().
        modal.hide();
        setLaunchMode(true, { islandId: state.id, variant: v.variant });
      });
      row.appendChild(btn);
      card.appendChild(row);
    }
    return card;
  };

  function rosterBtn(
    label: string,
    enabled: boolean,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = 'ri-btn';
    btn.style.cssText = 'font-size: 11px; padding: 2px 8px;';
    btn.title = title;
    if (!enabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    }
    btn.addEventListener('click', () => {
      if (enabled) onClick();
    });
    return btn;
  }

  // Per-satellite roster controls: Move (§14.6) and Repair (§14.12). Backend +
  // gateway + server intents already exist — this is the missing entry point.
  function renderSatActions(sat: Satellite): HTMLSpanElement {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display: flex; gap: 6px;';
    // §14.6: only a parked (locked) satellite that isn't moving or awaiting a
    // repair can be relocated — mirrors requestSatMove's gate.
    const canMove = sat.locked && !sat.movingTo && !sat.pendingRepairDroneId;
    const moveTitle = canMove
      ? 'Relocate this satellite — then click a map target'
      : sat.pendingRepairDroneId
        ? 'Repair in progress'
        : !sat.locked
          ? 'Satellite is not parked'
          : 'Cannot move right now';
    wrap.appendChild(
      rosterBtn('Move', canMove, moveTitle, () => {
        modal.hide();
        armMove(sat.id, sat.spaceportIslandId);
      }),
    );
    if (sat.pendingRepairDroneId) {
      const pending = document.createElement('span');
      pending.textContent = 'repairing…';
      pending.style.cssText = 'color: var(--ri-fg-2); font-size: 11px; align-self: center;';
      wrap.appendChild(pending);
    } else {
      wrap.appendChild(
        rosterBtn('Repair', true, 'Dispatch a repair drone from the owning Spaceport', () => {
          void (async () => {
            const res = await normalizeResult(
              deps.gateway
                ? deps.gateway.dispatchRepairDrone(sat.spaceportIslandId, sat.id, performance.now())
                : dispatchRepairDrone(deps.world, sat.spaceportIslandId, sat.id, performance.now()),
            );
            const toast = getToastHandle();
            if (res.ok) {
              const msg = `Repair drone dispatched to ${sat.id}`;
              flash(msg);
              toast?.show(msg, 'success');
            } else {
              const label = FAIL_REASON_LABEL[res.reason ?? ''] ?? res.reason ?? 'unknown';
              const msg = `Repair failed: ${label}`;
              flash(msg);
              toast?.show(msg, 'failure');
            }
            render();
          })();
        }),
      );
    }
    return wrap;
  }

  const renderRoster = (): HTMLDivElement => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px; font-family: ui-monospace, monospace; font-size: 12px; min-width: 320px;';
    const header = document.createElement('div');
    header.textContent = `ORBITAL TELEMETRY · ${deps.world.satellites.length} sats · ${deps.world.debrisFields.length} debris fields`;
    header.style.cssText = 'color: var(--ri-fg-2); letter-spacing: 0.08em;';
    wrap.appendChild(header);
    if (deps.world.satellites.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = 'no satellites on station';
      empty.style.color = 'var(--ri-fg-2)';
      wrap.appendChild(empty);
      return wrap;
    }
    const list = document.createElement('div');
    list.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr auto auto auto; gap: 4px 12px; align-items: center;';
    const cols = ['VARIANT', 'OWNER', 'FUEL', 'STATE', 'ACTIONS'];
    for (const c of cols) {
      const th = document.createElement('span');
      th.textContent = c;
      th.style.cssText = 'color: var(--ri-fg-2); font-size: 11px;';
      list.appendChild(th);
    }
    for (const sat of deps.world.satellites) {
      const owner = nameForIsland(deps.world, sat.spaceportIslandId);
      const cells = [
        sat.variant,
        owner,
        `${Math.round(sat.fuel)}`,
        sat.locked ? 'locked' : sat.movingTo ? 'in transit' : 'free',
      ];
      for (const c of cells) {
        const td = document.createElement('span');
        td.textContent = c;
        list.appendChild(td);
      }
      list.appendChild(renderSatActions(sat));
    }
    wrap.appendChild(list);
    return wrap;
  };

  function computeBodySig(): string {
    const spaceportIslands: IslandState[] = [];
    for (const s of deps.islandStates.values()) {
      if (hasOperationalBuilding(s.buildings, 'spaceport')) {
        spaceportIslands.push(s);
      }
    }
    let sig = `sp:${spaceportIslands.length}`;
    for (const s of spaceportIslands) {
      const sp = findOperationalBuilding(s.buildings, 'spaceport');
      const tier = sp?.tier ?? 1;
      const ascendant = s.ascendantCoreCrafted === true;
      sig += `;${s.id},t${tier},a${ascendant ? 1 : 0}`;
      for (const r of COMMON_RESOURCES) {
        sig += `,${r}:${inv(s, r)}`;
      }
      if (tier < 3) {
        const nextTier = tier + 1;
        const upgradeCost: Partial<Record<ResourceId, number>> = tier === 1
          ? { phase_converter: 5, memetic_core: 2, cryogenic_hydrogen: 50 }
          : { reality_anchor: 10, memetic_core: 5, antimatter_propellant: 100 };
        for (const [r, amt] of Object.entries(upgradeCost)) {
          sig += `,up${nextTier}_${r}:${inv(s, r as ResourceId)}/${amt ?? 0}`;
        }
      }
      for (const v of VARIANTS) {
        sig += `,${v.variant}:${inv(s, v.payload)}`;
      }
      // Name is free-text — placing it last prevents it from weakening
      // collision-resistance for the structured numeric fields before it.
      sig += `,n${nameForIsland(deps.world, s.id)}`;
    }
    sig += `;sats:${deps.world.satellites.length},debris:${deps.world.debrisFields.length}`;
    for (const sat of deps.world.satellites) {
      // Name is free-text — placed last so it doesn't weaken collision-resistance
      // for the structured fields (variant, id, fuel, status) before it.
      sig += `;${sat.variant},${sat.spaceportIslandId},${Math.round(sat.fuel)},${sat.locked ? 'L' : sat.movingTo ? 'M' : 'F'},n${nameForIsland(deps.world, sat.spaceportIslandId)}`;
    }
    sig += `;flash:${lastFlash && performance.now() < lastFlash.until ? lastFlash.msg : '-'}`;
    return sig;
  }

  const render = (): void => {
    lastBodySig = computeBodySig();
    if (!bodyEl) return;
    bodyEl.replaceChildren();
    const spaceportIslands: IslandState[] = [];
    for (const s of deps.islandStates.values()) {
      if (hasOperationalBuilding(s.buildings, 'spaceport')) {
        spaceportIslands.push(s);
      }
    }
    if (spaceportIslands.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: var(--ri-fg-2); font-family: ui-monospace, monospace; font-size: 12px; padding: 8px 4px;';
      empty.textContent = 'No Spaceport built. Construct one (T5 + Ascendant Core path) to unlock orbital launches.';
      bodyEl.appendChild(empty);
    } else {
      for (const s of spaceportIslands) {
        bodyEl.appendChild(renderIslandCard(s));
      }
    }
    bodyEl.appendChild(renderRoster());

    if (footerEl) {
      footerEl.replaceChildren();
      const spacer = document.createElement('div');
      spacer.classList.add('ri-modal__footer-spacer');
      footerEl.appendChild(spacer);
      if (lastFlash && performance.now() < lastFlash.until) {
        const msg = document.createElement('span');
        msg.textContent = lastFlash.msg;
        msg.style.cssText = 'color: var(--ri-accent); font-family: ui-monospace, monospace; font-size: 12px;';
        footerEl.appendChild(msg);
      }
    }
  };

  const modal: ModalHandle = mountModal(parentEl, {
    title: 'T6 Orbital Launch',
    subtitle: 'satellite dispatch',
    buildBody(body) {
      bodyEl = body;
      bodyEl.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 480px;
        max-width: 640px;
        padding: 4px;
      `;
      render();
    },
    buildFooter(footer) {
      footerEl = footer;
    },
    onClose() {
      handle.hide();
    },
  });

  // main.ts adds reticleLayer to the screen stack; the range ring is handed
  // back through a second property so `OrbitalUiHandle` stays narrow.
  const handle: OrbitalUiHandle & { rangeRingLayer: Container } = {
    show(): void {
      modal.show();
      render();
    },
    hide(): void {
      modal.hide();
      // Hiding the modal disarms a pending launch — the player's intent on
      // closing the modal is to back out of the orbital surface entirely.
      if (armed) setLaunchMode(false);
    },
    toggle(): boolean {
      const visible = modal.toggle();
      if (visible) render();
      else if (armed) setLaunchMode(false);
      return visible;
    },
    isVisible(): boolean {
      return modal.isVisible();
    },
    refresh(): void {
      if (modal.isVisible()) {
        const sig = computeBodySig();
        if (sig !== lastBodySig) render();
      }
      // Keep the range ring in sync — Spaceport upgrades / fuel-skill
      // changes can move the radius even while armed.
      if (armed) repaintRangeRing();
    },
    isLaunchMode(): boolean {
      return armed !== null;
    },
    setLaunchMode(on: boolean): void {
      // External callers (mutual-exclusion from sister panels) can only
      // *disarm* — arming requires picking an (islandId, variant) which is
      // a UI action, not a programmatic one.
      if (!on) setLaunchMode(false);
    },
    setReticleScreenPos,
    hideReticle: hideReticleFn,
    attemptLaunch,
    reticleLayer,
    rangeRingLayer,
  };
  return handle;
}
