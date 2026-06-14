# Slice 5 — Trust-surface hardening: finding & conclusion

**Date:** 2026-06-14
**Status:** Security objective MET by the slices 1–4 architecture; residual is code-health/product (tracked).
**Part of:** the server-authoritative migration (TODO.md), slice 5 of 5.

---

## TL;DR

TODO.md's hardening note (written *before* slices 1–4) predicted: *"the pervasive
`as unknown as` readonly-mutation casts and the trade/XP paths become the
sensitive trust surface once state crosses a network boundary."* An independent
audit of the finished codebase finds that prediction **largely already
addressed** by the server-authoritative cutover. The security objective of slice
5 is met; what remains is **code-health and one product gap**, neither
security-critical.

## What the audit found

1. **`as unknown as` casts (152 total; 78 in production files):**
   - **~52 in `persistence.ts`** — migration-chain plumbing (e.g.
     `migrateV7toV8(snapshot as unknown as SerializedSnapshotV7) as unknown as SaveSnapshot`).
     TS can't track the version discriminant across the reassigned `snapshot`
     through the chain, so each step is cast.
   - **5 in `main.ts`** — client UI/debug plumbing (`window.__cam` scaffold; an
     `orbitalUi` internal-property access).
   - A handful of branded-type bridges in `skilltree-*`.
   - **Zero in `economy.ts`, `trade.ts`, `recipes.ts`, or any server handler.**
   - **The anticipated "mutate a readonly field by casting it mutable on
     security-relevant state" pattern does not materially exist in production.**
     These casts are **code-health / type-safety**, not an anti-cheat surface:
     none execute on the server's trust boundary; a bad migration cast is a
     migration-correctness risk (covered by migration tests), not a forgeable
     client input.

2. **XP path — already server-authoritative.** XP flows only through
   `accrueXp` (`economy.ts`), called once, from `advanceIsland` (the server's
   tick). `gain` derives from server-computed production × the static
   `XP_WEIGHT` table; the `xpGain` multiplier comes from server-side unlocked
   skill nodes. `levelUpIfReady` runs only in `advanceIsland`. **The client has
   no path to forge `xp`/`level`/`unspentSkillPoints`.** The only XP-adjacent
   client action is the `unlock-skill-node` intent, which slice 3 validates by
   re-running the pure unlock on authoritative state.

3. **Trade path — no server-trust hole.** `applyOffer` re-clamps quantities
   against authoritative give-stock + output headroom and grants no XP.
   `accept-trade` is intentionally **unwired** server-side (offers are
   runtime-only/unpersisted), so the server cannot be tricked into a trade —
   the gap is that players can't trade yet (a **product gap**, tracked as #15),
   not a security hole. `tradeCooldownMs`/`tradeAcceptCount` live in persisted
   island state the server owns.

## Conclusion

The migration's anti-cheat objective — **the server owns all state and validates
every mutation by re-running the pure rules; the client cannot forge state** — is
achieved and was reviewed across slices 1–4 (no anti-cheat holes found; the one
found, the create-route populated check, was fixed). Slice 5's trust-surface
hardening is therefore **substantively complete at the security level.**

## Residual (defense-in-depth / product — NOT security-critical; tracked)

- **Type the `persistence.ts` migration chain** (replace the ~50 migration
  `as unknown as` casts with proper per-version typed intermediates — the
  `SerializedSnapshotV7..V23` types already exist). Code-health: lets the type
  checker catch a missing migration field that today only migration *tests*
  catch. Medium-large, mechanical-but-fiddly; deliberately NOT rushed at the end
  of this session (a subtle migration regression is a data risk). **Tracked.**
- **Wire `accept-trade` via server-deterministic offers** (#15): server
  re-derives the current offer from `(worldSeed, islandId, tradeAcceptCount)` via
  `generateOffer`; client sends only `islandId`. Completes the trade feature in
  the server-authoritative path. Medium. **Tracked.**
- **`main.ts` `orbitalUi` internal-property cast** — indicates a missing exported
  member on the orbital-UI type; tiny fix. **Tracked.**

These are listed in TODO.md and the task list. None blocks the security goal.
