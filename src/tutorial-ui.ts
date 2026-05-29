import { currentStep, markCompleted } from './tutorial.js';
import type { WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Phase 7 — bottom-left hint overlay (spec §06)
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
