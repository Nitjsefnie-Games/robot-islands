import { currentStep, markCompleted, OBJECTIVES, type TutorialState } from './tutorial.js';
import type { WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Backward-compat banner (pre-Phase-7) — main.ts still imports this.
// ---------------------------------------------------------------------------

export function renderTutorialBanner(state: TutorialState): HTMLElement | null {
  if (!state.current) return null;
  const obj = OBJECTIVES[state.current];
  const banner = document.createElement('div');
  banner.id = 'tutorial-banner';
  banner.style.cssText = `
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--ri-elev);
    border: 1px solid var(--ri-accent);
    padding: 8px 16px;
    border-radius: 4px;
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--ri-fg-1);
    font-family: ui-monospace, monospace;
    font-size: 13px;
    z-index: 200;
  `;
  const title = document.createElement('strong');
  title.textContent = obj.title;
  title.style.color = 'var(--ri-accent)';
  banner.appendChild(title);
  const hint = document.createElement('span');
  hint.textContent = obj.hint;
  banner.appendChild(hint);
  return banner;
}

// ---------------------------------------------------------------------------
// Phase 7 — top-right hint overlay (spec §06)
// ---------------------------------------------------------------------------

let hintEl: HTMLElement | null = null;
let renderedStepId: string | null = null;

export function refreshTutorialHint(world: WorldState): void {
  const step = currentStep(world);
  if (!step) {
    if (hintEl) {
      hintEl.remove();
      hintEl = null;
      renderedStepId = null;
    }
    return;
  }
  if (step.id === renderedStepId) return; // avoid re-render thrash
  if (!hintEl) {
    hintEl = document.createElement('div');
    hintEl.className = 'tutorial-hint';
    document.body.appendChild(hintEl);
    hintEl.addEventListener('click', () => {
      const cur = currentStep(world);
      if (cur) {
        markCompleted(world, cur.id);
        refreshTutorialHint(world);
      }
    });
  }
  hintEl.innerHTML = `
    <div class="tut-num">${step.id}</div>
    <div class="tut-mech">${step.mechanic}</div>
    <div class="tut-text">${step.hint}</div>
    ${step.expectedAction ? `<div class="tut-action">${step.expectedAction}</div>` : ''}
    <div class="tut-hint-dismiss">click to dismiss</div>
  `;
  renderedStepId = step.id;
}
