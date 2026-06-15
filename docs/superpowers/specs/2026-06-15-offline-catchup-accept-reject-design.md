# Offline catch-up: accept / reject — design

**Date:** 2026-06-15 · **Status:** approved (lightweight spec per owner)

## Goal

On a fresh connect after offline time, let the player **accept** or **reject** the
offline catch-up — a real tradeoff: offline time grants production + XP but burns
the §9.9 active-play bonus at 3×; rejecting forfeits the offline gains to keep the
bonus.

## Mechanic

On a fresh connect (page load / WS reconnect), if `now − savedAt > 0` (no
threshold — any gap prompts), the player MUST choose before normal play:

- **Accept** — run the normal catch-up (`loadAndCatchUp`) with
  `decayClosedGameActiveBonus: true`: production + XP + world-systems advance to
  `now`, and `activeBonusMs` decays by `ACTIVE_DECAY_RATIO × gap` (§9.9, 3×).
- **Reject** — forfeit the entire offline catch-up: stamp `lastTick`/`savedAt =
  now` with NO economy/systems integration and NO bonus decay (`activeBonusMs`
  preserved).

Either way the gap is consumed (`savedAt = now`) and play resumes.

## Server (authoritative, REMOTE)

- **Pending state** — per-connection `offlinePending` flag in `ws.ts`, set at
  connect when `now − savedAt > 0`. While set:
  - Send an `{ type: 'offline-pending', gapMs }` frame instead of the normal
    state push.
  - Serve the **pre-gap** projection: `projectSnapshotForClient(snapshot)`
    directly (NO catch-up) so the client shows the state as of `savedAt`.
  - **Block** normal intents: reply `{ ok:false, error:'resolve offline first' }`
    without running `applyIntent`.
- **Two intents:**
  - `offline/accept` → `loadAndCatchUp(client, userId, now, { decayActiveBonus:
    true })` (thread the opt through to `deserializeWorld`'s
    `decayClosedGameActiveBonus`), commit, clear flag.
  - `offline/reject` → new `runtime.ts` `loadAndSkipCatchUp(client, userId, now)`:
    load snapshot, build the live game WITHOUT advancing (deserialize only),
    stamp `savedAt`/`savedAtPerf`/per-island `lastTick = now`, do NOT decay the
    bonus, save, return. Commit, clear flag.
- Both run inside `withAccountTx` (advisory lock — same no-partial-persist
  guarantees as every other mutation).
- Multi-socket: a 2nd tab whose flag was set at its own connect may prompt after
  another tab resolved; resolving a now-~0 gap is a no-op (harmless).

## Client

- Boot/reconnect: on an `offline-pending` frame, show a modal:
  *"Away {duration} — [Accept offline progress (+production / +XP, −active
  bonus)] · [Keep active bonus (skip offline)]"*.
- Buttons send `offline/accept` / `offline/reject` via the mutation-gateway
  intent path. Dismiss on the resolving state push.
- LOCAL mode (debug fallback): keep today's auto-apply (no modal) — the choice is
  a server-account feature.

## Out of scope

- No threshold tuning UI; no "remember my choice"; no partial accept.

## Tests

- Server: accept applies catch-up + decays bonus by 3×gap; reject advances clock
  with no production/XP and bonus unchanged; normal intent while pending is
  blocked; both resolve the gap (`savedAt = now`).
- Pure: `loadAndSkipCatchUp` stamps clocks without integrating (no inventory/xp
  delta).

## SPEC.md

Update §9.9 (active-play bonus) with the accept/reject offline tradeoff, or add a
short §15.x sub-section cross-referencing §9.9 and Appendix C (server trust
surface). Code + spec ship together.
