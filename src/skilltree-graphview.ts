// Render-layer: full-page PixiJS overlay for the skill graph. Mounts its
// own Application instance (separate from the world canvas) on a fixed
// DOM overlay.

import { Application, Container, Graphics, Text, TextStyle, Circle } from 'pixi.js';
import {
  DEFAULT_GRAPH,
  BRANCH_LABEL,
  SUBPATH_BRANCH,
  buyKeystone,
  buyNode,
  canBuyKeystone,
  costToUnlock,
  effectiveGraph,
  keystonePrereqFor,
  bindCrystal,
  unbindCrystal,
  computeMiniTreeRefund,
  formatNodeMagnitude,
  nodePurchaseStatus,
  tierForLevel,
  tierRequiredForDepth,
  type BranchId,
} from './skilltree.js';
import { CRYSTAL_CATALOG } from './skilltree-crystals.js';
import { KEYSTONE_PREREQS } from './skilltree-catalog.js';
import { computeSkillGraphLayout, type SkillGraphLayout } from './skilltree-layout.js';
import type { IslandState } from './economy.js';
import type { BridgeEdge, Graph, NodeId as GNodeId } from './skilltree-graph.js';

export interface SkillGraphView {
  readonly el: HTMLDivElement;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
  /** Repaint state-dependent visuals. Cheap to call frequently; no-op while hidden. */
  refresh(): void;
  /** Cheap HUD-only update (counters). No-op while hidden. */
  refreshHud(): void;
}

export interface SkillGraphViewDeps {
  getState(): IslandState;
}

type NodeKind = 'filler' | 'notable' | 'keystone';

const KEYSTONE_TARGETS: ReadonlySet<string> = new Set(
  KEYSTONE_PREREQS.map((k) => String(k.targetNode)),
);

function spentInBranchLocal(state: IslandState, branchId: BranchId, graph: Graph): number {
  let sum = 0;
  for (const nid of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nid);
    if (!node) continue;
    if (SUBPATH_BRANCH[node.subPath] === branchId) sum += node.cost;
  }
  return sum;
}

function isBridgeActiveLocal(b: BridgeEdge, state: IslandState, graph: Graph): boolean {
  return b.threshold.some(({ branch, minSpent }) => spentInBranchLocal(state, branch, graph) >= minSpent);
}

function buildEffectivePosMap(layout: SkillGraphLayout, state: IslandState): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  for (const [id, p] of layout.nodes) {
    map.set(id as unknown as string, p);
  }
  for (const [id, p] of layout.graftSockets) {
    map.set(id, p);
  }
  for (const [socketId, crystalId] of state.socketBindings) {
    const crystal = CRYSTAL_CATALOG.find((c) => c.id === crystalId);
    if (!crystal) continue;
    const sp = layout.graftSockets.get(socketId);
    if (!sp) continue;
    for (const nodeDef of crystal.nodes) {
      const nid = `${socketId}.${crystalId as string}.${nodeDef.idSuffix}`;
      map.set(nid, { x: sp.x + nodeDef.position.dx, y: sp.y + nodeDef.position.dy });
    }
  }
  return map;
}

function classifyNode(id: string): NodeKind {
  if (KEYSTONE_TARGETS.has(id)) return 'keystone';
  const lastDot = id.lastIndexOf('.');
  if (lastDot < 0) return 'filler';
  return /^\d+$/.test(id.slice(lastDot + 1)) ? 'filler' : 'notable';
}

// Visual constants matching spec §02.
const COLOR = {
  fillerFill:   0x25231F, fillerStroke:   0x8A877E,
  notableFill:  0xE0B47F, notableStroke:  0xE9E6DC,
  keystoneFill: 0xD38FCC, keystoneStroke: 0xE9E6DC,
  rootFill:     0x8FA56E, rootStroke:     0xE9E6DC,
  ownedFill:    0x8FA56E,
  ownedStroke:  0xE9E6DC,
  // Affordance signal — purchasable nodes get a warm clay stroke so they
  // pop against locked nodes (dim gray, low alpha on everything).
  affordStroke: 0xD97757,
  lockedStroke: 0x4A4845,
  socketStroke: 0x7DD3E8,
  label:        0xE9E6DC,
} as const;

