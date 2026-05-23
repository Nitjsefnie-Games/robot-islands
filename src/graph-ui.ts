// Recipe-graph floating panel — render layer. Mounts via mountPanel into
// Zone.R (order 3) alongside Drones / Routes / Settlement. Panel shell,
// drag handle, resize grip, and localStorage persistence come from
// ui-zones.ts + window-manager.ts; this module owns the body content.

import { buildRecipeTableRows, type RecipeTableRow } from './recipe-graph.js';
import { mountPanel, Zone, type PanelHandle } from './ui-zones.js';

export interface GraphUi {
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

export function mountGraphUi(parentEl: HTMLElement): GraphUi {
  const rows = buildRecipeTableRows();

  // Group by category, preserving sort order within each group.
  const byCategory = new Map<string, RecipeTableRow[]>();
  for (const r of rows) {
    let bucket = byCategory.get(r.category);
    if (!bucket) {
      bucket = [];
      byCategory.set(r.category, bucket);
    }
    bucket.push(r);
  }
  const categories = [...byCategory.keys()].sort();

  // Container
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '12px';
  container.style.width = '100%';
  container.style.minWidth = '720px';
  container.style.overflow = 'auto';
  container.style.padding = '4px';

  // Search input
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search by building, resource, category…';
  search.style.padding = '8px 10px';
  search.style.background = '#101926';
  search.style.border = '1px solid #3a6680';
  search.style.color = '#e0e6ed';
  search.style.fontFamily = 'JetBrains Mono, monospace';
  search.style.fontSize = '12px';
  search.style.position = 'sticky';
  search.style.top = '0';
  search.style.zIndex = '1';
  container.appendChild(search);

  // Build sections. Track row matchers + section elements so filtering can
  // hide/show without rebuilding the DOM.
  interface SectionRef {
    readonly header: HTMLDivElement;
    readonly rowEls: ReadonlyArray<{ el: HTMLDivElement; haystack: string }>;
  }
  const sections: SectionRef[] = [];

  for (const category of categories) {
    const bucket = byCategory.get(category)!;

    const header = document.createElement('div');
    header.textContent = category.toUpperCase();
    header.style.color = '#7dd3e8';
    header.style.fontFamily = 'JetBrains Mono, monospace';
    header.style.fontSize = '11px';
    header.style.letterSpacing = '0.1em';
    header.style.marginTop = '8px';
    header.style.paddingBottom = '4px';
    header.style.borderBottom = '1px solid #243b52';
    container.appendChild(header);

    const rowEls: { el: HTMLDivElement; haystack: string }[] = [];
    for (const row of bucket) {
      const rowEl = document.createElement('div');
      rowEl.style.display = 'grid';
      rowEl.style.gridTemplateColumns = '260px 1fr 1fr 60px';
      rowEl.style.gap = '10px';
      rowEl.style.padding = '6px 4px';
      rowEl.style.borderBottom = '1px solid #1a2330';
      rowEl.style.fontFamily = 'JetBrains Mono, monospace';
      rowEl.style.fontSize = '11px';
      rowEl.style.color = '#cfe1f5';

      // Building cell: name + tier chip
      const bCell = document.createElement('div');
      bCell.style.display = 'flex';
      bCell.style.alignItems = 'center';
      bCell.style.gap = '8px';
      const name = document.createElement('span');
      name.textContent = row.buildingLabel;
      name.style.color = '#e0e6ed';
      const tier = document.createElement('span');
      tier.textContent = `T${row.tier}`;
      tier.style.padding = '1px 6px';
      tier.style.border = '1px solid #3a6680';
      tier.style.borderRadius = '3px';
      tier.style.fontSize = '10px';
      tier.style.color = '#7dd3e8';
      const recipeNote = document.createElement('span');
      recipeNote.textContent = row.recipeKey === row.buildingId ? '' : `(${row.recipeKey})`;
      recipeNote.style.color = '#5a7080';
      recipeNote.style.fontSize = '10px';
      bCell.appendChild(name);
      bCell.appendChild(tier);
      if (recipeNote.textContent) bCell.appendChild(recipeNote);

      const inCell = document.createElement('div');
      inCell.textContent = row.inputs.length
        ? row.inputs.map((e) => `${e.n} ${e.resource}`).join(', ')
        : '—';
      if (!row.inputs.length) inCell.style.color = '#5a7080';

      const outCell = document.createElement('div');
      outCell.textContent = row.outputs.length
        ? row.outputs.map((e) => `${e.n} ${e.resource}`).join(', ')
        : '—';
      if (!row.outputs.length) outCell.style.color = '#5a7080';

      const cycleCell = document.createElement('div');
      cycleCell.textContent = `${row.cycleSec}s`;
      cycleCell.style.color = '#9ab0c8';
      cycleCell.style.textAlign = 'right';

      rowEl.appendChild(bCell);
      rowEl.appendChild(inCell);
      rowEl.appendChild(outCell);
      rowEl.appendChild(cycleCell);
      container.appendChild(rowEl);

      const haystack = [
        row.buildingLabel,
        row.recipeKey,
        row.category,
        ...row.inputs.map((e) => e.resource),
        ...row.outputs.map((e) => e.resource),
      ]
        .join(' ')
        .toLowerCase();
      rowEls.push({ el: rowEl, haystack });
    }
    sections.push({ header, rowEls });
  }

  function applyFilter(): void {
    const q = search.value.trim().toLowerCase();
    for (const section of sections) {
      let visibleCount = 0;
      for (const { el, haystack } of section.rowEls) {
        const match = q === '' || haystack.includes(q);
        el.style.display = match ? 'grid' : 'none';
        if (match) visibleCount++;
      }
      section.header.style.display = visibleCount > 0 ? '' : 'none';
    }
  }
  search.addEventListener('input', applyFilter);

// Panel root. ri-panel gives us the backdrop / border / blur; the inline
// width/height seed the default footprint and are overridden by the
// localStorage layout (ri-ui-layout-v1) once the user drags or resizes.
const panel = document.createElement('div');
panel.id = 'recipe-graph-panel';
panel.classList.add('ri-panel');
panel.style.width = '720px';
panel.style.height = '520px';
panel.style.minHeight = '320px';
panel.style.display = 'flex';
panel.style.flexDirection = 'column';
panel.style.overflow = 'hidden';
panel.style.pointerEvents = 'auto';

// Header — .ri-panel__head doubles as the drag handle (window-manager.ts
// resolves the handle via that class).
const head = document.createElement('div');
head.classList.add('ri-panel__head');
const headTitle = document.createElement('span');
headTitle.classList.add('ri-panel__title');
headTitle.textContent = 'RECIPE GRAPH';
const headSub = document.createElement('span');
headSub.classList.add('ri-panel__sub');
headSub.textContent = '/ §6 + §7';
const closeBtn = document.createElement('button');
closeBtn.textContent = '×';
closeBtn.classList.add('ri-modal__close');
closeBtn.setAttribute('aria-label', 'Close recipe graph');
closeBtn.style.cssText =
  'background:transparent;border:0;color:var(--ri-fg-3);' +
  'font-size:16px;line-height:1;cursor:pointer;padding:0 4px;';
closeBtn.addEventListener('click', () => panelHandle.setVisible(false));
head.appendChild(headTitle);
head.appendChild(headSub);
head.appendChild(closeBtn);

// Body wraps the existing container (search + per-category sections).
// flex: 1 1 auto so it fills the panel and scrolls the inner container.
const body = document.createElement('div');
body.classList.add('ri-panel__body');
body.style.flex = '1 1 auto';
body.style.display = 'flex';
body.style.flexDirection = 'column';
body.style.minHeight = '0';
body.appendChild(container);

panel.appendChild(head);
panel.appendChild(body);
parentEl.appendChild(panel);

const panelHandle: PanelHandle = mountPanel(panel, {
  id: 'recipe-graph-panel',
  zone: Zone.R,
  order: 3,
  minWidth: 480,
});
// Same pattern as drones-ui:506 — hidden by default; toggle-graph reveals.
panelHandle.setVisible(false);

let visible = false;
return {
  show(): void {
    if (visible) return;
    visible = true;
    panelHandle.setVisible(true);
    setTimeout(() => search.focus(), 0);
  },
  hide(): void {
    if (!visible) return;
    visible = false;
    panelHandle.setVisible(false);
  },
  toggle(): boolean {
    if (visible) {
      visible = false;
      panelHandle.setVisible(false);
      return false;
    }
    visible = true;
    panelHandle.setVisible(true);
    setTimeout(() => search.focus(), 0);
    return true;
  },
  isVisible(): boolean {
    return visible;
  },
};
}
