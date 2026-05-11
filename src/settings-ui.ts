// Settings panel — DOM overlay for keybinding rebind + save management.
// Toggled via KeyS (default binding) and dismissed via Escape via the
// shared `dismiss-modal` action wired in main.ts.
//
// Visual idiom matches skilltree-ui / buildings-ui / inventory-ui: dark
// monospace panel, ACCENT cyan header `SETTINGS / RUN-01`, scrim behind.
//
// Two sections:
//
//   1. KEYBINDINGS — one row per *action* registered in `installDefaultBindings`.
//      Each row shows: action name (left), the current bound code(s) joined
//      by ` · ` (center), and a `Rebind` button (right). Clicking Rebind
//      enters capture mode for that row — the next keydown anywhere captures
//      `e.code` and rebinds. Escape during capture cancels (and is suppressed
//      from the global dismiss-modal handler so it doesn't close the panel).
//
//      Conflict resolution: if the captured code is currently bound to a
//      DIFFERENT action, prompt via `window.confirm()` "Override X?". If yes,
//      `unbind` the prior mapping, then `bind` the new one.
//
//   2. SAVE — last-saved age (driven by `getLastSavedAt`), Reset Bindings
//      button, Clear Save (with confirm + reload), Export Save (clipboard
//      copy of the full snapshot JSON), Import Save (file input → validate
//      → reload).
//
// Persistence deferral: rebound keys are NOT saved across reloads in this
// step. `installDefaultBindings` re-runs on every boot, so a custom layout
// resets. Persisting the rebind map is straightforward (snapshot the
// `reg.bindings` Map alongside the world snapshot) but is intentionally
// deferred to keep this step's surface small.
//
// `e.code` exception: per AGENTS.md "No hardcoded `e.code === 'KeyW'`
// checks anywhere outside `input.ts`" — the capture handler READS `e.code`
// to record what the user pressed, it does not DISPATCH on it. That's the
// allowed exception called out in the task brief.

