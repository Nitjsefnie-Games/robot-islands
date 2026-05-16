// Config-driven keybinding registry.
//
// Two tables, separately mutable:
//   - `actions`: name → handler. Defined by the renderer / world; the input
//     system never invents an action, only dispatches.
//   - `bindings`: KeyboardEvent.code → action name. Pure data — swappable at
//     runtime. (UI for rebinding is not yet built, but the architecture
//     supports it: replacing bindings reroutes inputs without touching action
//     code.)
//
// `KeyboardEvent.code` is layout-independent ("KeyW" on QWERTY, AZERTY, Dvorak,
// etc.) so bindings remain stable across keyboard layouts.
//
// UI buttons reuse this same dispatcher: a "Toggle Grid" <button> simply calls
// `dispatchAction('toggle-grid', registry)` on click. Two inputs → one action
// → one handler. No drift between keyboard and mouse paths.

export type ActionName = string;
export type ActionHandler = () => void;

export interface InputRegistry {
  /** Action name → handler. Mutable: handlers can be replaced. */
  readonly actions: Map<ActionName, ActionHandler>;
  /** KeyboardEvent.code → action name. Mutable: rebindable at runtime. */
  readonly bindings: Map<string, ActionName>;
}

export function makeRegistry(): InputRegistry {
  return { actions: new Map(), bindings: new Map() };
}

export function defineAction(
  reg: InputRegistry,
  name: ActionName,
  handler: ActionHandler,
): void {
  reg.actions.set(name, handler);
}

export function bind(reg: InputRegistry, code: string, action: ActionName): void {
  reg.bindings.set(code, action);
}

export function unbind(reg: InputRegistry, code: string): void {
  reg.bindings.delete(code);
}

/**
 * Look up the action bound to a key code and run it. Returns true if an
 * action ran (caller can use this to decide whether to preventDefault).
 * Returns false if no binding exists or the binding points to an unknown
 * action.
 */
export function dispatchKey(reg: InputRegistry, code: string): boolean {
  const actionName = reg.bindings.get(code);
  if (actionName === undefined) return false;
  return dispatchAction(reg, actionName);
}

/** Trigger an action by name. UI buttons call this directly. */
export function dispatchAction(reg: InputRegistry, name: ActionName): boolean {
  const handler = reg.actions.get(name);
  if (!handler) return false;
  handler();
  return true;
}

/**
 * Default bindings table. Pan/zoom/center/grid actions wired to keys per
 * task: WASD (pan), +/- (zoom), H (center on home), G (toggle grid). The
 * pan actions are also wired to the arrow keys as a convenience.
 */
export function installDefaultBindings(reg: InputRegistry): void {
  // Full WASD pan (KeyD is pan-right). Toggle-grid moved to KeyG to free up
  // KeyD; rebinding is one-liner away if a user wants the inverse layout.
  //
  // KeyS is reserved for the settings panel — ArrowDown still pans south,
  // and a user who wants WASD-S-as-pan can rebind it from the settings UI.
  bind(reg, 'KeyW', 'pan-up');
  bind(reg, 'KeyA', 'pan-left');
  bind(reg, 'KeyD', 'pan-right');
  bind(reg, 'ArrowUp', 'pan-up');
  bind(reg, 'ArrowLeft', 'pan-left');
  bind(reg, 'ArrowDown', 'pan-down');
  bind(reg, 'ArrowRight', 'pan-right');
  bind(reg, 'KeyG', 'toggle-grid');
  bind(reg, 'KeyH', 'center-home');
  bind(reg, 'KeyK', 'toggle-skill-tree');
  bind(reg, 'KeyY', 'toggle-graph');
  // KeyB = Buildings (step 9 catalog modal). Sister panel to the skill
  // tree; both share the Escape dismissal action so users get one
  // consistent "close modal" key. The dispatch handler resolves which
  // modal is open and hides it — see `defineAction('dismiss-modal')`
  // wiring in main.ts.
  bind(reg, 'KeyB', 'toggle-buildings');
  // Escape dispatches a generic dismiss action; main.ts wires it to
  // close whichever modal is currently visible (skill tree OR buildings).
  bind(reg, 'Escape', 'dismiss-modal');
  // J = "journey/jet" — toggles the drone-ops side dock. Side panels don't
  // get an Escape binding (Escape is reserved for modal dismissal).
  bind(reg, 'KeyJ', 'toggle-drones');
  // R = routes — opens the freight-grid side dock (step 7).
  bind(reg, 'KeyR', 'toggle-routes');
  // C = construction — opens the artificial-island construction modal
  // (step 11). Same modal pattern as buildings + skill tree; Escape
  // dismisses via the shared `dismiss-modal` action wired in main.ts.
  bind(reg, 'KeyC', 'toggle-construction');
  // T = rotate the in-progress building placement (step 2.5). No-op when
  // not in placement mode; KeyR was already taken by toggle-routes so the
  // §4.2 rotation key migrated to T (mnemonic stretch but consistent with
  // common builder games' rotate-on-T convention — Cities: Skylines etc.).
  bind(reg, 'KeyT', 'rotate-placement');
  // V = vehicles — opens the settlement-ops side dock (step 12 / §12).
  // Sister panel to drones-ui + routes-ui; same side-dock idiom. No
  // Escape binding (Escape is reserved for modal dismissal).
  bind(reg, 'KeyV', 'toggle-settlement');
  // I = inventory — opens the full per-resource inventory modal (step 19).
  // The HUD only shows building counts + alarms now; the catalog table
  // moved here. Same modal pattern as buildings + skill tree; Escape
  // dismisses via the shared `dismiss-modal` action.
  bind(reg, 'KeyI', 'toggle-inventory');
  // S = settings — rebind UI + save management. Modal-pattern panel; the
  // shared `dismiss-modal` action (Escape) also closes it.
  bind(reg, 'KeyS', 'toggle-settings');
  // O = orbital — T6 satellite launch modal (§14.2-14.7).
  bind(reg, 'KeyO', 'toggle-orbital');
  bind(reg, 'Equal', 'zoom-in'); // '=' / '+' on US layouts
  bind(reg, 'NumpadAdd', 'zoom-in');
  bind(reg, 'Minus', 'zoom-out');
  bind(reg, 'NumpadSubtract', 'zoom-out');
}
