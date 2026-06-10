/**
 * Economy tick cadence — the server-migration seam.
 *
 * The client advances the economy at a fixed 5 Hz cadence instead of once
 * per render frame. The integrator (`advanceIsland`, §15.3) is event-driven
 * over arbitrary dt — a 200 ms advance is the same code path as a 24 h
 * offline catch-up — so the cadence is purely a wiring choice in main.ts's
 * ticker. It lives here, named and isolated, because this constant is the
 * line a future authoritative server takes over (TODO.md "Current TODO"
 * item 3): the server ticks at `ECONOMY_TICK_MS` (or lazily) and the client
 * becomes display + intent-sender.
 *
 * Pure module — no PixiJS, no DOM, no globals. Tested in
 * `economy-clock.test.ts`.
 */
export const ECONOMY_TICK_MS = 200;

/**
 * Gate: should the economy advance this frame?
 *
 * - First frame (`lastTickMs === null`) ticks immediately, so retained
 *   per-tick outputs (HUD rate maps etc.) are populated before any consumer
 *   reads them.
 * - Otherwise ticks once at least `tickMs` has elapsed since the last tick.
 * - A long gap (tab blur, long frame, offline catch-up) produces ONE
 *   advance whose dt is the whole gap: the caller stamps
 *   `lastTickMs = nowMs` after ticking and `advanceIsland` integrates the
 *   full interval — there is no catch-up loop of fixed 200 ms steps.
 */
export function shouldTick(
  nowMs: number,
  lastTickMs: number | null,
  tickMs: number = ECONOMY_TICK_MS,
): boolean {
  if (lastTickMs === null) return true;
  return nowMs - lastTickMs >= tickMs;
}
