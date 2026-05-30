// Shared modal shell. Every modal (`buildings-ui`, `inventory-ui`,
// `construction-ui`, `skilltree-ui`, `settings-ui`) builds on `mountModal`
// so scrim styling, close affordances, header chrome, animations, and the
// optional filter / footer regions are unified.
//
// Pure DOM — no framework, no PixiJS. Imports the `.ri-*` classes from
// `ui.css` (already loaded via main.ts) and the `close` glyph from
// `ui-icons.ts`.

import { icon } from './ui-icons.js';

export interface ModalConfig {
  readonly title: string;
  readonly subtitle?: string;
  /** Called once at mount; populates the body region. */
  buildBody(body: HTMLDivElement): void;
  /** Optional footer builder. Receives the footer element; can append
   *  buttons / labels. `.ri-modal__footer-spacer` is added automatically
   *  before the caller's content so right-aligning buttons is one append. */
  buildFooter?(footer: HTMLDivElement): void;
  /** Optional filter strip below the header. */
  buildFilters?(filters: HTMLDivElement): void;
  /** Called when the scrim is clicked, Escape pressed, or the close
   *  button activated. */
  onClose(): void;
}

export interface ModalHandle {
  readonly el: HTMLDivElement;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

/** Mount a modal onto `parentEl`. Hidden by default; call `show()` to
 *  display. Returns a handle whose `toggle()` mirrors the current toggle
 *  convention used by `*-ui.ts` modules. */
export function mountModal(
  parentEl: HTMLElement,
  cfg: ModalConfig,
): ModalHandle {
  const scrim = document.createElement('div');
  scrim.classList.add('ri-modal-scrim');
  scrim.style.display = 'none';

  const modal = document.createElement('div');
  modal.classList.add('ri-modal');
  scrim.appendChild(modal);

  const header = document.createElement('div');
  header.classList.add('ri-modal__header');
  const title = document.createElement('span');
  title.classList.add('ri-modal__title');
  title.textContent = cfg.title;
  header.appendChild(title);
  if (cfg.subtitle) {
    const sub = document.createElement('span');
    sub.classList.add('ri-modal__sub');
    sub.textContent = cfg.subtitle;
    header.appendChild(sub);
  }
  const close = document.createElement('button');
  close.classList.add('ri-modal__close');
  close.appendChild(icon('close', 14));
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => cfg.onClose());
  header.appendChild(close);
  modal.appendChild(header);

  if (cfg.buildFilters) {
    const filters = document.createElement('div');
    filters.classList.add('ri-modal__filters');
    cfg.buildFilters(filters);
    modal.appendChild(filters);
  }

  const body = document.createElement('div');
  body.classList.add('ri-modal__body');
  cfg.buildBody(body);
  modal.appendChild(body);

  if (cfg.buildFooter) {
    const footer = document.createElement('div');
    footer.classList.add('ri-modal__footer');
    // Spacer first — footer authors can append right-aligned buttons.
    const spacer = document.createElement('div');
    spacer.classList.add('ri-modal__footer-spacer');
    footer.appendChild(spacer);
    cfg.buildFooter(footer);
    modal.appendChild(footer);
  }

  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) cfg.onClose();
  });

  parentEl.appendChild(scrim);
  let visible = false;
  const handle: ModalHandle = {
    el: scrim,
    show(): void {
      scrim.style.display = 'flex';
      visible = true;
    },
    hide(): void {
      scrim.style.display = 'none';
      visible = false;
    },
    toggle(): boolean {
      if (visible) handle.hide();
      else handle.show();
      return visible;
    },
    isVisible(): boolean {
      return visible;
    },
  };
  return handle;
}
