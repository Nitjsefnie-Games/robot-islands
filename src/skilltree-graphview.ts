// src/skilltree-graphview.ts
// Render-layer: full-page PixiJS overlay for the skill graph. Mounts its
// own Application instance (separate from the world canvas) on a fixed
// DOM overlay. Tasks 3-7 fill in the scene-graph content.

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { DEFAULT_GRAPH, BRANCH_LABEL, type BranchId } from './skilltree.js';
import { KEYSTONE_PREREQS } from './skilltree-catalog.js';
import { computeSkillGraphLayout, type SkillGraphLayout } from './skilltree-layout.js';
import type { IslandState } from './economy.js';
import type { NodeId } from './skilltree-graph.js';

export interface SkillGraphView {
  readonly el: HTMLDivElement;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
  /** Repaint state-dependent visuals. Cheap to call frequently; no-op while hidden. */
  refresh(): void;
}

export interface SkillGraphViewDeps {
  getState(): IslandState;
}

type NodeKind = 'filler' | 'notable' | 'keystone';

const KEYSTONE_TARGETS: ReadonlySet<string> = new Set(
  KEYSTONE_PREREQS.map((k) => String(k.targetNode)),
);

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
  socketStroke: 0x7DD3E8,
  label:        0xE9E6DC,
} as const;

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
  nodes: Container;
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

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ri-skillgraph-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '\u00D7 CLOSE  (Esc)';
  closeBtn.addEventListener('click', () => hide());
  overlay.appendChild(closeBtn);

  parentEl.appendChild(overlay);

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
    // Center world container in viewport initially — Tasks 3+ render into it.
    w.position.set(canvasWrap.clientWidth / 2, canvasWrap.clientHeight / 2);
    a.stage.addChild(w);

    const edges = new Container();          edges.label = 'edges';
    const bridgesInactive = new Container(); bridgesInactive.label = 'bridges-inactive';
    const bridgesActive = new Container();   bridgesActive.label = 'bridges-active';
    const nodes = new Container();          nodes.label = 'nodes';
    const labels = new Container();         labels.label = 'labels';
    w.addChild(edges, bridgesInactive, bridgesActive, nodes, labels);
    layers = { edges, bridgesInactive, bridgesActive, nodes, labels };

    layout = computeSkillGraphLayout(DEFAULT_GRAPH);
    drawNodes();

    app = a;
    world = w;
  }

  function show(): void {
    if (visible) return;
    visible = true;
    overlay.hidden = false;
    void ensureApp().then(() => refresh());
  }
  function hide(): void {
    if (!visible) return;
    visible = false;
    overlay.hidden = true;
  }
  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }
  function isVisible(): boolean { return visible; }

  function drawNodes(): void {
    if (!layers || !layout) return;
    layers.nodes.removeChildren();
    layers.labels.removeChildren();

    // Branch roots.
    for (const [branch, p] of layout.branchRoots) {
      const g = new Graphics();
      g.circle(p.x, p.y, 13).fill(COLOR.rootFill).stroke({ color: COLOR.rootStroke, width: 2 });
      layers.nodes.addChild(g);
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

    // Catalog nodes.
    for (const n of DEFAULT_GRAPH.nodes) {
      const p = layout.nodes.get(n.id as unknown as NodeId);
      if (!p) continue;
      const g = new Graphics();
      const kind = classifyNode(String(n.id));
      if (kind === 'filler') {
        g.circle(p.x, p.y, 6).fill(COLOR.fillerFill).stroke({ color: COLOR.fillerStroke, width: 1 });
      } else if (kind === 'notable') {
        g.circle(p.x, p.y, 9).fill(COLOR.notableFill).stroke({ color: COLOR.notableStroke, width: 1.5 });
      } else {
        drawHexagon(g, p.x, p.y, 12);
        g.fill(COLOR.keystoneFill).stroke({ color: COLOR.keystoneStroke, width: 1.5 });
      }
      layers.nodes.addChild(g);
    }

    // Graft sockets — dashed circle. PixiJS 8 Graphics doesn't support
    // native dash patterns, so draw 8 segments around the circle.
    for (const [, p] of layout.graftSockets) {
      const g = new Graphics();
      const r = 11;
      for (let i = 0; i < 8; i++) {
        const a0 = (Math.PI * 2 * i) / 8;
        const a1 = a0 + (Math.PI * 2) / 16; // half-segment "on"
        g.moveTo(p.x + r * Math.cos(a0), p.y + r * Math.sin(a0));
        g.lineTo(p.x + r * Math.cos(a1), p.y + r * Math.sin(a1));
      }
      g.stroke({ color: COLOR.socketStroke, width: 1.5 });
      layers.nodes.addChild(g);
    }
  }

  function refresh(): void {
    if (!visible || !app || !world || !layers) return;
    void deps;
    drawNodes();
  }

  return { el: overlay, show, hide, toggle, isVisible, refresh };
}
