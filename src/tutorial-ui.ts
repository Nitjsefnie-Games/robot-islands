import { currentStep } from './tutorial.js';
import type { WorldState } from './world.js';

// Bottom-left hint overlay (spec §06).

let hintEl: HTMLElement | null = null;
let renderedStepId: string | null = null;

export interface TutorialHintDeps {
  /** Called when the player clicks the hint card to complete the active step.
   *  In REMOTE this forwards a `mark-tutorial-completed` intent; in LOCAL it
   *  mutates the authoritative world directly. */
  onCompleteStep(stepId: string): void;
}

export function refreshTutorialHint(world: WorldState, deps?: TutorialHintDeps): void {
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
      if (cur && deps) {
        deps.onCompleteStep(cur.id);
        refreshTutorialHint(world, deps);
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
