# Recipe Graph Modal — Design

**Status:** approved 2026-05-16, ready for implementation plan.

## Goal

Add an in-game view that shows the full producer→consumer recipe chain
as an interactive Mermaid graph. Opened from the existing action-strip
button column. Originally requested as a `/graph` endpoint, but since
this is a pure client-side SPA with no routing, the implementation is
a modal panel.

## Scope

- Every recipe in `src/recipes.ts` (~173 entries) participates.
- Every building from `src/building-defs.ts` is a node.
- Every `ResourceId` mentioned by any recipe's inputs/outputs is a
  node.
- No filter UI (no tier toggles, no category chips). The whole graph
  renders at once; zoom + scroll + hover do the work of making it
  readable.

Explicitly out of scope:
- Unlocked-only or game-state-aware filtering. The graph is a static
  view of the recipe catalog, identical for every player.
- Interactivity beyond pan/zoom and node hover tooltips (no click-to-
  focus, no edit, no game commands from inside the graph).
- A real HTTP `/graph` route. The SPA stays single-page.

## Architecture

### New: `src/recipe-graph.ts` (pure layer, no DOM, no PixiJS)

Public surface:

```ts
export function buildRecipeGraphMermaid(): string;
```

Generates a Mermaid `flowchart LR` source string by iterating
`RECIPES` + `BUILDING_DEFS`. Node shapes and naming:

- **Building node:** `bld_<buildingDefId>(["<label>"]):::tier<N>`
  Rounded-rectangle. CSS class encodes the building's tier (so we can
  color-code by tier without per-node inline styles).
- **Resource node:** `res_<resourceId>(("<label>"))`
  Stadium/circle shape, visually distinct from buildings.

Edges per recipe:
- For each input `r` of a recipe owned by building `B`:
  `res_<r> --> bld_<B>`
- For each output `r` of that recipe:
  `bld_<B> --> res_<r>`

Header lines:
- `flowchart LR`
- `classDef tier0 …` through `tier6` for tier coloring. Palette
  resolution order during implementation: (a) reuse any existing
  tier color constants exported from the codebase if present; (b)
  otherwise hardcode a 7-step sequential palette inside
  `recipe-graph.ts` (the palette is part of the pure layer's output
  string, not styled from CSS, so the choice is permanent once made).

The function is pure — same inputs (the static `RECIPES` and
`BUILDING_DEFS` tables) always produce the same output string. Safe
to memoize at module level on first call.

### New: `src/recipe-graph.test.ts`

Vitest spec covering the pure layer. Required assertions:
1. Output contains `flowchart LR` header.
2. For a known chain (`iron_ore → iron_smelter → iron_ingot`), the
   output contains both `res_iron_ore --> bld_iron_smelter` and
   `bld_iron_smelter --> res_iron_ingot`.
3. Every recipe in `RECIPES` emits at least one input edge AND at
   least one output edge (sanity check that no recipe is silently
   dropped).
4. Every building referenced in an edge has a node declaration line.
5. No edge references an unknown building or resource id.

### New: `src/graph-ui.ts` (render layer, DOM-only)

Public surface:

```ts
export function openGraphModal(): void;
```

Behavior:
1. **Lazy imports** on first call:
   `await import('mermaid')` and `await import('svg-pan-zoom')`.
   Mermaid is ~250kB gzipped — keeping it out of the initial bundle
   matters for the game's first-paint.
2. **Source generation**: call `buildRecipeGraphMermaid()` (cached at
   module scope after first call).
3. **Render**: `mermaid.render('recipe-graph-svg', source)` → SVG
   string.
4. **Modal mount**: use `mountModal` from `src/ui-modal.ts`. Title
   "Recipe Graph". Body is an `overflow:auto` container holding the
   rendered SVG.
5. **Pan/zoom**: wrap the SVG in `svgPanZoom(svg, { …default opts })`.
6. **Tooltips**: after render, `querySelectorAll('.node')` on the SVG
   and bind `mouseenter`/`mouseleave` to show a floating tooltip:
   - Building nodes → name, tier, recipe inputs (with quantities),
     recipe outputs (with quantities), cycleSec.
   - Resource nodes → name, producers list (buildings), consumers
     list (buildings).
   Tooltip is a single `<div>` mounted to the modal body; it follows
   the cursor via `mousemove`.
