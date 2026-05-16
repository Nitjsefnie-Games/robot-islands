// Recipe-graph modal — render layer. Lazy-imports mermaid + svg-pan-zoom
// on first open so the initial entry bundle stays unchanged. Caches the
// rendered SVG node after the first render; subsequent opens reuse it.
//
// Pattern mirrors `mountSkillTreeUi` (skilltree-ui.ts:71) — exports a
// mount function that registers the modal shell up-front, returns a
// handle with show/hide/toggle/isVisible. The actual mermaid render
// runs the first time `show()` is called.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { buildRecipeGraphMermaid } from './recipe-graph.js';
import { RECIPES, type ResourceId } from './recipes.js';
import { mountModal, type ModalHandle } from './ui-modal.js';

export interface GraphUi {
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

interface TooltipModel {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}

export function mountGraphUi(parentEl: HTMLElement): GraphUi {
  let rendered = false;
  let renderingPromise: Promise<void> | null = null;
  let cachedSvg: SVGElement | null = null;

  const container = document.createElement('div');
  container.style.position = 'relative';
  container.style.width = '100%';
  container.style.height = '70vh';
  container.style.minHeight = '420px';
  container.style.overflow = 'auto';
  container.style.background = '#0a0e14';

  const placeholder = document.createElement('div');
  placeholder.textContent = 'Generating graph…';
  placeholder.style.color = '#cfe1f5';
  placeholder.style.padding = '24px';
  placeholder.style.fontFamily = 'JetBrains Mono, monospace';
  placeholder.style.fontSize = '12px';
  container.appendChild(placeholder);

  // Floating tooltip — single element, repositioned on mousemove.
  const tooltip = document.createElement('div');
  tooltip.style.position = 'fixed';
  tooltip.style.display = 'none';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.background = '#101926';
  tooltip.style.border = '1px solid #3a6680';
  tooltip.style.color = '#e0e6ed';
  tooltip.style.padding = '8px 10px';
  tooltip.style.fontFamily = 'JetBrains Mono, monospace';
  tooltip.style.fontSize = '11px';
  tooltip.style.lineHeight = '1.4';
  tooltip.style.maxWidth = '320px';
  tooltip.style.zIndex = '10000';
  tooltip.style.whiteSpace = 'pre-wrap';
  document.body.appendChild(tooltip);

  function tooltipForBuilding(id: BuildingDefId): TooltipModel | null {
    const def = BUILDING_DEFS[id];
    if (!def) return null;
    const lines: string[] = [`Tier ${def.tier}  ·  ${def.category}`];
    // Find ALL recipes belonging to this building (including mine variants).
    for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      const owner =
        recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal'
          ? 'mine'
          : recipeKey;
      if (owner !== id) continue;
      lines.push(`— recipe ${recipeKey} (cycle ${recipe.cycleSec}s)`);
      const ins = Object.entries(recipe.inputs)
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      const outs = Object.entries(recipe.outputs)
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      if (ins) lines.push(`   in : ${ins}`);
      if (outs) lines.push(`   out: ${outs}`);
    }
    return { title: def.displayName, lines };
  }

