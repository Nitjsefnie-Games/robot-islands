// §14 T6 Orbital launch modal.
//
// The orbital tick (movement, scanner discovery, debris, comms, repair) was
// fully wired into main.ts but the player had no surface to actually launch
// a satellite — `launchSatellite()` was reachable only from test code. This
// module is that surface.
//
// Body per populated island with a Spaceport:
//   - Header: island name + Spaceport tier + Ascendant-Core gate indicator
//   - Inventory readout for the five launch consumables
//   - Three "Launch …" buttons (scanner / comm / sweeper), disabled when
//     materials or gate aren't satisfied
// Footer:
//   - Active-satellite roster (variant / owner / fuel / locked-vs-free)
//
// Pure DOM, no PixiJS. Uses the shared ri-modal shell + the existing
// `.ri-*` class palette (no inline-styled chrome competing with other modals).

import type { IslandState } from './economy.js';
import { launchSatellite, type SatelliteVariant } from './orbital.js';
import type { ResourceId } from './recipes.js';
import { mountModal, type ModalHandle } from './ui-modal.js';
import type { WorldState } from './world.js';

export interface OrbitalUiHandle {
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
  /** Repaint the body — call when the modal is open so resource counts +
   *  satellite roster stay live. Cheap when hidden (early-return). */
  refresh(): void;
}

export interface OrbitalUiDeps {
  readonly world: WorldState;
  readonly islandStates: Map<string, IslandState>;
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
    variant: 'comm',
    label: 'Comm Sat',
    payload: 'comm_sat',
    summary: 'Relays buffered packets between distant Spaceports',
  },
  {
    variant: 'sweeper',
    label: 'Sweeper Sat',
    payload: 'sweeper_sat',
    summary: 'Removes debris fragments from its cell over time',
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
};

function inv(state: IslandState, id: ResourceId): number {
  return state.inventory[id] ?? 0;
}

function nameForIsland(world: WorldState, id: string): string {
  const spec = world.islands.find((i) => i.id === id);
  return spec?.name ?? id;
}

export function mountOrbitalUi(
  parentEl: HTMLElement,
  deps: OrbitalUiDeps,
): OrbitalUiHandle {
  let bodyEl: HTMLDivElement | null = null;
  let footerEl: HTMLDivElement | null = null;
  let lastFlash: { msg: string; until: number } | null = null;

  const flash = (msg: string): void => {
    lastFlash = { msg, until: performance.now() + 4000 };
    render();
  };

  const tryLaunch = (islandId: string, variant: SatelliteVariant): void => {
    const result = launchSatellite(
      deps.world,
      islandId,
      variant,
      performance.now(),
    );
    if (result.ok) {
      flash(`Launched ${variant} sat from ${nameForIsland(deps.world, islandId)}`);
    } else {
      const label = FAIL_REASON_LABEL[result.reason] ?? result.reason;
      flash(`Launch failed: ${label}`);
    }
  };

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

    const spaceport = state.buildings.find((b) => b.defId === 'spaceport');
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

    // Per-variant launch row.
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
      btn.textContent = 'Launch';
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
      const enabled = ascendant && hasMaterials;
      if (!enabled) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.style.cursor = 'not-allowed';
        btn.title = !ascendant
          ? 'Craft an Ascendant Core first'
          : 'Missing materials';
      }
      btn.addEventListener('click', () => {
        if (!enabled) return;
        tryLaunch(state.id, v.variant);
      });
      row.appendChild(btn);
      card.appendChild(row);
    }
    return card;
  };

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
    list.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 4px 12px;';
    const cols = ['VARIANT', 'OWNER', 'FUEL', 'STATE'];
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
        sat.locked ? 'locked' : 'free',
      ];
      for (const c of cells) {
        const td = document.createElement('span');
        td.textContent = c;
        list.appendChild(td);
      }
    }
    wrap.appendChild(list);
    return wrap;
  };

  const render = (): void => {
    if (!bodyEl) return;
    bodyEl.replaceChildren();
    const spaceportIslands: IslandState[] = [];
    for (const s of deps.islandStates.values()) {
      if (s.buildings.some((b) => b.defId === 'spaceport')) {
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
    subtitle: '§14.2-14.7 satellite dispatch',
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

  const handle: OrbitalUiHandle = {
    show(): void {
      modal.show();
      render();
    },
    hide(): void {
      modal.hide();
    },
    toggle(): boolean {
      const visible = modal.toggle();
      if (visible) render();
      return visible;
    },
    isVisible(): boolean {
      return modal.isVisible();
    },
    refresh(): void {
      if (!modal.isVisible()) return;
      render();
    },
  };
  return handle;
}