7. **Caching**: store the rendered SVG node at module scope. On second
   and subsequent opens, re-mount the same DOM node rather than
   re-running Mermaid (full re-render is ~hundreds of ms on this size
   graph).

The first-open is async (lazy import + Mermaid render). The modal
mounts immediately with a "Generating graph…" placeholder, replaced
when render resolves. Subsequent opens are synchronous.

### Modified: `src/ui-icons.ts`

Add `'graph'` to the `IconId` union and a corresponding SVG path entry
in `PATHS`. Glyph: a small node-and-edge cluster (e.g. three circles
connected by two lines). Stroke-only, matches the existing
24×24 viewBox stroke style of the other icons.

### Modified: `src/main.ts`

In the `mountUi(reg, [...])` button list around line 551, add a new
button:

```ts
{ icon: 'graph', action: 'toggle-graph', label: 'Recipe Graph', kbd: 'Y' },
```

Placement: just before `'grid'` (it's a data view, sits naturally
between the existing data views like Skill Tree and the debug Grid
toggle).

Register the action with the input registry so the kbd works the same
way the other modals do — exact wiring mirrors `toggle-skill-tree`.
The action handler calls `openGraphModal()` from `graph-ui.ts`.

Kbd choice rationale: existing kbds are B, I, J, R, V, C, K, G, H, S.
`Y` is unused, mnemonic-adjacent ("Yarn"? — fine, the strip button
shows the label and icon, the kbd is just a shortcut).

### Modified: `package.json`

Add dependencies:
- `mermaid` (^11.x, current stable)
- `svg-pan-zoom` (^3.x)

Both are lazy-imported, so they don't appear in the entry bundle —
Vite's code-splitting will produce a separate chunk loaded on first
modal open.

## Data flow

```
RECIPES + BUILDING_DEFS  (static)
      |
      v
buildRecipeGraphMermaid()   ── pure, tested
      |
      v
Mermaid source string  ── cached at module scope
      |
      v (first open only)
mermaid.render(…)
      |
      v
SVG DOM node  ── cached at module scope
      |
      v
mountModal({ body: container.appendChild(svg) })
      |
      v
svgPanZoom(svg) + hover tooltip bindings
```

The pure layer is independently testable. The render layer is
read-only against the pure layer and isn't unit-tested (matches the
repo's standing pattern: "tests target the pure layer only").

## Error handling

- Mermaid render failure (malformed source from a bug in
  `buildRecipeGraphMermaid()`): the modal body shows a fallback
  "Failed to render recipe graph" message plus the error string. The
  vitest spec for the pure layer catches the common form of this
  (every recipe must produce edges), but a runtime fallback is still
  prudent.
- Lazy-import failure (e.g. offline, bundle corrupt): catch the import
  rejection, show a "Could not load graph renderer" message in the
  modal body.

No retries — both failure modes are deterministic (a fix-the-code or
fix-the-network situation, not transient).

## Risks and fallbacks

1. **Layout explosion at ~173 recipes.** Mermaid's `flowchart LR` may
   produce a several-thousand-pixel-wide SVG. Pan/zoom handles this
   for the user, but if the layout is genuinely unreadable (e.g.,
   excessive edge crossings), the fallback options are:
   - `flowchart TD` (top-down) — sometimes packs denser graphs better.
   - Break into category subgraphs (`subgraph chemistry … end`) so
     Mermaid's layout pass groups related recipes.
   - Decide per actual render output; not blocking for the design.
2. **svg-pan-zoom + text selection.** Pan-zoom captures mouse events,
   so users can't select node labels. Accepted trade-off — this is a
   visualization view, not a copy-text view.
3. **Tooltip flicker on dense graphs.** If hovering between adjacent
   nodes causes the tooltip to flash, debounce `mouseleave` by ~50ms.

## Testing strategy

- `src/recipe-graph.test.ts` — five assertions listed above, run via
  `npx vitest run src/recipe-graph.test.ts`.
- No DOM/Mermaid integration test. Verified manually after merge
  by opening the modal in the dev server (Daedalus screenshot of the
  rendered graph) and confirming pan/zoom/hover behaviors work.

## Out of repo

- vite.config.ts is unchanged.
- No new systemd / nginx work — the existing
  `robot-islands-dev.service` HMR picks up source edits.
- No persistence layer changes. The graph is stateless.

## Build-order note

This sits as polish work, parallel to the §15.7 build order. Doesn't
gate or unblock placement (§2.5), power (§4), or anything else on the
spec roadmap.
