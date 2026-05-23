// src/skilltree-graphview.ts
// Render-layer: full-page PixiJS overlay for the skill graph. Mounts its
// own Application instance (separate from the world canvas) on a fixed
// DOM overlay. Tasks 3-7 fill in the scene-graph content.

import { Application, Container } from 'pixi.js';
import type { IslandState } from './economy.js';

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

  function refresh(): void {
    if (!visible || !app || !world) return;
    // State-dependent paint happens in later tasks (nodes/edges/HUD).
    void deps;
  }

  return { el: overlay, show, hide, toggle, isVisible, refresh };
}
