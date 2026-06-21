// Mass-building inspector — side dock shown when two or more buildings are
// selected. Sister to inspector-ui: same panel chrome (`ri-panel`), same
// industrial-readout colours, but the body is a batch-action summary rather
// than per-building detail.
//
// Pure DOM: no PixiJS imports. The panel only reads the target and dispatches
// callbacks supplied by the caller (main.ts / Task 5).

import { BUILDING_DEFS } from './building-defs.js';
import { selectionBreakdown, ignoreCapUnion } from './mass-actions.js';
import { mountPanel, Zone } from './ui-zones.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';
import type { ResourceId } from './recipes.js';

export interface MultiTarget {
  spec: IslandSpec;
  state: IslandState;
  buildings: PlacedBuilding[];
}

export interface InspectorMultiDeps {
  onDestroy(t: MultiTarget): void;
  onUpgrade(t: MultiTarget): void;
  onEnable(t: MultiTarget): void;
  onDisable(t: MultiTarget): void;
  onMove(t: MultiTarget): void;
  onSetIgnoreCap(t: MultiTarget, resource: ResourceId, value: boolean): void;
  upgradeFitCount(t: MultiTarget): number;
}

export interface InspectorMultiHandle {
  el: HTMLDivElement;
  open(t: MultiTarget): void;
  close(): void;
  isVisible(): boolean;
}

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

function makeButton(label: string, variant: 'warn' | 'accent'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.classList.add(variant === 'warn' ? 'ri-warnbtn' : 'ri-accentbtn');
  return btn;
}

export function mountInspectorMulti(parent: HTMLElement, deps: InspectorMultiDeps): InspectorMultiHandle {
  let target: MultiTarget | null = null;

  // ── Panel shell ───────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'inspector-multi-panel';
  panel.classList.add('ri-panel');
  panel.dataset.screenLabel = 'Multi-Inspect';
  styled(
    panel,
    [
      'width: 268px',
      'max-height: calc(100vh - 248px)',
      'font-family: ui-monospace, monospace',
      'font-size: 12px',
      'line-height: 1.45',
      'font-variant-numeric: tabular-nums',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
      'pointer-events: auto',
    ].join(';'),
  );

  // Header — count + breakdown
  const header = document.createElement('div');
  styled(
    header,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 4px',
      'padding: 9px 12px 8px',
      `border-bottom: 1px solid ${'var(--ri-border-strong)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
    ].join(';'),
  );
  const headTitleRow = document.createElement('div');
  styled(headTitleRow, 'display: flex; align-items: baseline; justify-content: space-between; gap: 8px');
  const headTitle = document.createElement('span');
  styled(
    headTitle,
    [
      `color: ${'var(--ri-accent)'}`,
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
      'text-transform: uppercase',
    ].join(';'),
  );
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.classList.add('ri-modal__close');
  styled(
    closeBtn,
    [
      'width: 18px',
      'height: 18px',
      'line-height: 0',
      'border-radius: 2px',
      'font-size: 14px',
    ].join(';'),
  );
  closeBtn.addEventListener('click', () => {
    handle.close();
  });
  headTitleRow.appendChild(headTitle);
  headTitleRow.appendChild(closeBtn);

  const breakdownEl = document.createElement('div');
  styled(
    breakdownEl,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  header.appendChild(headTitleRow);
  header.appendChild(breakdownEl);

  // Body — buttons + ignore-cap list
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 10px',
      'padding: 10px 12px',
      'overflow-y: auto',
      'flex: 1 1 auto',
    ].join(';'),
  );

  const buttonRow = document.createElement('div');
  styled(
    buttonRow,
    ['display: flex', 'flex-wrap: wrap', 'gap: 6px'].join(';'),
  );

  const destroyBtn = makeButton('Destroy', 'warn');
  destroyBtn.addEventListener('click', () => {
    if (target) deps.onDestroy(target);
  });

  const upgradeBtn = makeButton('Upgrade (0 fit)', 'accent');
  upgradeBtn.addEventListener('click', () => {
    if (target) deps.onUpgrade(target);
  });

  const moveBtn = makeButton('Move', 'accent');
  moveBtn.addEventListener('click', () => {
    if (target) deps.onMove(target);
  });

  const enableBtn = makeButton('Enable', 'accent');
  enableBtn.addEventListener('click', () => {
    if (target) deps.onEnable(target);
  });

  const disableBtn = makeButton('Disable', 'accent');
  disableBtn.addEventListener('click', () => {
    if (target) deps.onDisable(target);
  });

  buttonRow.appendChild(destroyBtn);
  buttonRow.appendChild(upgradeBtn);
  buttonRow.appendChild(moveBtn);
  buttonRow.appendChild(enableBtn);
  buttonRow.appendChild(disableBtn);
  body.appendChild(buttonRow);

  // Ignore-cap section
  const ignoreCapSection = document.createElement('div');
  styled(ignoreCapSection, 'display: flex; flex-direction: column; gap: 6px');
  const ignoreCapHeader = document.createElement('span');
  ignoreCapHeader.textContent = 'IGNORE CAP';
  styled(
    ignoreCapHeader,
    [
      `color: ${'var(--ri-fg-3)'}`,
      'font-size: 9.5px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
    ].join(';'),
  );
  ignoreCapSection.appendChild(ignoreCapHeader);
  const ignoreCapList = document.createElement('div');
  styled(ignoreCapList, 'display: flex; flex-direction: column; gap: 4px');
  ignoreCapSection.appendChild(ignoreCapList);
  body.appendChild(ignoreCapSection);

  panel.appendChild(header);
  panel.appendChild(body);
  parent.appendChild(panel);

  const panelHandle = mountPanel(panel, {
    id: 'inspector-multi-panel',
    zone: Zone.L,
    order: 1,
  });
  panelHandle.setVisible(false);

  function paint(): void {
    const t = target;
    if (!t) return;

    const n = t.buildings.length;
    headTitle.textContent = `${n} building${n === 1 ? '' : 's'}`;

    const breakdown = selectionBreakdown(t.buildings);
    breakdownEl.textContent = breakdown
      .map(({ defId, count }) => {
        const name = BUILDING_DEFS[defId as keyof typeof BUILDING_DEFS]?.displayName ?? defId;
        return `${count}× ${name}`;
      })
      .join(', ');

    const fit = deps.upgradeFitCount(t);
    upgradeBtn.textContent = `Upgrade (${fit} fit)`;
    upgradeBtn.disabled = fit === 0;

    // Repaint ignore-cap rows
    ignoreCapList.innerHTML = '';
    const rows = ignoreCapUnion(t.buildings.map((building) => ({ spec: t.spec, building })));
    for (const row of rows) {
      const rowEl = document.createElement('label');
      styled(
        rowEl,
        [
          'display: flex',
          'align-items: center',
          'gap: 6px',
          `color: ${'var(--ri-fg-2)'}`,
          'font-size: 11px',
          'cursor: pointer',
        ].join(';'),
      );
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = row.allSet;
      checkbox.addEventListener('change', () => {
        deps.onSetIgnoreCap(t, row.resource, checkbox.checked);
      });
      const label = document.createElement('span');
      label.textContent = row.resource;
      rowEl.appendChild(checkbox);
      rowEl.appendChild(label);
      ignoreCapList.appendChild(rowEl);
    }
  }

  const handle: InspectorMultiHandle = {
    el: panel,
    open(t: MultiTarget) {
      target = t;
      paint();
      panelHandle.setVisible(true);
    },
    close() {
      panelHandle.setVisible(false);
    },
    isVisible() {
      return panel.style.display !== 'none';
    },
  };

  return handle;
}
