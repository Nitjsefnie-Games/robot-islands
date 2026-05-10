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
  bind(reg, 'KeyW', 'pan-up');
  bind(reg, 'KeyA', 'pan-left');
  bind(reg, 'KeyS', 'pan-down');
  bind(reg, 'KeyD', 'pan-right');
  bind(reg, 'ArrowUp', 'pan-up');
  bind(reg, 'ArrowLeft', 'pan-left');
  bind(reg, 'ArrowDown', 'pan-down');
  bind(reg, 'ArrowRight', 'pan-right');
  bind(reg, 'KeyG', 'toggle-grid');
  bind(reg, 'KeyH', 'center-home');
  bind(reg, 'Equal', 'zoom-in'); // '=' / '+' on US layouts
  bind(reg, 'NumpadAdd', 'zoom-in');
  bind(reg, 'Minus', 'zoom-out');
  bind(reg, 'NumpadSubtract', 'zoom-out');
}