// Per-state styling for purchasable / locked / owned nodes. Locked nodes
// drop fill alpha as well as stroke alpha so the affordance signal is
// readable at full graph zoom-out (~500 nodes on screen).
const FILL_ALPHA_LOCKED = 0.40;
const STROKE_ALPHA_LOCKED = 0.55;

function drawHexagon(g: Graphics, cx: number, cy: number, r: number): void {
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

interface SceneLayers {
  edges: Container;
  bridgesInactive: Container;
  bridgesActive: Container;
  highlight: Container;
  roots: Container;
  nodes: Container;
  sockets: Container;
  labels: Container;
}

export function mountSkillGraphView(
  parentEl: HTMLElement,
  deps: SkillGraphViewDeps,
): SkillGraphView {
  const overlay = document.createElement('div');
  overlay.className = 'ri-skillgraph-overlay';
  overlay.hidden = true;

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'ri-skillgraph-canvas';
  overlay.appendChild(canvasWrap);

  const hud = document.createElement('div');
  hud.className = 'ri-skillgraph-hud';

  const tl = document.createElement('div'); tl.className = 'hud-tl';
  const spLine = document.createElement('div');
  const ownedLine = document.createElement('div');
  tl.appendChild(spLine); tl.appendChild(ownedLine);
  hud.appendChild(tl);

  const tr = document.createElement('div'); tr.className = 'hud-tr';
  const CHIPS: ReadonlyArray<{ key: 'filler'|'notable'|'keystone'|'bridge'|'socket'; label: string }> = [
    { key: 'filler',   label: 'Filler'   },
    { key: 'notable',  label: 'Notables' },
    { key: 'keystone', label: 'Keystones' },
    { key: 'bridge',   label: 'Bridges'  },
    { key: 'socket',   label: 'Sockets'  },
  ];
  const filterOn: Record<string, boolean> = {
    filler: true, notable: true, keystone: true, bridge: true, socket: true,
  };
  for (const c of CHIPS) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.on = 'true';
    btn.textContent = c.label;
    btn.addEventListener('click', () => {
      filterOn[c.key] = !filterOn[c.key];
      btn.dataset.on = filterOn[c.key] ? 'true' : 'false';
      applyFilters();
    });
    tr.appendChild(btn);
  }
  hud.appendChild(tr);

  const bc = document.createElement('div'); bc.className = 'hud-bc';
  const legend: ReadonlyArray<{ color: string; label: string }> = [
    { color: '#8FA56E', label: 'Owned' },
    { color: '#E0B47F', label: 'Notable' },
    { color: '#D38FCC', label: 'Keystone' },
    { color: '#D97757', label: 'Owned edge / AND' },
    { color: '#7DD3E8', label: 'Active bridge / socket' },
  ];
  for (const l of legend) {
    const it = document.createElement('div'); it.className = 'legend-item';
    const sw = document.createElement('div'); sw.className = 'swatch'; sw.style.background = l.color;
    it.appendChild(sw);
    const sp = document.createElement('span'); sp.textContent = l.label;
    it.appendChild(sp);
    bc.appendChild(it);
  }
  hud.appendChild(bc);

  overlay.appendChild(hud);

  const tooltip = document.createElement('div');
  tooltip.className = 'ri-skillgraph-tooltip';
  tooltip.style.position = 'absolute';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.display = 'none';
  tooltip.style.zIndex = '10';
  tooltip.style.background = 'rgba(37, 36, 32, 0.96)';
  tooltip.style.border = '1px solid #3A3833';
  tooltip.style.padding = '8px 12px';
  tooltip.style.maxWidth = '280px';
  tooltip.style.fontFamily = 'system-ui, sans-serif';
  tooltip.style.fontSize = '12px';
  tooltip.style.color = '#CFCCC2';
  tooltip.style.lineHeight = '1.4';
  canvasWrap.appendChild(tooltip);

  const pickerModal = document.createElement('div');
  pickerModal.className = 'ri-panel';
  pickerModal.style.position = 'absolute';
  pickerModal.style.top = '50%';
  pickerModal.style.left = '50%';
  pickerModal.style.transform = 'translate(-50%, -50%)';
  pickerModal.style.minWidth = '260px';
  pickerModal.style.maxWidth = '360px';
  pickerModal.style.display = 'none';
  pickerModal.style.zIndex = '20';
  overlay.appendChild(pickerModal);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ri-skillgraph-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '\u00D7 CLOSE  (Esc)';
  closeBtn.addEventListener('click', () => hide());
  overlay.appendChild(closeBtn);

  parentEl.appendChild(overlay);

  const camera = { tx: 0, ty: 0, zoom: 1 };
  const ZOOM_MIN = 0.3, ZOOM_MAX = 3;

  function applyCamera(): void {
    if (!world) return;
    world.scale.set(camera.zoom);
    // world's origin is the centre of canvasWrap (set in ensureApp); pan
    // translates the centred origin.
    world.position.set(
      canvasWrap.clientWidth / 2 + camera.tx,
      canvasWrap.clientHeight / 2 + camera.ty,
    );
  }

  let dragging = false;
  let dragLastX = 0, dragLastY = 0;
  canvasWrap.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    dragLastX = ev.clientX;
    dragLastY = ev.clientY;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
  });
  canvasWrap.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    camera.tx += ev.clientX - dragLastX;
    camera.ty += ev.clientY - dragLastY;
    dragLastX = ev.clientX;
    dragLastY = ev.clientY;
    applyCamera();
  });
  canvasWrap.addEventListener('pointerup', () => { dragging = false; });
  canvasWrap.addEventListener('pointerleave', () => { dragging = false; });

  canvasWrap.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvasWrap.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    // Convert cursor screen-px to world-px BEFORE zoom change.
    const originX = canvasWrap.clientWidth / 2 + camera.tx;
    const originY = canvasWrap.clientHeight / 2 + camera.ty;
    const worldX = (cx - originX) / camera.zoom;
    const worldY = (cy - originY) / camera.zoom;

    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * factor));
    camera.zoom = next;

    // Adjust pan so the world point under the cursor stays fixed.
    camera.tx = cx - canvasWrap.clientWidth / 2 - worldX * camera.zoom;
    camera.ty = cy - canvasWrap.clientHeight / 2 - worldY * camera.zoom;
    applyCamera();
  }, { passive: false });

  // Lazy PixiJS Application — create on first show, keep across toggles.
  // Lives inside the overlay, NOT the world canvas. resizeTo the wrap so
  // it tracks viewport changes.
  let app: Application | null = null;
  let world: Container | null = null;
  let visible = false;

  let layers: SceneLayers | null = null;
  let layout: SkillGraphLayout | null = null;

  async function ensureApp(): Promise<void> {
    if (app) return;
    const a = new Application();
    await a.init({
      background: '#0a0e14',
      resizeTo: canvasWrap,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    canvasWrap.appendChild(a.canvas);
    const w = new Container();
    w.label = 'skillgraph-world';
    // Center world container in viewport initially.
    w.position.set(canvasWrap.clientWidth / 2, canvasWrap.clientHeight / 2);
    a.stage.addChild(w);

    const edges = new Container();          edges.label = 'edges';
    const bridgesInactive = new Container(); bridgesInactive.label = 'bridges-inactive';
    const bridgesActive = new Container();   bridgesActive.label = 'bridges-active';
    const highlight = new Container();       highlight.label = 'highlight';
    const roots = new Container();           roots.label = 'roots';
    const nodes = new Container();          nodes.label = 'nodes';
    const sockets = new Container();         sockets.label = 'sockets';
    const labels = new Container();         labels.label = 'labels';
    w.addChild(edges, bridgesInactive, bridgesActive, highlight, roots, nodes, sockets, labels);
    layers = { edges, bridgesInactive, bridgesActive, highlight, roots, nodes, sockets, labels };

    layout = computeSkillGraphLayout(DEFAULT_GRAPH);
    drawNodes();

    app = a;
    world = w;
    applyCamera();
  }

  function show(): void {
    if (visible) return;
    visible = true;
    overlay.hidden = false;
    void ensureApp().then(() => { applyCamera(); refresh(); });
  }
  function hide(): void {
    if (!visible) return;
    visible = false;
    camera.tx = 0; camera.ty = 0; camera.zoom = 1; applyCamera();
    overlay.hidden = true;
    closePickerModal();
  }
  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }
  function isVisible(): boolean { return visible; }

  function handleNodeClick(nodeId: GNodeId): void {
    const state = deps.getState();
    if (state.unlockedNodes.has(nodeId)) return;
    // Keystones are AND-gated (§9.3): bought via buyKeystone, which requires
    // EVERY prereq node owned plus the flat keystone cost. They are excluded
    // from the Dijkstra solver, so buyNode would report them unreachable.
    const ks = keystonePrereqFor(nodeId);
    if (ks) {
      if (!canBuyKeystone(ks, state)) return;
      try { buyKeystone(ks, state); } catch { return; }
      refresh();
      return;
    }
    // Dijkstra path for fillers and notables. buyNode handles the root-node
    // fallback for depth-1 fillers (no incoming edges) and walks the cheapest
    // path otherwise, auto-owning intermediates.
    const graph = effectiveGraph(state);
    try { buyNode(graph, state, nodeId); } catch { return; }
    refresh();
  }


  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]!));
  }

  function positionTooltip(cx: number, cy: number): void {
    const rect = canvasWrap.getBoundingClientRect();
    tooltip.style.left = `${cx - rect.left + 14}px`;
    tooltip.style.top = `${cy - rect.top + 14}px`;
  }

  function showTooltip(node: typeof DEFAULT_GRAPH.nodes[number], cx: number, cy: number): void {
    const state = deps.getState();
    const graph = effectiveGraph(state);
    const status = nodePurchaseStatus(graph, state, node.id as unknown as GNodeId);
    let costLine: string;
    if (status === 'owned') {
      costLine = '<span style="color:#8FA56E">OWNED</span>';
    } else if (status === 'tier-locked') {
      // Honest tier-lock reason — the renderer used to show these as a buyable
      // SP cost even though the depth→tier gate forbids the purchase.
      costLine =
        `<span style="color:#E08B7F">Requires Tier ${tierRequiredForDepth(node.depth)}</span>` +
        ` <span style="color:#9A968C">(island is Tier ${tierForLevel(state.level)})</span>`;
    } else if (status === 'unreachable') {
      costLine = '<span style="color:#E08B7F">UNREACHABLE</span>';
    } else {
      const path = costToUnlock(graph, state.unlockedNodes, state.unlockedEdges, state, node.id as unknown as GNodeId);
      const cost = path ? path.totalCost : node.cost;
      costLine =
        `<span style="color:#E0B47F">${cost} SP</span>` +
        (status === 'insufficient-sp' ? ' (insufficient)' : '');
    }
    const magStr = formatNodeMagnitude(node);
    tooltip.innerHTML =
      `<div style="color:#E9E6DC;font-weight:600;margin-bottom:4px">${escapeHtml(String(node.id))}</div>` +
      `<div style="margin-bottom:6px">${escapeHtml(node.description ?? '')}</div>` +
      (magStr ? `<div style="color:#E0B47F;margin-bottom:6px">${escapeHtml(magStr)}</div>` : '') +
      `<div>${costLine}</div>`;
    tooltip.style.display = 'block';
    positionTooltip(cx, cy);
  }

  function drawHighlight(nodeId: GNodeId): void {
    if (!layers || !layout) return;
    layers.highlight.removeChildren();

    const state = deps.getState();
    const graph = effectiveGraph(state);
    const posMap = buildEffectivePosMap(layout, state);
    const getPos = (id: string) => posMap.get(id) ?? null;

    // For unowned reachable nodes: highlight the entire cheapest-path the
    // player would pay if they clicked. For owned nodes: fall back to the
    // direct-incident-edges highlight (no useful path to draw).
    const isOwned = state.unlockedNodes.has(nodeId);
    const path = isOwned
      ? null
      : costToUnlock(graph, state.unlockedNodes, state.unlockedEdges, state, nodeId);

    const g = new Graphics();
    if (path && path.path.length > 0) {
      // Highlight every edge on the cheapest path with the rust accent.
      // Also highlight every node on the path (the intermediates that the
      // player would auto-own) so the visual sweep is unambiguous.
      const pathNodeIds = new Set<string>();
      for (const e of path.path) {
        const a = getPos(String(e.from));
        const b = getPos(String(e.to));
        if (!a || !b) continue;
        const cp = controlPoint(a, b, curveSign(String(e.id)));
        g.moveTo(a.x, a.y).quadraticCurveTo(cp.x, cp.y, b.x, b.y);
        pathNodeIds.add(String(e.from));
        pathNodeIds.add(String(e.to));
      }
      g.stroke({ color: 0xD97757, width: 2.6, alpha: 1 });
      layers.highlight.addChild(g);

      // Path-node rings: small clay ring around each auto-owned intermediate
      // so the player sees exactly which nodes the click would unlock.
      const rings = new Graphics();
      for (const id of pathNodeIds) {
        if (state.unlockedNodes.has(id as unknown as GNodeId)) continue;
        const p = getPos(id);
        if (!p) continue;
        rings.circle(p.x, p.y, 14).stroke({ color: 0xD97757, width: 1.5, alpha: 0.9 });
      }
      layers.highlight.addChild(rings);
    } else {
      // Owned or root-node hover: incident edges only.
      for (const e of graph.edges) {
        if (e.from !== nodeId && e.to !== nodeId) continue;
        const a = getPos(String(e.from));
        const b = getPos(String(e.to));
        if (!a || !b) continue;
        const cp = controlPoint(a, b, curveSign(String(e.id)));
        g.moveTo(a.x, a.y).quadraticCurveTo(cp.x, cp.y, b.x, b.y);
      }
      for (const e of graph.bridges) {
        if (e.from !== nodeId && e.to !== nodeId) continue;
        const a = getPos(String(e.from));
        const b = getPos(String(e.to));
        if (!a || !b) continue;
        const cp = controlPoint(a, b, curveSign(String(e.id)));
        g.moveTo(a.x, a.y).quadraticCurveTo(cp.x, cp.y, b.x, b.y);
      }
      g.stroke({ color: 0xD97757, width: 2.6, alpha: 1 });
      layers.highlight.addChild(g);
    }

    const node = graph.nodes.find((n) => (n.id as unknown as GNodeId) === nodeId);
    if (node?.aura) {
      const p = getPos(String(nodeId));
      if (p) {
        const ring = new Graphics();
        const radiusPx = node.aura.radius * 24;
        ring.circle(p.x, p.y, radiusPx).stroke({ color: 0xE0B47F, width: 1.5, alpha: 0.7 });
        layers.highlight.addChild(ring);
      }
    }
  }

  function drawNodes(): void {
    if (!layers || !layout) return;
    layers.roots.removeChildren();
    layers.nodes.removeChildren();
    layers.sockets.removeChildren();
    layers.labels.removeChildren();

    const state = deps.getState();
    const graph = effectiveGraph(state);
    const posMap = buildEffectivePosMap(layout, state);

    // Branch roots. Only branch-root labels are rendered today (no per-node
    // labels — the spec §06 open question about zoomed-out overlap therefore
    // doesn't bite). If per-node labels are ever added, gate their visibility
    // on camera.zoom (e.g. `if (camera.zoom < 1) skip node-level labels`) to
    // avoid the overlap-soup the spec called out.
    for (const [branch, p] of layout.branchRoots) {
      const g = new Graphics();
      g.circle(p.x, p.y, 13).fill(COLOR.rootFill).stroke({ color: COLOR.rootStroke, width: 2 });
      layers.roots.addChild(g);
      const t = new Text({
        text: BRANCH_LABEL[branch as BranchId],
        style: new TextStyle({
          fontFamily: 'ui-monospace, monospace',
          fontSize: 13, fill: COLOR.label, fontWeight: '600',
        }),
      });
      t.anchor.set(0.5, 0);
      t.position.set(p.x, p.y + 22);
      layers.labels.addChild(t);
    }

    // All nodes: catalog + bound crystal mini-trees.
    for (const n of graph.nodes) {
      const p = posMap.get(n.id as unknown as string);
      if (!p) continue;
      // Skip synthetic socket nodes — they are rendered in the socket loop.
      if (layout.graftSockets.has(String(n.id))) continue;

      const g = new Graphics();
      const kind = classifyNode(String(n.id));
      if (!filterOn[kind]) continue;

      // Single source of truth shared with the buy path (`nodePurchaseStatus`
      // mirrors `buyNode` — incl. the depth→tier gate). Previously the render
      // recomputed affordability with a root-node `n.cost` fallback that
      // bypassed the tier gate, lighting up tier-locked entry nodes as
      // purchasable even though `buyNode` would reject them.
      const status = nodePurchaseStatus(graph, state, n.id as unknown as GNodeId);
      const owned = status === 'owned';
      const purchasable = status === 'purchasable';

      // State-driven palette: owned (green fill, full alpha), purchasable
      // (kind fill + clay accent stroke, full alpha, thicker), locked
      // (kind fill at 40% alpha, dim stroke at 55%).
      const baseFill = kind === 'filler' ? COLOR.fillerFill
                     : kind === 'notable' ? COLOR.notableFill
                     : COLOR.keystoneFill;
      const baseStrokeW = kind === 'filler' ? 1 : 1.5;

      const fill = owned ? COLOR.ownedFill : baseFill;
      const fillAlpha = owned ? 1 : (purchasable ? 1 : FILL_ALPHA_LOCKED);
      const stroke = owned ? COLOR.ownedStroke
                   : purchasable ? COLOR.affordStroke
                   : COLOR.lockedStroke;
      const strokeWidth = owned ? baseStrokeW : (purchasable ? baseStrokeW + 1 : baseStrokeW);
      const strokeAlpha = owned ? 1 : (purchasable ? 1 : STROKE_ALPHA_LOCKED);

      if (kind === 'filler') {
        g.circle(p.x, p.y, 6).fill({ color: fill, alpha: fillAlpha })
          .stroke({ color: stroke, width: strokeWidth, alpha: strokeAlpha });
      } else if (kind === 'notable') {
        g.circle(p.x, p.y, 9).fill({ color: fill, alpha: fillAlpha })
          .stroke({ color: stroke, width: strokeWidth, alpha: strokeAlpha });
      } else {
        drawHexagon(g, p.x, p.y, 12);
        g.fill({ color: fill, alpha: fillAlpha })
          .stroke({ color: stroke, width: strokeWidth, alpha: strokeAlpha });
      }

      g.eventMode = 'static';
      // Only purchasable nodes get the clickable pointer; locked nodes keep the
      // default cursor (they still bind hover so the tooltip can explain why).
      g.cursor = purchasable ? 'pointer' : 'default';
      g.hitArea = new Circle(p.x, p.y, kind === 'filler' ? 8 : 12);
      if (!owned) {
        g.on('pointertap', () => handleNodeClick(n.id as unknown as GNodeId));
      }
      g.on('pointerover', (ev) => {
        showTooltip(n, ev.clientX, ev.clientY);
        drawHighlight(n.id as unknown as GNodeId);
      });
      g.on('pointermove', (ev) => {
        positionTooltip(ev.clientX, ev.clientY);
      });
      g.on('pointerout', () => {
        tooltip.style.display = 'none';
        layers!.highlight.removeChildren();
      });

      layers.nodes.addChild(g);
    }

    // Graft sockets — dashed circle. PixiJS 8 Graphics doesn't support
    // native dash patterns, so draw 8 segments around the circle.
    for (const [socketId, p] of layout.graftSockets) {
      const g = new Graphics();
      const r = 11;
      for (let i = 0; i < 8; i++) {
        const a0 = (Math.PI * 2 * i) / 8;
        const a1 = a0 + (Math.PI * 2) / 16; // half-segment "on"
        g.moveTo(p.x + r * Math.cos(a0), p.y + r * Math.sin(a0));
        g.lineTo(p.x + r * Math.cos(a1), p.y + r * Math.sin(a1));
      }
      g.stroke({ color: COLOR.socketStroke, width: 1.5 });

      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = new Circle(p.x, p.y, 14);

      const boundCrystalId = state.socketBindings.get(socketId);

      g.on('pointertap', () => {
        openPickerModal(socketId);
      });
      g.on('pointerover', (ev) => {
        if (boundCrystalId) {
          const crystal = CRYSTAL_CATALOG.find((c) => c.id === boundCrystalId);
          if (crystal) {
            const totalCost = crystal.nodes.reduce((s, n) => s + n.cost, 0);
            tooltip.innerHTML =
              `<div style="color:#E9E6DC;font-weight:600;margin-bottom:4px">${escapeHtml(crystal.displayName)}</div>` +
              `<div>${crystal.nodes.length} nodes · ${totalCost} SP total</div>`;
          }
        } else {
          tooltip.innerHTML =
            `<div style="color:#E9E6DC;font-weight:600;margin-bottom:4px">Empty graft socket</div>` +
            `<div>Craft a Skill Crystal at a Skill Forge and click to attach.</div>`;
        }
        tooltip.style.display = 'block';
        positionTooltip(ev.clientX, ev.clientY);
      });
      g.on('pointermove', (ev) => {
        positionTooltip(ev.clientX, ev.clientY);
      });
      g.on('pointerout', () => {
        tooltip.style.display = 'none';
      });

      layers.sockets.addChild(g);
    }
  }

  // Bezier control-point offset as a fraction of edge length. Per-edge sign
  // alternates by id hash so parallel edges curve different ways.
  const CURVE_OFFSET = 0.18;
  function curveSign(id: string): 1 | -1 {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return (h & 1) === 0 ? 1 : -1;
  }
  function controlPoint(a: { x: number; y: number }, b: { x: number; y: number }, sign: 1 | -1):
    { x: number; y: number } {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    // Perpendicular unit vector × offset × len.
    const off = CURVE_OFFSET * len * sign;
    return { x: mx + (-dy / len) * off, y: my + (dx / len) * off };
  }

  function drawEdges(state: IslandState): void {
    if (!layers || !layout) return;
    layers.edges.removeChildren();
    layers.bridgesInactive.removeChildren();
    layers.bridgesActive.removeChildren();

    const graph = effectiveGraph(state);
    const posMap = buildEffectivePosMap(layout, state);
    const getPos = (id: string): { x: number; y: number } | null => posMap.get(id) ?? null;

    // Standard + AND edges as quadratic bezier curves so crossings read as
    // distinct arcs instead of overlapping straight lines.
    const g = new Graphics();
    for (const e of graph.edges) {
      const a = getPos(String(e.from));
      const b = getPos(String(e.to));
      if (!a || !b) continue;
      const cp = controlPoint(a, b, curveSign(String(e.id)));
      const owned = state.unlockedEdges.has(e.id);
      if (e.mode === 'and') {
        g.moveTo(a.x, a.y).quadraticCurveTo(cp.x, cp.y, b.x, b.y)
         .stroke({ color: 0xD97757, width: 1.6, alpha: 0.85 });
      } else if (owned) {
        g.moveTo(a.x, a.y).quadraticCurveTo(cp.x, cp.y, b.x, b.y)
         .stroke({ color: 0xD97757, width: 1.8, alpha: 1 });
      } else {
        g.moveTo(a.x, a.y).quadraticCurveTo(cp.x, cp.y, b.x, b.y)
         .stroke({ color: 0x3A3833, width: 1, alpha: 0.85 });
      }
    }
    layers.edges.addChild(g);

    // Bridges — also curved. Dashed-via-segments along the bezier.
    const gInactive = new Graphics();
    const gActive = new Graphics();
    const SEGMENTS = 16;
    const sample = (a: { x: number; y: number }, cp: { x: number; y: number }, b: { x: number; y: number }, t: number) => {
      const u = 1 - t;
      return {
        x: u * u * a.x + 2 * u * t * cp.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * cp.y + t * t * b.y,
      };
    };
    for (const br of graph.bridges) {
      const a = getPos(String(br.from));
      const b = getPos(String(br.to));
      if (!a || !b) continue;
      const cp = controlPoint(a, b, curveSign(String(br.id)));
      const active = isBridgeActiveLocal(br, state, graph);
      const target = active ? gActive : gInactive;
      for (let i = 0; i < SEGMENTS; i += 2) {
        const p0 = sample(a, cp, b, i / SEGMENTS);
        const p1 = sample(a, cp, b, (i + 1) / SEGMENTS);
        target.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
      }
      target.stroke({
        color: active ? 0x7DD3E8 : 0x8A877E,
        width: active ? 1.4 : 1,
        alpha: active ? 1 : 0.3,
      });
    }
    layers.bridgesInactive.addChild(gInactive);
    layers.bridgesActive.addChild(gActive);
  }

  function applyFilters(): void {
    if (!layers) return;
    const allNodesOff = !filterOn.filler && !filterOn.notable && !filterOn.keystone;
    layers.nodes.visible = !allNodesOff;
    layers.bridgesInactive.visible = !!filterOn.bridge;
    layers.bridgesActive.visible = !!filterOn.bridge;
    layers.sockets.visible = !!filterOn.socket;
    drawNodes();
  }

  function refreshHud(): void {
    if (!visible) return;
    const state = deps.getState();
    const graph = effectiveGraph(state);
    spLine.textContent = `Unspent SP: ${state.unspentSkillPoints}`;
    ownedLine.textContent = `Owned: ${state.unlockedNodes.size} / ${graph.nodes.length}`;
  }

  function closePickerModal(): void {
    pickerModal.style.display = 'none';
    pickerModal.innerHTML = '';
    document.removeEventListener('keydown', onPickerKeydown);
  }

  function onPickerKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      closePickerModal();
    }
  }

  function openPickerModal(socketId: string): void {
    if (pickerModal.style.display === 'block') return;
    const state = deps.getState();
    const socket = DEFAULT_GRAPH.graftSockets.find((s) => s.id === socketId);
    if (!socket) return;

    pickerModal.innerHTML = '';
    pickerModal.style.display = 'block';
    document.addEventListener('keydown', onPickerKeydown);

    const head = document.createElement('div');
    head.className = 'ri-panel__head';
    pickerModal.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ri-panel__body';

    const boundCrystalId = state.socketBindings.get(socketId);
    if (boundCrystalId) {
      head.textContent = 'Change Skill Crystal';
      const current = document.createElement('div');
      current.style.marginBottom = '10px';
      current.style.color = '#E9E6DC';
      const crystal = CRYSTAL_CATALOG.find((c) => c.id === boundCrystalId);
      current.textContent = `Currently bound: ${crystal ? crystal.displayName : boundCrystalId}`;
      body.appendChild(current);
    } else {
      head.textContent = 'Attach Skill Crystal';
    }

    const eligible = CRYSTAL_CATALOG.filter(
      (c) => c.eligibleSubPaths.includes(socket.subPathId) && ((state.inventory as Record<string, number>)[c.id as string] ?? 0) > 0,
    );

    if (eligible.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.color = '#CFCCC2';
      emptyMsg.textContent = 'No eligible crystals in inventory.';
      body.appendChild(emptyMsg);
    } else {
      for (const crystal of eligible) {
        const row = document.createElement('button');
        row.className = 'ri-btn';
        row.style.display = 'block';
        row.style.width = '100%';
        row.style.marginBottom = '6px';
        row.style.textAlign = 'left';
        row.textContent = `${crystal.displayName} (×${(state.inventory as Record<string, number>)[crystal.id as string] ?? 0})`;
        row.addEventListener('click', () => {
          bindCrystal(state, socketId, crystal.id);
          closePickerModal();
          refresh();
        });
        body.appendChild(row);
      }
    }

    if (boundCrystalId) {
      const unbindBtn = document.createElement('button');
      unbindBtn.className = 'ri-btn';
      unbindBtn.style.display = 'block';
      unbindBtn.style.width = '100%';
      unbindBtn.style.marginTop = '10px';
      unbindBtn.style.textAlign = 'left';
      unbindBtn.textContent = 'Unbind (returns crystal to inventory)';
      unbindBtn.addEventListener('click', () => {
        const refund = computeMiniTreeRefund(state, socketId, boundCrystalId);
        if (refund.nodeCount > 0) {
          const ok = confirm(
            `This socket has ${refund.nodeCount} unlocked node${refund.nodeCount === 1 ? '' : 's'} (${refund.spRefund} SP will be refunded). Unbind?`,
          );
          if (!ok) return;
        }
        unbindCrystal(state, socketId);
        closePickerModal();
        refresh();
      });
      body.appendChild(unbindBtn);
    }

    pickerModal.appendChild(body);
  }

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay && pickerModal.style.display === 'block') {
      closePickerModal();
    }
  });

  function refresh(): void {
    if (!visible || !app || !world || !layers) return;
    const state = deps.getState();
    drawEdges(state);
    drawNodes();
    refreshHud();
  }

  return { el: overlay, show, hide, toggle, isVisible, refresh, refreshHud };
}
