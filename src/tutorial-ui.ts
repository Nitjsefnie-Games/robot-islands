import { OBJECTIVES, type TutorialState } from './tutorial.js';

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
