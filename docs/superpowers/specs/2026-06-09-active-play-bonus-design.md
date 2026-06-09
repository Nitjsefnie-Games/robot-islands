# Active-Play Production Bonus — Design

**Date:** 2026-06-09
**Status:** approved (brainstormed with user; approach A selected)
**SPEC.md anchor:** new §9.9 (to be added at implementation)

## Problem / intent

Trading (§9.8) already rewards active presence: trade cooldowns burn down
only while the tab is visible AND focused. The user wants a second
active-play reward with a different shape: a slow, global production buff
that grows while the player is present and decays when they leave —
nudging continuous engaged sessions without making offline play pointless.

## Decision summary (user-confirmed)

| Question | Decision |
|-|-|
| Accrual rate | **+0.1% recipe rate per focused minute**, all recipes, all islands |
| Focus condition | Same as trades: `document.visibilityState === 'visible' && document.hasFocus()` |
| On focus loss | **Decay at −0.3%/min** (3× accrual rate), floor at 0 — leaky bucket, not a hard reset |
| While game closed | Decay continues on wall-clock time, applied at load from snapshot `savedAt` |
| Cap | **None** — decay is the only counterweight |
| UI | HUD economy-panel row + inspector recipe-bonuses line entry |
| Persistence | Yes — schema v21 → v22 |

## Architecture (approach A: world-level accumulator, frame-sampled multiplier)

### State

- `WorldState.activeBonusMs: number` — balance of "effective focused
  milliseconds", `>= 0`, unbounded above.
- Derived bonus fraction: `activeBonusMs / 60_000 * ACTIVE_BONUS_PER_MIN`
  where `ACTIVE_BONUS_PER_MIN = 0.001` (+0.1%/min).
- Multiplier: `activeBonusMul = 1 + fraction`.

### Accrual / decay — pure module `src/active-bonus.ts`

One unified rule: **focused frame-dt accrues (clamped); every other
wall-clock millisecond decays at `ACTIVE_DECAY_RATIO = 3`×.**

Per ticker frame (`online` = the `tradeOnline` boolean main.ts already
computes; `frameDt` = wall-clock ms since last frame):

```
accrued       = online ? min(frameDt, ONLINE_DT_CAP_MS) : 0   // cap = 3000, reused from trade.ts
activeBonusMs = max(0, activeBonusMs + accrued - 3 * (frameDt - accrued))
```

This single formula covers every loss mode:

- **Blurred but visible** — rAF keeps firing; each frame's full dt decays.
- **Hidden tab / minimized** — rAF stops; the gap arrives as one large
  `frameDt` on the refocus frame. Accrual clamps to 3 s; the remainder
  decays. (Same clamp trade uses so a gap can't dump time.)
- **Game closed** — at load, run the same formula with `online = false`
  and `frameDt = now - snapshot.savedAt`, BEFORE offline catch-up runs.

Module exports: `tickActiveBonus(world, online, frameDtMs)` (mutates
`world.activeBonusMs`), `activeBonusMul(world): number`, plus the two
constants. No PixiJS imports — pure layer, fully testable.

### Economy integration

- New `RatesContext.activeBonusMul?: number` (default 1) — same extension
  pattern as `ncBuff` (economy.ts:119-122).
- Multiplied into the recipe-rate product at the same two sites as
  `ncBuff` (economy.ts ~1075 and ~1110), so it applies to every recipe's
  throughput. XP accrues on boosted production automatically (same as
  fledgling / NC buffs).
- Sampled once per `advanceIsland` call as a constant. The value drifts
  0.1% per minute, so treating it as constant within a frame (or one
  offline-catchup call) introduces negligible error and leaves §15.3's
  constant-rate piecewise integration untouched (approach B — exact
  time-varying integration — was rejected as invisible precision at real
  complexity cost).
- Scope difference from `ncBuff`: `ncBuff` is per-island (networked T3+
  only); `activeBonusMul` is world-level and applies to **every** island.
  main.ts threads it into all five RatesContext build sites.

### Persistence (v21 → v22, bump = migrate)

1. `SerializedSnapshotV21` type alias for the previous shape.
2. `migrateV21toV22(s)` — adds `activeBonusMs: 0`.
3. Wire into `loadWorld`'s migration chain; add 21 to
   `SUPPORTED_LOAD_VERSIONS`.
4. At load (after migration): apply closed-gap decay from `savedAt` as
   above, before offline catch-up advances islands.

### UI

- **HUD** (`hud.ts`): an "Active bonus" key/value row in the economy
  panel near the trade-countdown row, always visible. Value: `+X.X%`
  (one decimal), `—` when 0. World-level, so identical across islands.
- **Inspector** (`inspector-ui.ts`): recipe-panel bonuses line appends
  `active ×1.032`-style entry when the multiplier > 1, alongside
  `fledgling ×…` / skill entries.

### SPEC.md

New §9.9 "Active-Play Production Bonus": rule, rates (+0.1%/min focused,
−0.3%/min otherwise including closed, floor 0, no cap), focus condition
shared with §9.8 trading, frame-sampled multiplier note, persistence.

## Testing (pure layer only, per repo convention)

- `active-bonus.test.ts`: accrues focused dt; clamps a single frame's
  accrual at 3 s; decays blurred dt at 3×; refocus-gap charges
  `3 × (gap − 3 s)`; floors at 0; `activeBonusMul` math; load-decay
  helper math.
- `economy.test.ts`: `activeBonusMul` in RatesContext scales recipe rate
  and XP; absent → behavior identical to today (default 1).
- `persistence.test.ts`: v21 fixture loads with `activeBonusMs: 0`; v22
  round-trips identity; load-decay applied from `savedAt`.

## Balance notes

- +6%/h focused; a 10 h marathon = +60%. Decay −18%/h unfocused; any
  realistic balance is gone after a few hours away (overnight ⇒ 0), so in
  practice it is a same-session / same-day mechanic despite persistence.
- Focused-but-idle farming is accepted (same accepted limit as trade's
  online-time: "covered but focused" isn't JS-detectable).
