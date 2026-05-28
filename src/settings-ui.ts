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
// STILL-DEFERRED to keep this step's surface small.
//
// `e.code` exception: per AGENTS.md "No hardcoded `e.code === 'KeyW'`
// checks anywhere outside `input.ts`" — the capture handler READS `e.code`
// to record what the user pressed, it does not DISPATCH on it. That's the
// allowed exception called out in the task brief.

import {
  bind,
  dispatchAction,
  installDefaultBindings,
  unbind,
  type InputRegistry,
} from './input.js';
import {
  clearPrefs,
  clearSave,
  isValidSaveSnapshot,
  importSave,
  saveWorld,
  serializeWorld,
  STORAGE_KEY_DISPLAY,
} from './persistence.js';
import { showMapPicker } from './map-picker.js';
import { mountModal } from './ui-modal.js';
import type { IslandState } from './economy.js';
import type { WorldState } from './world.js';

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
  // The capture keydown listener registered on window. Reference is held so
  // we can remove it cleanly when capture exits.
  let captureListener: ((e: KeyboardEvent) => void) | null = null;

  // Mutable refs to elements that need updating after mount.
  const kbTbody = document.createElement('tbody');
  const saveHeadingStatus = document.createElement('span');

  function makeButton(
    label: string,
    onClick: () => void,
    extraClasses = '',
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'ri-btn' + (extraClasses ? ' ' + extraClasses : '');
    b.addEventListener('click', () => {
      onClick();
      b.blur();
    });
    return b;
  }

  const handle = mountModal(parentEl, {
    title: 'SETTINGS',
    subtitle: '/ RUN-01',
    onClose: () => handle.hide(),
    buildBody(body) {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '14px';

      // ---- Keybindings section --------------------------------------------
      const kbSection = document.createElement('div');
      kbSection.style.display = 'flex';
      kbSection.style.flexDirection = 'column';
      kbSection.style.gap = '6px';

      const kbHeading = document.createElement('div');
      kbHeading.style.display = 'flex';
      kbHeading.style.alignItems = 'baseline';
      kbHeading.style.justifyContent = 'space-between';
      kbHeading.style.paddingBottom = '4px';
      kbHeading.style.borderBottom = '1px solid var(--ri-rule)';

      const kbHeadingLabel = document.createElement('span');
      kbHeadingLabel.textContent = 'KEYBINDINGS';
      kbHeadingLabel.className = 'ri-caps';
      kbHeadingLabel.style.color = 'var(--ri-accent)';
      kbHeading.appendChild(kbHeadingLabel);

      const kbHeadingHint = document.createElement('span');
      kbHeadingHint.textContent = 'click rebind, then press a key';
      kbHeadingHint.className = 'ri-muted';
      kbHeadingHint.style.fontSize = '9.5px';
      kbHeadingHint.style.letterSpacing = '0.1em';
      kbHeadingHint.style.textTransform = 'uppercase';
      kbHeading.appendChild(kbHeadingHint);

      kbSection.appendChild(kbHeading);

      const kbTable = document.createElement('table');
      kbTable.className = 'ri-table';
      kbTable.appendChild(kbTbody);
      kbSection.appendChild(kbTable);

      const kbResetRow = document.createElement('div');
      kbResetRow.style.display = 'flex';
      kbResetRow.style.justifyContent = 'flex-end';
      kbResetRow.style.paddingTop = '4px';
      const resetBtn = makeButton('Reset Bindings', () => {
        if (!window.confirm('Reset all keybindings to defaults?')) return;
        cancelCapture(); // belt-and-braces — Reset cancels any in-progress capture.
        resetBindingsToDefaults(deps.reg);
        rebuildKbTable();
      });
      kbResetRow.appendChild(resetBtn);
      kbSection.appendChild(kbResetRow);

      body.appendChild(kbSection);

      // ---- UI Layout section (window-manager) -----------------------------
      const uiSection = document.createElement('div');
      uiSection.style.display = 'flex';
      uiSection.style.flexDirection = 'column';
      uiSection.style.gap = '6px';

      const uiHeading = document.createElement('div');
      uiHeading.style.display = 'flex';
      uiHeading.style.alignItems = 'baseline';
      uiHeading.style.justifyContent = 'space-between';
      uiHeading.style.paddingBottom = '4px';
      uiHeading.style.borderBottom = '1px solid var(--ri-rule)';

      const uiHeadingLabel = document.createElement('span');
      uiHeadingLabel.textContent = 'UI LAYOUT';
      uiHeadingLabel.className = 'ri-caps';
      uiHeadingLabel.style.color = 'var(--ri-accent)';
      uiHeading.appendChild(uiHeadingLabel);

      const uiHeadingHint = document.createElement('span');
      uiHeadingHint.textContent = 'drag headers · resize from bottom-right';
      uiHeadingHint.className = 'ri-muted';
      uiHeadingHint.style.fontSize = '9.5px';
      uiHeadingHint.style.letterSpacing = '0.1em';
      uiHeadingHint.style.textTransform = 'uppercase';
      uiHeading.appendChild(uiHeadingHint);

      uiSection.appendChild(uiHeading);

      const uiResetRow = document.createElement('div');
      uiResetRow.style.display = 'flex';
      uiResetRow.style.justifyContent = 'flex-end';
      uiResetRow.style.paddingTop = '4px';
      const uiResetBtn = makeButton('Reset Window Layout', () => {
        if (!window.confirm('Reset every panel to its default position and size?')) return;
        dispatchAction(deps.reg, 'reset-ui-layout');
      });
      uiResetRow.appendChild(uiResetBtn);
      uiSection.appendChild(uiResetRow);

      const uiNote = document.createElement('div');
      uiNote.textContent =
        'Window positions and sizes are saved per-browser (localStorage). Resetting clears all saved layouts and restores the default docked positions.';
      uiNote.className = 'ri-muted';
      uiNote.style.fontSize = '10px';
      uiNote.style.lineHeight = '1.4';
      uiNote.style.paddingTop = '4px';
      uiNote.style.fontStyle = 'italic';
      uiSection.appendChild(uiNote);

      body.appendChild(uiSection);

      // ---- Location section -------------------------------------------------
      const locSection = document.createElement('div');
      locSection.style.display = 'flex';
      locSection.style.flexDirection = 'column';
      locSection.style.gap = '6px';

      const locHeading = document.createElement('div');
      locHeading.style.display = 'flex';
      locHeading.style.alignItems = 'baseline';
      locHeading.style.justifyContent = 'space-between';
      locHeading.style.paddingBottom = '4px';
      locHeading.style.borderBottom = '1px solid var(--ri-rule)';

      const locHeadingLabel = document.createElement('span');
      locHeadingLabel.textContent = 'LOCATION';
      locHeadingLabel.className = 'ri-caps';
      locHeadingLabel.style.color = 'var(--ri-accent)';
      locHeading.appendChild(locHeadingLabel);

      locSection.appendChild(locHeading);

      const locBtnRow = document.createElement('div');
      locBtnRow.style.display = 'flex';
      locBtnRow.style.justifyContent = 'flex-end';
      locBtnRow.style.paddingTop = '4px';
      const changeLocationBtn = makeButton('Change location', () => {
        showMapPicker({
          current: deps.world.playerLat != null && deps.world.playerLon != null
            ? { lat: deps.world.playerLat, lon: deps.world.playerLon }
            : null,
          onPick: (lat, lon) => {
            deps.world.playerLat = lat;
            deps.world.playerLon = lon;
            void saveWorld(deps.world, deps.islandStates);
          },
          onCancel: () => { /* no-op */ },
        });
      });
      locBtnRow.appendChild(changeLocationBtn);
      locSection.appendChild(locBtnRow);

      body.appendChild(locSection);

      // ---- Save section -----------------------------------------------------
      const saveSection = document.createElement('div');
      saveSection.style.display = 'flex';
      saveSection.style.flexDirection = 'column';
      saveSection.style.gap = '6px';

      const saveHeading = document.createElement('div');
      saveHeading.style.display = 'flex';
      saveHeading.style.alignItems = 'baseline';
      saveHeading.style.justifyContent = 'space-between';
      saveHeading.style.paddingBottom = '4px';
      saveHeading.style.borderBottom = '1px solid var(--ri-rule)';

      const saveHeadingLabel = document.createElement('span');
      saveHeadingLabel.textContent = 'SAVE';
      saveHeadingLabel.className = 'ri-caps';
      saveHeadingLabel.style.color = 'var(--ri-accent)';
      saveHeading.appendChild(saveHeadingLabel);

      saveHeadingStatus.className = 'ri-muted';
      saveHeadingStatus.style.fontSize = '9.5px';
      saveHeadingStatus.style.letterSpacing = '0.1em';
      saveHeadingStatus.style.textTransform = 'uppercase';
      saveHeading.appendChild(saveHeadingStatus);

      saveSection.appendChild(saveHeading);

      // Save-management button strip — wraps so a narrow viewport doesn't
      // overflow horizontally.
      const saveButtonStrip = document.createElement('div');
      saveButtonStrip.style.display = 'flex';
      saveButtonStrip.style.flexWrap = 'wrap';
      saveButtonStrip.style.gap = '6px';
      saveButtonStrip.style.paddingTop = '6px';

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

      const clearBtn = makeButton(
        'Clear Save',
        () => {
          if (
            !window.confirm(
              'Clear the saved game and reload? This cannot be undone.',
            )
          )
            return;
          void Promise.all([clearSave(), clearPrefs()]).then(() => {
            window.location.reload();
          });
        },
        'ri-btn--danger',
      );
      saveButtonStrip.appendChild(clearBtn);

      saveSection.appendChild(saveButtonStrip);

      const saveNote = document.createElement('div');
      saveNote.textContent =
        'Export copies the full save as JSON to your clipboard. Import reads a JSON file and reloads. Rebound keys are NOT yet persisted across reloads.';
      saveNote.className = 'ri-muted';
      saveNote.style.fontSize = '10px';
      saveNote.style.lineHeight = '1.4';
      saveNote.style.paddingTop = '4px';
      saveNote.style.fontStyle = 'italic';
      saveSection.appendChild(saveNote);

      body.appendChild(saveSection);
    },
    buildFooter(footer) {
      const footerL = document.createElement('span');
      footerL.textContent = 'S or esc to close · esc during capture cancels';
      footerL.className = 'ri-muted';
      const footerR = document.createElement('span');
      footerR.textContent = 'storage key · ' + STORAGE_KEY_DISPLAY;
      footerR.className = 'ri-muted';
      footer.prepend(footerL);
      footer.appendChild(footerR);
    },
  });

  // ---- Keybind table rendering ------------------------------------------

  /** Rebuild the keybindings table from `reg`. Called on show() and whenever
   *  a rebind changes the registry. The full rebuild keeps the bookkeeping
   *  simple — there's at most ~14 rows. */
  function rebuildKbTable(): void {
    kbTbody.innerHTML = '';
    const rows = actionRows(deps.reg);
    for (const r of rows) {
      const tr = document.createElement('tr');

      const actionEl = document.createElement('td');
      actionEl.textContent = r.action;
      actionEl.className = 'ri-table__name';

      const keysEl = document.createElement('td');
      keysEl.textContent =
        r.codes.length === 0 ? '(unbound)' : r.codes.join(' · ');
      if (r.codes.length === 0) {
        keysEl.style.color = 'var(--ri-fg-4)';
        keysEl.style.fontStyle = 'italic';
      } else {
        keysEl.style.color = 'var(--ri-fg-3)';
      }

      const btnTd = document.createElement('td');
      const rebindBtn = makeButton('Rebind', () => {
        beginCapture(r.action, tr, keysEl);
      });
      rebindBtn.style.width = '100%';
      btnTd.appendChild(rebindBtn);

      tr.appendChild(actionEl);
      tr.appendChild(keysEl);
      tr.appendChild(btnTd);
      kbTbody.appendChild(tr);
    }
  }

  /** Enter capture mode for `action`. Installs a one-shot capture-phase
   *  keydown listener on window. Escape cancels; any other key is the new
   *  binding, subject to conflict-confirmation. */
  function beginCapture(
    action: string,
    tr: HTMLTableRowElement,
    keysEl: HTMLTableCellElement,
  ): void {
    // Cancel any prior capture so we don't end up with stacked listeners.
    cancelCapture();
    tr.style.background = 'var(--ri-pressed)';
    keysEl.textContent = 'press a key…';
    keysEl.style.color = 'var(--ri-warn)';
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
    if (!handle.isVisible()) return;
    saveHeadingStatus.textContent =
      'last saved · ' + formatSavedAge(performance.now(), deps.getLastSavedAt());
  }

  function show(): void {
    if (handle.isVisible()) return;
    handle.show();
    rebuildKbTable();
    refresh();
  }
  function hide(): void {
    if (!handle.isVisible()) return;
    cancelCapture();
    handle.hide();
  }
  function toggle(): boolean {
    if (handle.isVisible()) hide();
    else show();
    return handle.isVisible();
  }

  return {
    el: handle.el,
    refresh,
    show,
    hide,
    toggle,
    isVisible: handle.isVisible,
  };
}
