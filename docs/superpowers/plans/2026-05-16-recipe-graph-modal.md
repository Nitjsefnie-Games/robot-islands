# Recipe Graph Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-game modal panel that visualises the full producer→consumer recipe DAG. Opens from the action-strip button column (icon + label + kbd `Y`), renders a single Mermaid `flowchart LR` of every building+resource, supports zoom/pan/hover tooltips.

**Architecture:** Pure data layer (`src/recipe-graph.ts`) generates a Mermaid source string from the static `RECIPES` + `BUILDING_DEFS` tables — fully unit-tested. Render layer (`src/graph-ui.ts`) lazy-imports `mermaid` + `svg-pan-zoom`, mounts the SVG into a `mountModal` shell, attaches hover tooltips. Wiring lives in `main.ts` + `input.ts` and follows the established `mountSkillTreeUi` pattern exactly.

**Tech Stack:** TypeScript strict, Vitest, Mermaid 11.x, svg-pan-zoom 3.x. No build-system changes — Vite already code-splits dynamic imports.

**Reference spec:** `docs/superpowers/specs/2026-05-16-recipe-graph-modal-design.md`

---

## File Structure

**Created:**
- `src/recipe-graph.ts` — pure: `buildRecipeGraphMermaid()` → string
- `src/recipe-graph.test.ts` — vitest spec, ~5 assertions
- `src/graph-ui.ts` — render: `mountGraphUi(parentEl) → GraphUi`

**Modified:**
- `src/ui-icons.ts` — add `'graph'` to `IconId` + a `PATHS` entry
- `src/input.ts` — bind `KeyY` to `'toggle-graph'`, register the action
- `src/main.ts` — import `mountGraphUi`, mount it, add action-strip button, define `toggle-graph` handler, add to `dismiss-modal`
- `package.json` + `package-lock.json` — `mermaid` and `svg-pan-zoom` deps

**Untouched:** `vite.config.ts`, `tsconfig.json`, recipe tables, building defs, the economy loop.

---

## Background context for the implementer

You haven't seen this codebase. Key conventions:

1. **`RecipeId = BuildingDefId | 'mine_on_ore' | 'mine_on_coal'`** (`src/recipes.ts:869`). For every recipe in `RECIPES`, the key is the owning building's id, except for the two mine variants (both owned by the `mine` building). Mapping for the graph: `recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal' → owner = 'mine'`, else `owner = recipeKey`.
2. **`RECIPES` is `Partial<Record<RecipeId, Recipe>>`** (`src/recipes.ts:910`). Iterate via `Object.entries(RECIPES)` and skip `undefined`.
3. **`Recipe` shape**: `{ cycleSec, inputs: Partial<Record<ResourceId, number>>, outputs: Partial<Record<ResourceId, number>>, category, ... }`. Inputs/outputs may be empty objects (e.g., raw-extraction recipes have `inputs: {}`; power burns have `outputs: {}`).
4. **`BUILDING_DEFS`** (`src/building-defs.ts:536`) keyed by `BuildingDefId`, each entry has `id`, `displayName`, `tier`, `category`, etc.
5. **Modal pattern** — `mountModal(parentEl, { title, onClose, buildBody })` from `src/ui-modal.ts`. Returns a handle with `show/hide/toggle/isVisible`. Look at `src/skilltree-ui.ts:450-453` for the canonical caller. Header chrome + close button + Escape routing through `dismiss-modal` is handled by the shell.
6. **Action / kbd wiring**:
   - `defineAction(reg, 'toggle-foo', handler)` from `src/input.ts:32`. Two-stage convention in `main.ts`: a no-op stub around line 270-280 (so `dismiss-modal` and other systems can refer to the action before the UI mounts), then the real handler near where the UI module is mounted.
   - `bind(reg, 'KeyY', 'toggle-graph')` goes in `defaultBindings()` in `src/input.ts:79+`.
7. **Action strip** is the `mountUi(reg, [...])` call at `src/main.ts:551`. The list order is the visual order. Place the new button **just before** `'grid'` (it's a data view, sits with the other data views).
8. **`KeyY` is currently free.** Existing kbds: B, I, J, R, V, C, K, G, H, S, T, W, A, D, plus arrows / +/- / Escape. Confirmed via `grep "^  bind(reg, 'Key" src/input.ts` before writing this plan.
9. **`dismiss-modal` handler** at `src/main.ts:1007` calls `.hide()` on every modal handle in sequence. Add `graphUi.hide()` to this list.
10. **CSS classes** the modal shell expects: `.ri-modal-scrim`, `.ri-modal`, `.ri-modal__body`, etc. — already defined in `src/ui.css`. The graph modal's body just needs `overflow: auto` and a fixed minimum height; everything else inherits from the shell.
11. **Test discipline**: pure layer is tested via vitest; render layer (DOM + lazy-loaded mermaid) is not unit-tested (matches the standing pattern — see `AGENTS.md` § "tests target the pure layer only").
12. **TypeScript strict** with `noUncheckedIndexedAccess` and `noUnusedLocals`. `RECIPES[id]` returns `Recipe | undefined`; null-check it. The helpers `inv()` / `cap()` in `economy.ts` show the indexed-access pattern.
13. **Commit trailer** — `Co-Authored-By: <Your Model Name> <noreply@anthropic.com>`. Mandatory on every commit, no exceptions. Per `~/.claude/CLAUDE.md`. Pre-commit check: scan composed message for the trailer literal before running `git commit`.
14. **No `--no-verify`, no `--amend`.** New commits, hooks run, every time.

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install mermaid and svg-pan-zoom**

```bash
cd /root/robot-islands && npm install mermaid@^11 svg-pan-zoom@^3.6
```

Expected: both packages added to `dependencies`, lockfile updated, no peer-dep warnings beyond mermaid's normal cytoscape/d3 transitive deps.

- [ ] **Step 2: Verify install**

```bash
cd /root/robot-islands && node -e "require.resolve('mermaid'); require.resolve('svg-pan-zoom'); console.log('ok')"
```

Expected stdout: `ok`. No exception.

- [ ] **Step 3: Verify nothing else broke**

```bash
cd /root/robot-islands && npx tsc -b --noEmit
```

Expected: clean (no new errors — the new deps aren't imported yet, so this is pure regression protection).

- [ ] **Step 4: Commit**

```bash
cd /root/robot-islands && git add package.json package-lock.json && git commit -m "$(cat <<'EOF'
deps: add mermaid + svg-pan-zoom for recipe-graph modal

Both lazy-imported in src/graph-ui.ts (next commit) so the initial
entry bundle stays unchanged — Vite code-splits dynamic imports.

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>
EOF
)"
```

Replace `<Your Model Name>` with your actual model identifier (e.g. `Claude Sonnet 4.6`) before running.

---

## Task 2: Add the 'graph' icon

**Files:**
- Modify: `src/ui-icons.ts`

- [ ] **Step 1: Add `'graph'` to the `IconId` union**

Open `src/ui-icons.ts`. The current union ends at line 32 with `| 'check';`. Insert `'graph'` just before `'check'`:

```ts
  | 'crosshair'     // Center on active
  | 'island'        // generic island marker
  | 'power'         // power / lightning
  | 'level'         // chevron-up (level)
  | 'alert'         // alert triangle
  | 'demolish'      // trash
  | 'expand'        // arrows-out
  | 'close'         // x
  | 'graph'         // recipe graph (node-and-edge)
  | 'check';
```

- [ ] **Step 2: Add the `'graph'` SVG path to `PATHS`**

In the same file, the `PATHS` record ends with the `check` entry around line 70. Add a `graph` entry just before it:

```ts
  graph:
    '<circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><line x1="7.8" y1="7.5" x2="10.5" y2="16.2" /><line x1="16.2" y1="7.5" x2="13.5" y2="16.2" /><line x1="8" y1="6" x2="16" y2="6" />',
  check:
    '<polyline points="4 12 10 18 20 6" />',