  function tooltipForResource(id: ResourceId): TooltipModel {
    const producers: string[] = [];
    const consumers: string[] = [];
    for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      const owner =
        recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal'
          ? 'mine'
          : recipeKey;
      const def = BUILDING_DEFS[owner as BuildingDefId];
      const label = def?.displayName ?? owner;
      if (id in recipe.outputs) producers.push(label);
      if (id in recipe.inputs) consumers.push(label);
    }
    return {
      title: id,
      lines: [
        `Producers (${producers.length}): ${producers.join(', ') || '—'}`,
        `Consumers (${consumers.length}): ${consumers.join(', ') || '—'}`,
      ],
    };
  }

  function showTooltip(model: TooltipModel, x: number, y: number): void {
    tooltip.innerHTML = '';
    const t = document.createElement('div');
    t.textContent = model.title;
    t.style.fontWeight = '600';
    t.style.color = '#7dd3e8';
    t.style.marginBottom = '4px';
    tooltip.appendChild(t);
    for (const line of model.lines) {
      const l = document.createElement('div');
      l.textContent = line;
      tooltip.appendChild(l);
    }
    tooltip.style.left = `${x + 14}px`;
    tooltip.style.top = `${y + 14}px`;
    tooltip.style.display = 'block';
  }

  function hideTooltip(): void {
    tooltip.style.display = 'none';
  }

  async function renderOnce(): Promise<void> {
    if (rendered) return;
    if (renderingPromise) return renderingPromise;
    renderingPromise = (async (): Promise<void> => {
      try {
        const [{ default: mermaid }, panZoomMod] = await Promise.all([
          import('mermaid'),
          import('svg-pan-zoom'),
        ]);
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
        const source = buildRecipeGraphMermaid();
        const { svg: svgText } = await mermaid.render('recipe-graph-svg', source);

        const wrap = document.createElement('div');
        wrap.innerHTML = svgText;
        const svg = wrap.querySelector('svg');
        if (!svg) throw new Error('mermaid render produced no <svg>');
        svg.style.width = '100%';
        svg.style.height = '100%';

        container.removeChild(placeholder);
        container.appendChild(svg);
        cachedSvg = svg as unknown as SVGElement;

        // Pan-zoom — svg-pan-zoom default export.
        const svgPanZoom = (panZoomMod as { default: (svg: SVGElement, opts?: object) => unknown }).default;
        svgPanZoom(cachedSvg, {
          zoomEnabled: true,
          controlIconsEnabled: true,
          fit: true,
          center: true,
          minZoom: 0.1,
          maxZoom: 10,
        });

        // Hover tooltips on every .node.
        const nodes = svg.querySelectorAll('g.node');
        nodes.forEach((node) => {
          const el = node as SVGGElement;
          // Mermaid encodes the node id in the `id` attribute as
          // `flowchart-bld_<...>-<n>` or similar; we look for the
          // `bld_` / `res_` prefix in the contained text.
          const idAttr = el.id || '';
          const m = idAttr.match(/(bld_[a-z0-9_]+)|(res_[a-z0-9_]+)/);
          if (!m) return;
          const matched = m[0];
          el.style.cursor = 'help';
          el.addEventListener('mouseenter', (ev) => {
            const me = ev as MouseEvent;
            let model: TooltipModel | null = null;
            if (matched.startsWith('bld_')) {
              model = tooltipForBuilding(matched.slice(4) as BuildingDefId);
            } else {
              model = tooltipForResource(matched.slice(4) as ResourceId);
            }
            if (model) showTooltip(model, me.clientX, me.clientY);
          });
          el.addEventListener('mousemove', (ev) => {
            const me = ev as MouseEvent;
            tooltip.style.left = `${me.clientX + 14}px`;
            tooltip.style.top = `${me.clientY + 14}px`;
          });
          el.addEventListener('mouseleave', () => hideTooltip());
        });

        rendered = true;
      } catch (err) {
        // Surface the error inside the modal body instead of failing silently.
        container.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.style.color = '#ff8080';
        errDiv.style.padding = '24px';
        errDiv.style.fontFamily = 'JetBrains Mono, monospace';
        errDiv.style.fontSize = '12px';
        errDiv.textContent = `Failed to render recipe graph: ${
          err instanceof Error ? err.message : String(err)
        }`;
        container.appendChild(errDiv);
      } finally {
        renderingPromise = null;
      }
    })();
    return renderingPromise;
  }

  const handle: ModalHandle = mountModal(parentEl, {
    title: 'RECIPE GRAPH',
    subtitle: '/ §6 + §7',
    onClose: () => handle.hide(),
    buildBody(body) {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.appendChild(container);
    },
  });

  return {
    show(): void {
      handle.show();
      void renderOnce();
    },
    hide(): void {
      handle.hide();
      hideTooltip();
    },
    toggle(): boolean {
      if (handle.isVisible()) {
        handle.hide();
        hideTooltip();
        return false;
      }
      handle.show();
      void renderOnce();
      return true;
    },
    isVisible(): boolean {
      return handle.isVisible();
    },
  };
}