import {
  bind,
  installDefaultBindings,
  unbind,
  type InputRegistry,
} from './input.js';
import {
  clearSave,
  isValidSaveSnapshot,
  importSave,
  serializeWorld,
  STORAGE_KEY,
} from './persistence.js';
import type { IslandState } from './economy.js';
import type { WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Palette — shared vocabulary with skilltree-ui.ts / buildings-ui.ts
// ---------------------------------------------------------------------------
const PANEL_BG = 'rgba(14, 18, 26, 0.92)';
const PANEL_BORDER = '#3a4452';
const PANEL_HEADER_BORDER = '#4a5a72';
const FG = '#cdd6f4';
const FG_DIM = '#6c7791';
const FG_MUTED = '#4a5365';
const ACCENT = '#7dd3e8';
const ACCENT_DIM = '#3d6f7c';
const WARN = '#f5a742';
const STRIP_BG = 'rgba(20, 24, 32, 0.6)';
const ROW_BG_HOVER = 'rgba(125, 211, 232, 0.06)';
const CAPTURE_BG = 'rgba(245, 167, 66, 0.12)';

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/** Result of `applyCapturedKey` describing what the rebind actually did. */
export interface ApplyCapturedKeyResult {
  /** True if `bind(reg, code, action)` was called. False if the override
   *  prompt returned false (user declined). */
  readonly applied: boolean;
  /** The action that previously held `code`, if any. null if the code
   *  was unbound, or if the prior mapping pointed at the same action. */
  readonly displacedAction: string | null;
}

/**
 * Apply a captured `(code, action)` rebind to the registry, with conflict
 * confirmation through the injected `confirm` callback. Pure-by-injection:
 * pass `window.confirm` in production, a stub in tests.
 *
 *   - No prior binding for `code` → `bind` unconditionally.
 *   - Prior binding == same action → `bind` is a no-op semantically, but
 *     we still call it so callers can rely on the post-condition that
 *     `reg.bindings.get(code) === action`.
 *   - Prior binding != same action → call `confirm(message)`. If true,
 *     `unbind(reg, code)` then `bind(reg, code, action)`. If false, leave
 *     the registry untouched and return `{ applied: false }`.
 */
export function applyCapturedKey(
  reg: InputRegistry,
  code: string,
  action: string,
  confirm: (message: string) => boolean,
): ApplyCapturedKeyResult {
  const prior = reg.bindings.get(code);
  if (prior === undefined) {
    bind(reg, code, action);
    return { applied: true, displacedAction: null };
  }
  if (prior === action) {
    // Idempotent re-bind. Don't bother the user.
    bind(reg, code, action);
    return { applied: true, displacedAction: null };
  }
  // Conflict: ask before overwriting.
  const ok = confirm(`Override ${prior}?`);
  if (!ok) return { applied: false, displacedAction: prior };
  unbind(reg, code);
  bind(reg, code, action);
  return { applied: true, displacedAction: prior };
}

/**
 * Reset every binding in `reg` to the defaults installed by
 * `installDefaultBindings`. Implemented as nuke-and-reinstall so we don't
 * need to track "what was changed" — single source of truth is
 * `installDefaultBindings`.
 */
export function resetBindingsToDefaults(reg: InputRegistry): void {
  reg.bindings.clear();
  installDefaultBindings(reg);
}

/**
 * Group all known bindings by action — one row per action with all keys
 * joined. The actions list comes from `reg.actions` (the registered
 * handlers) so an action with no current binding still appears as a
 * row, displayed as "(unbound)". Ordered alphabetically by action name
 * for a stable scan.
 */
export function actionRows(
  reg: InputRegistry,
): ReadonlyArray<{ readonly action: string; readonly codes: ReadonlyArray<string> }> {
  const map = new Map<string, string[]>();
  for (const action of reg.actions.keys()) map.set(action, []);
  for (const [code, action] of reg.bindings) {
    const list = map.get(action);
    if (list) list.push(code);
    else map.set(action, [code]);
  }
  const out: { action: string; codes: ReadonlyArray<string> }[] = [];
  for (const [action, codes] of map) {
    out.push({ action, codes: codes.slice().sort() });
  }
  out.sort((a, b) => a.action.localeCompare(b.action));
  return out;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  styled(
    b,
    [
      'background: #1a1f2a',
      `color: ${FG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'padding: 3px 9px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.04em',
      'text-transform: uppercase',
      'transition: background 80ms ease, border-color 80ms ease',
    ].join(';'),
  );
  b.addEventListener('mouseenter', () => {
    b.style.background = '#252b38';
    b.style.borderColor = ACCENT_DIM;
  });
  b.addEventListener('mouseleave', () => {
    b.style.background = '#1a1f2a';
    b.style.borderColor = PANEL_BORDER;
  });
  b.addEventListener('click', () => {
    onClick();
    b.blur();
  });
  return b;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface SettingsUi {
  readonly el: HTMLDivElement;
  /** Repaint dynamic state (last-saved age, bindings table). No-op while
   *  hidden, like the sibling panels. */
  refresh(): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

export interface SettingsUiDeps {
  /** The input registry to read + mutate when rebinding. */
  readonly reg: InputRegistry;
  /** Live world reference for export-save serialisation. */
  readonly world: WorldState;
  /** Live per-island state map for export-save serialisation. */
  readonly islandStates: ReadonlyMap<string, IslandState>;
  /** `performance.now()` of the last successful autosave, or null if no
   *  save has landed yet. Returned by a getter so the panel reads fresh
   *  values every refresh. */
  getLastSavedAt(): number | null;
}

export function mountSettingsUi(
  parentEl: HTMLElement,
  deps: SettingsUiDeps,
): SettingsUi {
  let visible = false;
  // Action whose row is in capture mode, or null when not capturing.
  let captureAction: string | null = null;
  // The capture keydown listener registered on window. Reference is held so
  // we can remove it cleanly when capture exits.
  let captureListener: ((e: KeyboardEvent) => void) | null = null;

  // ---- Scrim + panel shell ----------------------------------------------
  const scrim = document.createElement('div');
  scrim.id = 'settings-scrim';
  styled(
    scrim,
    [
      'position: fixed',
      'inset: 0',
      'background: rgba(10, 14, 20, 0.55)',
      'z-index: 200',
      'display: none',
      'pointer-events: none',
      'backdrop-filter: blur(1.5px)',
    ].join(';'),
  );

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  styled(
    panel,
    [
      'position: fixed',
      'top: 50%',
      'left: 50%',
      'transform: translate(-50%, -50%)',
      'width: min(640px, calc(100vw - 32px))',
      'max-height: calc(100vh - 32px)',
      `background: ${PANEL_BG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'border-radius: 2px',
      'box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(125, 211, 232, 0.05)',
      'z-index: 201',
      'pointer-events: auto',
      `color: ${FG}`,
      'font-family: ui-monospace, monospace',
      'font-size: 12px',
      'line-height: 1.45',
      'font-variant-numeric: tabular-nums',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
    ].join(';'),
  );

  // ---- Header -----------------------------------------------------------
  const header = document.createElement('div');
  styled(
    header,
    [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'padding: 10px 16px 9px',
      `border-bottom: 1px solid ${PANEL_HEADER_BORDER}`,
      `background: ${STRIP_BG}`,
      'gap: 14px',
    ].join(';'),
  );

  const headerTitleWrap = document.createElement('div');
  styled(
    headerTitleWrap,
    'display: flex; align-items: baseline; gap: 10px; flex: 0 0 auto',
  );
  const titleEl = document.createElement('span');
  titleEl.textContent = 'SETTINGS';
  styled(
    titleEl,
    [
      `color: ${ACCENT}`,
      'font-size: 12px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const subtitleEl = document.createElement('span');
  subtitleEl.textContent = '/ RUN-01';
  styled(
    subtitleEl,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.12em',
      'text-transform: uppercase',
    ].join(';'),
  );
  headerTitleWrap.appendChild(titleEl);
  headerTitleWrap.appendChild(subtitleEl);

  const closeBtn = makeButton('Close (S)', () => hide());
  header.appendChild(headerTitleWrap);
  header.appendChild(closeBtn);

  // ---- Body — scrollable container --------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 14px',
      'padding: 12px 16px 16px',
      'overflow-y: auto',
      'flex: 1 1 auto',
    ].join(';'),
  );

  // ---- Keybindings section ----------------------------------------------
  const kbSection = document.createElement('div');
  styled(kbSection, 'display: flex; flex-direction: column; gap: 6px');

  const kbHeading = document.createElement('div');
  styled(
    kbHeading,
    [
      'display: flex',
      'align-items: baseline',
      'justify-content: space-between',
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      'padding-bottom: 4px',
    ].join(';'),
  );
  const kbHeadingLabel = document.createElement('span');
  kbHeadingLabel.textContent = 'KEYBINDINGS';
  styled(
    kbHeadingLabel,
    [
      `color: ${ACCENT}`,
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const kbHeadingHint = document.createElement('span');
  kbHeadingHint.textContent = 'click rebind, then press a key';
  styled(
    kbHeadingHint,
    [
      `color: ${FG_DIM}`,
      'font-size: 9.5px',
      'letter-spacing: 0.1em',
      'text-transform: uppercase',
    ].join(';'),
  );
  kbHeading.appendChild(kbHeadingLabel);
  kbHeading.appendChild(kbHeadingHint);
  kbSection.appendChild(kbHeading);

  const kbTable = document.createElement('div');
  styled(
    kbTable,
    'display: flex; flex-direction: column; gap: 1px; margin-top: 4px',
  );
  kbSection.appendChild(kbTable);

  // Reset bindings button strip.
  const kbResetRow = document.createElement('div');
  styled(
    kbResetRow,
    [
      'display: flex',
      'justify-content: flex-end',
      'padding-top: 4px',
    ].join(';'),
  );
  const resetBtn = makeButton('Reset Bindings', () => {
    if (!window.confirm('Reset all keybindings to defaults?')) return;
    cancelCapture(); // belt-and-braces — Reset cancels any in-progress capture.
    resetBindingsToDefaults(deps.reg);
    rebuildKbTable();
  });
  kbResetRow.appendChild(resetBtn);
  kbSection.appendChild(kbResetRow);

  body.appendChild(kbSection);

  // ---- Save section -----------------------------------------------------
  const saveSection = document.createElement('div');
  styled(saveSection, 'display: flex; flex-direction: column; gap: 6px');

  const saveHeading = document.createElement('div');
  styled(
    saveHeading,
    [
      'display: flex',
      'align-items: baseline',
      'justify-content: space-between',
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      'padding-bottom: 4px',
    ].join(';'),
  );
  const saveHeadingLabel = document.createElement('span');
  saveHeadingLabel.textContent = 'SAVE';
  styled(
    saveHeadingLabel,
    [
      `color: ${ACCENT}`,
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const saveHeadingStatus = document.createElement('span');
  styled(
    saveHeadingStatus,
    [
      `color: ${FG_DIM}`,
      'font-size: 9.5px',
      'letter-spacing: 0.1em',
      'text-transform: uppercase',
    ].join(';'),
  );
  saveHeading.appendChild(saveHeadingLabel);
  saveHeading.appendChild(saveHeadingStatus);
  saveSection.appendChild(saveHeading);

  // Save-management button strip — wraps so a narrow viewport doesn't
  // overflow horizontally.
  const saveButtonStrip = document.createElement('div');
  styled(
    saveButtonStrip,
    [
      'display: flex',
      'flex-wrap: wrap',
      'gap: 6px',
      'padding-top: 6px',
    ].join(';'),
  );

  const exportBtn = makeButton('Export Save', async () => {
    try {
      const snapshot = serializeWorld(deps.world, deps.islandStates);
      const json = JSON.stringify(snapshot);
      await navigator.clipboard.writeText(json);
      window.alert(
        `Save exported to clipboard (${json.length} characters).`,
      );
    } catch (err) {
      // navigator.clipboard.writeText can reject (no permission, http://
      // origin, etc.). Surface the error so the user knows nothing was
      // copied — the clipboard contents are unchanged.
      console.warn('[robot-islands] export failed:', err);
      window.alert(
        'Export failed — clipboard write rejected. See console for details.',
      );
    }
  });
  saveButtonStrip.appendChild(exportBtn);

  // Hidden file input drives import. Keeping the visible button as the
  // primary affordance and routing it through the input keeps the styling
  // consistent with the rest of the panel.
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!isValidSaveSnapshot(parsed)) {
        window.alert(
          'Import failed — file is not a valid save snapshot for this version.',
        );
        importInput.value = '';
        return;
      }
      if (
        !window.confirm(
          'Import will overwrite the current save and reload the page. Continue?',
        )
      ) {
        importInput.value = '';
        return;
      }
      await importSave(parsed);
      window.location.reload();
    } catch (err) {
      console.warn('[robot-islands] import failed:', err);
      window.alert('Import failed — could not parse file. See console.');
      importInput.value = '';
    }
  });
  const importBtn = makeButton('Import Save', () => {
    importInput.click();
  });
  saveButtonStrip.appendChild(importBtn);
  saveButtonStrip.appendChild(importInput);

  const clearBtn = makeButton('Clear Save', () => {
    if (
      !window.confirm(
        'Clear the saved game and reload? This cannot be undone.',
      )
    )
      return;
    void clearSave().then(() => {
      window.location.reload();
    });
  });
  // Visually flag the destructive button — same WARN colour vocabulary used
  // by other modules' "danger" affordances.
  clearBtn.style.borderColor = WARN;
  clearBtn.style.color = WARN;
  saveButtonStrip.appendChild(clearBtn);

  saveSection.appendChild(saveButtonStrip);

  const saveNote = document.createElement('div');
  saveNote.textContent =
    'Export copies the full save as JSON to your clipboard. Import reads a JSON file and reloads. Rebound keys are NOT yet persisted across reloads.';
  styled(
    saveNote,
    [
      `color: ${FG_MUTED}`,
      'font-size: 10px',
      'letter-spacing: 0.02em',
      'line-height: 1.4',
      'padding-top: 4px',
      'font-style: italic',
    ].join(';'),
  );
  saveSection.appendChild(saveNote);
  body.appendChild(saveSection);

  // ---- Footer hint strip ------------------------------------------------
  const footer = document.createElement('div');
  styled(
    footer,
    [
      'padding: 7px 16px',
      `border-top: 1px solid ${PANEL_HEADER_BORDER}`,
      `background: ${STRIP_BG}`,
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'display: flex',
      'justify-content: space-between',
      'text-transform: uppercase',
    ].join(';'),
  );
  const footerL = document.createElement('span');
  footerL.textContent = 'S or esc to close · esc during capture cancels';
  const footerR = document.createElement('span');
  footerR.textContent = 'storage key · ' + STORAGE_KEY;
  footer.appendChild(footerL);
  footer.appendChild(footerR);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  parentEl.appendChild(scrim);
  parentEl.appendChild(panel);
  panel.style.display = 'none';

  // ---- Keybind table rendering ------------------------------------------

  /** Rebuild the keybindings table from `reg`. Called on show() and whenever
   *  a rebind changes the registry. The full rebuild keeps the bookkeeping
   *  simple — there's at most ~14 rows. */
  function rebuildKbTable(): void {
    kbTable.innerHTML = '';
    const rows = actionRows(deps.reg);
    for (const r of rows) {
      const row = document.createElement('div');
      styled(
        row,
        [
          'display: grid',
          'grid-template-columns: 1fr 1.2fr 100px',
          'align-items: center',
          'gap: 12px',
          'padding: 4px 8px',
          `border: 1px solid transparent`,
          'border-radius: 2px',
          'transition: background 80ms ease, border-color 80ms ease',
        ].join(';'),
      );

      const actionEl = document.createElement('span');
      actionEl.textContent = r.action;
      styled(
        actionEl,
        [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(
          ';',
        ),
      );

      const keysEl = document.createElement('span');
      keysEl.textContent =
        r.codes.length === 0 ? '(unbound)' : r.codes.join(' · ');
      styled(
        keysEl,
        [
          `color: ${r.codes.length === 0 ? FG_MUTED : FG_DIM}`,
          'font-size: 11px',
          'letter-spacing: 0.04em',
          'font-style: ' + (r.codes.length === 0 ? 'italic' : 'normal'),
        ].join(';'),
      );

      const rebindBtn = makeButton('Rebind', () => {
        beginCapture(r.action, row, keysEl);
      });
      // Make the per-row button narrow + flush right.
      rebindBtn.style.width = '100%';

      row.addEventListener('mouseenter', () => {
        if (captureAction !== r.action) row.style.background = ROW_BG_HOVER;
      });
      row.addEventListener('mouseleave', () => {
        if (captureAction !== r.action) row.style.background = '';
      });

      row.appendChild(actionEl);
      row.appendChild(keysEl);
      row.appendChild(rebindBtn);
      kbTable.appendChild(row);
    }
  }

  /** Enter capture mode for `action`. Installs a one-shot capture-phase
   *  keydown listener on window. Escape cancels; any other key is the new
   *  binding, subject to conflict-confirmation. */
  function beginCapture(
    action: string,
    rowEl: HTMLDivElement,
    keysEl: HTMLSpanElement,
  ): void {
    // Cancel any prior capture so we don't end up with stacked listeners.
    cancelCapture();
    captureAction = action;
    rowEl.style.background = CAPTURE_BG;
    rowEl.style.borderColor = WARN;
    keysEl.textContent = 'press a key…';
    keysEl.style.color = WARN;
    keysEl.style.fontStyle = 'italic';

    const handler = (e: KeyboardEvent): void => {
      // Capture-phase: we run before the global window keydown handler in
      // main.ts. preventDefault + stopPropagation block dispatchKey from
      // firing for the captured key.
      e.preventDefault();
      e.stopPropagation();
      // Escape during capture cancels — do NOT dispatch dismiss-modal.
      // (This is the only intentional `e.code` literal outside input.ts —
      // a hardcoded "Escape" string here is unavoidable because the user
      // hasn't yet authorised what key cancels capture. The task brief
      // calls this out as the allowed exception.)
      if (e.code === 'Escape') {
        cancelCapture();
        rebuildKbTable();
        return;
      }
      const result = applyCapturedKey(deps.reg, e.code, action, window.confirm);
      cancelCapture();
      rebuildKbTable();
      // Could surface `result.displacedAction` in the UI; window.confirm
      // already informed the user. Logging keeps the dev-console path useful.
      if (!result.applied) {
        console.info(
          `[settings-ui] rebind cancelled (would have displaced ${result.displacedAction ?? 'nothing'})`,
        );
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    captureListener = handler;
  }

  /** Tear down capture mode. Safe to call repeatedly. */
  function cancelCapture(): void {
    if (captureListener) {
      window.removeEventListener('keydown', captureListener, { capture: true });
      captureListener = null;
    }
    captureAction = null;
  }

  // ---- Refresh / show / hide --------------------------------------------

  /** Compute the human-friendly age string for the "Last saved" line. */
  function formatSavedAge(perfNow: number, savedAt: number | null): string {
    if (savedAt === null) return 'not yet saved';
    const ageSec = Math.max(0, Math.floor((perfNow - savedAt) / 1000));
    if (ageSec < 5) return 'just now';
    if (ageSec < 60) return `${ageSec}s ago`;
    const mins = Math.floor(ageSec / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ago`;
  }

  function refresh(): void {
    if (!visible) return;
    saveHeadingStatus.textContent =
      'last saved · ' + formatSavedAge(performance.now(), deps.getLastSavedAt());
  }

  function show(): void {
    if (visible) return;
    visible = true;
    panel.style.display = 'flex';
    scrim.style.display = 'block';
    rebuildKbTable();
    refresh();
  }
  function hide(): void {
    if (!visible) return;
    visible = false;
    cancelCapture();
    panel.style.display = 'none';
    scrim.style.display = 'none';
  }
  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }

  return {
    el: panel,
    refresh,
    show,
    hide,
    toggle,
    isVisible: () => visible,
  };
}