```

(Three circles in a triangle, connected by edges — reads as a small node-graph at 16-24px.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /root/robot-islands && npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /root/robot-islands && git add src/ui-icons.ts && git commit -m "$(cat <<'EOF'
feat(ui-icons): add 'graph' icon for recipe-graph modal

Three-node triangle glyph (24×24, stroke-only) matching the existing
icon style.

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure data layer — `recipe-graph.ts` (TDD)

**Files:**
- Create: `src/recipe-graph.ts`
- Create: `src/recipe-graph.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/recipe-graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import { RECIPES } from './recipes.js';
import { buildRecipeGraphMermaid } from './recipe-graph.js';

describe('buildRecipeGraphMermaid', () => {
  const src = buildRecipeGraphMermaid();
  const lines = src.split('\n');

  it('starts with the flowchart LR header', () => {
    expect(lines[0]).toBe('flowchart LR');
  });

  it('emits the iron_ore → iron_smelter → iron_ingot chain', () => {
    // smelter is the T1 iron_smelter building per recipes.ts:884-885.
    expect(src).toContain('res_iron_ore --> bld_smelter');
    expect(src).toContain('bld_smelter --> res_iron_ingot');
  });

  it('declares a node for every building that owns a recipe', () => {
    const ownersWithRecipes = new Set<string>();
    for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      // mine_on_ore / mine_on_coal both owned by the mine building.
      const owner =
        recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal'
          ? 'mine'
          : recipeKey;
      ownersWithRecipes.add(owner);
    }
    for (const owner of ownersWithRecipes) {
      // Each building node line looks like `bld_smelter(["Smelter"]):::tier1`.
      // We check for the prefix only; label + class are validated separately.
      const re = new RegExp(`^bld_${owner}\\(`, 'm');
      expect(src).toMatch(re);
    }
  });

  it('declares a node for every resource referenced by any recipe', () => {
    const resourcesSeen = new Set<string>();
    for (const recipe of Object.values(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.inputs)) resourcesSeen.add(r);
      for (const r of Object.keys(recipe.outputs)) resourcesSeen.add(r);
    }
    for (const r of resourcesSeen) {
      const re = new RegExp(`^res_${r}\\(\\(`, 'm');
      expect(src).toMatch(re);
    }
  });

  it('emits at least one edge for every recipe with non-empty inputs OR outputs', () => {
    for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      const inCount = Object.keys(recipe.inputs).length;
      const outCount = Object.keys(recipe.outputs).length;
      if (inCount === 0 && outCount === 0) continue; // pure no-op recipes
      const owner =
        recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal'
          ? 'mine'
          : recipeKey;
      // At least one edge touches the owner.
      const re = new RegExp(`(--> bld_${owner}\\b)|(\\bbld_${owner} -->)`);
      expect(src, `recipe "${recipeKey}" produced no edges`).toMatch(re);
    }
  });

  it('uses each building tier as a CSS class on the node line', () => {
    // Pick a couple of buildings with known tiers and confirm the class shows up.
    // mine = tier 1, deep_mine = tier 2.
    // BUILDING_DEFS is typed as Readonly<Record<BuildingDefId, BuildingDef>>;
    // under noUncheckedIndexedAccess these accesses are T | undefined, so
    // null-coalesce with sentinel tiers (-1) that won't match the regex.
    const mineTier = BUILDING_DEFS.mine?.tier ?? -1;
    const deepTier = BUILDING_DEFS.deep_mine?.tier ?? -1;
    expect(src).toMatch(new RegExp(`^bld_mine\\(.*\\):::tier${mineTier}`, 'm'));
    expect(src).toMatch(new RegExp(`^bld_deep_mine\\(.*\\):::tier${deepTier}`, 'm'));
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd /root/robot-islands && npx vitest run src/recipe-graph.test.ts
```

Expected: 6 failures, all with "Cannot find module './recipe-graph.js'" (or similar import error).

- [ ] **Step 3: Create the implementation `src/recipe-graph.ts`**

```ts
// Pure data layer for the §15 recipe-graph modal. Generates a Mermaid
// `flowchart LR` source string from the static RECIPES + BUILDING_DEFS
// tables. No DOM. No PixiJS. Safe to memoise at module scope.
//
// Node naming:
//   - Buildings:  `bld_<buildingDefId>(["<label>"]):::tier<N>`
//   - Resources:  `res_<resourceId>(("<label>"))`
//
// Edges per recipe owned by building B:
//   - For each input resource r:  `res_<r> --> bld_<B>`
//   - For each output resource r: `bld_<B> --> res_<r>`
//
// Owner resolution: RecipeId is BuildingDefId | 'mine_on_ore' | 'mine_on_coal'
// (recipes.ts:869). The two `mine_on_*` keys both belong to the `mine`
// building; everything else maps id→id.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { RECIPES, type ResourceId } from './recipes.js';

const TIER_PALETTE: Record<number, { fill: string; stroke: string }> = {
  0: { fill: '#1f2933', stroke: '#3a4856' },
  1: { fill: '#243b1f', stroke: '#4a7035' },
  2: { fill: '#1f3340', stroke: '#3a6680' },
  3: { fill: '#3a2f1f', stroke: '#806035' },
  4: { fill: '#3a1f3a', stroke: '#803580' },
  5: { fill: '#3a1f1f', stroke: '#803535' },
  6: { fill: '#1f3a3a', stroke: '#358080' },
};

function ownerOf(recipeKey: string): BuildingDefId {
  if (recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal') {
    return 'mine';
  }
  return recipeKey as BuildingDefId;
}

function resourceLabel(id: ResourceId): string {
  // Title-case the snake_case id for display.
  return id
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

let cached: string | null = null;

export function buildRecipeGraphMermaid(): string {
  if (cached !== null) return cached;

  const lines: string[] = ['flowchart LR'];

  // classDef block — one per tier in TIER_PALETTE.
  for (const [tier, c] of Object.entries(TIER_PALETTE)) {
    lines.push(
      `classDef tier${tier} fill:${c.fill},stroke:${c.stroke},color:#e0e6ed,stroke-width:1px`,
    );
  }
  // Resource nodes have their own class for visual distinction.
  lines.push('classDef resource fill:#0e1726,stroke:#3a6680,color:#cfe1f5,stroke-width:1px');

  const buildingsNeeded = new Set<BuildingDefId>();
  const resourcesNeeded = new Set<ResourceId>();
  const edges: string[] = [];

  for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
    if (!recipe) continue;
    const owner = ownerOf(recipeKey);
    buildingsNeeded.add(owner);

    for (const r of Object.keys(recipe.inputs) as ResourceId[]) {
      resourcesNeeded.add(r);
      edges.push(`res_${r} --> bld_${owner}`);
    }
    for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
      resourcesNeeded.add(r);
      edges.push(`bld_${owner} --> res_${r}`);
    }
  }

  // Building node declarations (sorted for stable diffs).
  for (const id of [...buildingsNeeded].sort()) {
    const def = BUILDING_DEFS[id];
    const label = def?.displayName ?? id;
    const tier = def?.tier ?? 0;
    lines.push(`bld_${id}(["${label}"]):::tier${tier}`);
  }

  // Resource node declarations (sorted for stable diffs).
  for (const id of [...resourcesNeeded].sort()) {
    lines.push(`res_${id}(("${resourceLabel(id)}")):::resource`);
  }

  // De-duplicate edges (a resource appearing in both inputs and outputs of
  // related recipes would otherwise emit the same line twice).
  for (const edge of [...new Set(edges)]) {
    lines.push(edge);
  }

  cached = lines.join('\n');
  return cached;
}

// Test-only escape hatch — vitest reuses the module between tests in the
// same file, so the module-scoped cache would freeze the output. Reset
// between describes if a test ever needs to mutate inputs (none currently).
export function _resetRecipeGraphCache(): void {
  cached = null;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /root/robot-islands && npx vitest run src/recipe-graph.test.ts
```

Expected: all 6 pass. If the "every resource is declared" test fails because of a resource id only appearing as a co-product / consumed-but-not-produced, that's a real catalog issue worth surfacing — but the test as written only requires resources that ARE referenced in RECIPES to have a node, which is necessarily true by construction. If it fails for another reason, debug before continuing.

The `:::resource` class application uses Mermaid's inline class syntax (triple colon, identical to the `:::tierN` form on the building lines). If a future Mermaid version rejects inline class assignment on stadium nodes, fall back to a single `class res_a,res_b,… resource` statement at the end of the source string. (The pure test doesn't validate Mermaid's parser — that's caught in Task 6 manual verification.)

- [ ] **Step 5: Run the full test suite for regression**

```bash
cd /root/robot-islands && npm test
```

Expected: all previously passing tests still pass; only `recipe-graph.test.ts` is new and adds 6 passing assertions.

- [ ] **Step 6: Commit**

```bash
cd /root/robot-islands && git add src/recipe-graph.ts src/recipe-graph.test.ts && git commit -m "$(cat <<'EOF'
feat(recipe-graph): pure Mermaid source generator

Generates a `flowchart LR` source from RECIPES + BUILDING_DEFS:
- buildings as rounded-rectangle nodes (bld_<id>) with tier classes
- resources as stadium nodes (res_<id>)
- edges for every input/output pair on every recipe
- `mine_on_ore` and `mine_on_coal` recipes both attribute to the
  `mine` building.

Vitest covers six structural invariants (header, known chain, every
building/resource declared, every recipe contributes edges, tier
classes applied).

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Render layer — `graph-ui.ts`

**Files:**
- Create: `src/graph-ui.ts`

This is DOM + lazy-loaded mermaid; not unit-tested per the standing pattern. Verified manually in Task 5.

- [ ] **Step 1: Create `src/graph-ui.ts`**

```ts
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
```

- [ ] **Step 2: Add the svg-pan-zoom type declaration**

`svg-pan-zoom` ships with bundled `.d.ts`, but if TypeScript strict can't resolve it, create `src/svg-pan-zoom.d.ts`:

```ts
declare module 'svg-pan-zoom' {
  type SvgPanZoomInstance = {
    destroy: () => void;
    resize: () => void;
    fit: () => void;
    center: () => void;
  };
  function svgPanZoom(svg: SVGElement | string, opts?: object): SvgPanZoomInstance;
  export default svgPanZoom;
}
```

Only commit this file if `npx tsc -b --noEmit` complains about the import. If the bundled types resolve fine, skip this step.

- [ ] **Step 3: Type-check**

```bash
cd /root/robot-islands && npx tsc -b --noEmit
```

Expected: clean. If errors appear in `graph-ui.ts`, address them; common culprits are:
- `panZoomMod.default` typing — the cast in the implementation handles this; if it still complains, narrow to `(panZoomMod as any).default` as a last resort (note: project has noUnusedLocals but no `no-explicit-any` rule).
- `mermaid.render` return shape changed across versions — for mermaid 11+ it returns `{ svg, bindFunctions? }`. Adjust the destructure if the local mermaid version disagrees.

- [ ] **Step 4: Run the full test suite**

```bash
cd /root/robot-islands && npm test
```

Expected: still all green. graph-ui has no tests, so nothing new fails; nothing else regresses.

- [ ] **Step 5: Commit**

```bash
cd /root/robot-islands && git add src/graph-ui.ts && [ -f src/svg-pan-zoom.d.ts ] && git add src/svg-pan-zoom.d.ts ; git commit -m "$(cat <<'EOF'
feat(graph-ui): mermaid-rendered recipe-graph modal

mountGraphUi(parentEl) returns a show/hide/toggle handle that follows
the skilltree-ui mounting pattern. First show() lazy-imports mermaid +
svg-pan-zoom, renders the SVG, installs pan/zoom + hover tooltips.
Subsequent shows reuse the cached SVG.

Hover tooltips for building nodes display tier, category, and every
recipe owned by that building (inputs, outputs, cycleSec). For resource
nodes they show the producer/consumer building lists.

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire into `input.ts` and `main.ts`

**Files:**
- Modify: `src/input.ts:79-127` area (default bindings)
- Modify: `src/main.ts:270-280` area (no-op stub for `toggle-graph`)
- Modify: `src/main.ts:551` area (action-strip button list)
- Modify: `src/main.ts:730-735` area (mount + real handler)
- Modify: `src/main.ts:1007-1025` area (`dismiss-modal` handler)

- [ ] **Step 1: Bind `KeyY` to `toggle-graph` in default bindings**

In `src/input.ts`, inside `defaultBindings()`, add a line near the other `toggle-*` binds (right after `KeyK` at line 88 is a natural spot since both are data views):

```ts
  bind(reg, 'KeyK', 'toggle-skill-tree');
  bind(reg, 'KeyY', 'toggle-graph');
```

- [ ] **Step 2: Add the no-op stub action in `main.ts`**

Around line 270-280 there's a block of `defineAction(reg, '<name>', () => undefined)` stubs. Add `toggle-graph` there (alphabetical placement is fine — between `toggle-construction` and `toggle-drones`):

```ts
  defineAction(reg, 'toggle-drones', () => undefined);
  defineAction(reg, 'toggle-graph', () => undefined);
  defineAction(reg, 'toggle-routes', () => undefined);
```

- [ ] **Step 3: Add the button to the action strip**

In `src/main.ts` around line 551 the `mountUi(reg, [...])` array has the visible buttons. Insert the graph button **just before** `'grid'`:

```ts
  mountUi(reg, [
    { icon: 'building',  action: 'toggle-buildings',    label: 'Buildings',   kbd: 'B' },
    { icon: 'inventory', action: 'toggle-inventory',    label: 'Inventory',   kbd: 'I' },
    { icon: 'drone',     action: 'toggle-drones',       label: 'Drones',      kbd: 'J' },
    { icon: 'route',     action: 'toggle-routes',       label: 'Routes',      kbd: 'R' },
    { icon: 'settle',    action: 'toggle-settlement',   label: 'Settlement',  kbd: 'V' },
    { icon: 'construct', action: 'toggle-construction', label: 'Construct',   kbd: 'C' },
    { icon: 'skills',    action: 'toggle-skill-tree',   label: 'Skill Tree',  kbd: 'K' },
    { icon: 'graph',     action: 'toggle-graph',        label: 'Recipe Graph', kbd: 'Y' },
    { icon: 'grid',      action: 'toggle-grid',         label: 'Toggle Grid', kbd: 'G' },
    { icon: 'crosshair', action: 'center-home',         label: 'Center View', kbd: 'H' },
    { icon: 'settings',  action: 'toggle-settings',     label: 'Settings',    kbd: 'S' },
  ]);
```

(The exact button-list rendering is what was at `src/main.ts:551-562`; only the new `{ icon: 'graph', ... }` line is new.)

- [ ] **Step 4: Import and mount `mountGraphUi` in `main.ts`**

Near the top of the file, the imports already include modal mount functions. Add:

```ts
import { mountGraphUi } from './graph-ui.js';
```

(Alphabetical placement is fine — between `./grid.js` and `./hud.js` or wherever the project's import ordering convention puts it. Most existing imports look sorted alphabetically by path.)

Then near the skill-tree mount around line 732, add the graph mount:

```ts
  const skillTree = mountSkillTreeUi(document.body, { getState: activeState });
  defineAction(reg, 'toggle-skill-tree', () => {
    skillTree.toggle();
  });

  const graphUi = mountGraphUi(document.body);
  defineAction(reg, 'toggle-graph', () => {
    graphUi.toggle();
  });
```

- [ ] **Step 5: Add `graphUi.hide()` to the `dismiss-modal` handler**

In `src/main.ts:1007-1025`, the `dismiss-modal` action body lists every modal handle. Add `graphUi.hide()`:

```ts
  defineAction(reg, 'dismiss-modal', () => {
    skillTree.hide();
    buildingsUi.hide();
    constructionUi.hide();
    inventoryUi.hide();
    settingsUi.hide();
    graphUi.hide();
    placementUi.cancel();
    if (inspector.isVisible()) {
      inspector.close();
      selectedSpec = null;
      repaintSelection();
    }
  });
```

- [ ] **Step 6: Type-check**

```bash
cd /root/robot-islands && npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 7: Run the full test suite**

```bash
cd /root/robot-islands && npm test
```

Expected: still all green. No file we touched in this task has tests, so nothing should change; this is regression protection.

- [ ] **Step 8: Commit**

```bash
cd /root/robot-islands && git add src/input.ts src/main.ts && git commit -m "$(cat <<'EOF'
feat(main): wire recipe-graph modal into action strip + dismiss-modal

- Bind KeyY to toggle-graph
- Add 'Recipe Graph' button to the action strip (between Skill Tree
  and Toggle Grid)
- Mount mountGraphUi alongside the other data-view modals
- Route Escape through dismiss-modal to hide the graph

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual verification in the live dev server

**Files:** (none modified)

The dev server (`robot-islands-dev.service` → `https://islands.nitjsefni.eu/`) auto-reloads on source edits via Vite HMR. The user has it open in a browser via the Daedalus Chrome extension.

- [ ] **Step 1: Confirm the page reloaded cleanly**

```bash
mcp__daedalus__url
```

Expected: the active tab URL is `https://islands.nitjsefni.eu/...`. If not, `mcp__daedalus__list_tabs` to find which tab is the game.

```bash
mcp__daedalus__errors_log
```

Expected: no new errors after the last commit's HMR cycle. If there's a console error referencing `graph-ui.ts`, `recipe-graph.ts`, `mermaid`, or `svg-pan-zoom`, fix it before continuing.

- [ ] **Step 2: Open the graph modal and screenshot**

```bash
mcp__daedalus__exec '(() => { document.querySelector("button[data-action=\"toggle-graph\"]")?.click(); })()'
```

Wait a few seconds for mermaid render, then:

```bash
mcp__daedalus__screenshot
```

Expected: modal visible with the Mermaid graph rendered. Pan/zoom controls visible in the corner of the SVG (svg-pan-zoom's built-in icons).

- [ ] **Step 3: Verify hover tooltips**

```bash
mcp__daedalus__exec '(() => { const n = document.querySelector("g.node"); if (!n) return "no node"; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 })); return "fired"; })()'
```

Then:

```bash
mcp__daedalus__screenshot
```

Expected: floating tooltip visible somewhere on the page with a building or resource summary. If the tooltip is empty / unstyled, the `mouseenter` binding isn't catching the right node — inspect via `mcp__daedalus__exec` to dump `document.querySelector('g.node').id` and check the regex in `graph-ui.ts`.

- [ ] **Step 4: Verify Escape closes the modal**

```bash
mcp__daedalus__exec 'document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }))'
mcp__daedalus__screenshot
```

Expected: modal closed, game canvas visible.

- [ ] **Step 5: Verify `KeyY` re-opens it (and the cached SVG reuses)**

```bash
mcp__daedalus__exec 'document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyY", bubbles: true }))'
mcp__daedalus__screenshot
```

Expected: modal reopens **instantly** (no "Generating graph…" placeholder this time — the SVG is cached).

- [ ] **Step 6: If anything in steps 1-5 failed, fix and commit a follow-up**

Fixes that come from manual verification get their own commit, not an amend:

```bash
cd /root/robot-islands && git add <files> && git commit -m "$(cat <<'EOF'
fix(graph-ui): <one-line description of the manual-verification issue>

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>
EOF
)"
```

Then re-run the relevant verification step.

- [ ] **Step 7: Done — report back**

When all manual checks pass, summarise to the user:
- Number of commits added on `master`
- Final test count (`npm test` output line "Tests N passed")
- Whether the layout-explosion fallback was needed (`flowchart LR` → `TD` or category subgraphs). Note the spec's risk #1 about Mermaid layout density.

---

## Out-of-band notes

- **If `npm install` modifies anything beyond `package.json` + `package-lock.json`** (e.g., creates a `.npmrc`, modifies `node_modules` in a tracked way), DO NOT commit those changes — investigate why.
- **If the Mermaid graph is genuinely unreadable** at full scale, the spec's risk #1 covers the fallback: switch `'flowchart LR'` to `'flowchart TD'` at the top of `buildRecipeGraphMermaid()` in `src/recipe-graph.ts`, or wrap recipes by `recipe.category` in `subgraph chemistry … end` blocks (Mermaid's subgraph syntax). Either fix is a single-commit follow-up, not part of this initial plan.
- **Action button data attribute**: Step 2 of Task 6 uses `data-action="toggle-graph"`. Confirm `src/ui.ts` actually sets this attribute on the button DOM elements before running that exec (`grep -n "data-action\|setAttribute" src/ui.ts`). If it uses a different attribute, adjust the exec; the rest of the verification doesn't depend on this.
