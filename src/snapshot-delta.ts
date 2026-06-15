// src/snapshot-delta.ts
//
// Pure delta codec for the authoritative `SaveSnapshot` (SPEC §3 / Appendix C).
// REMOTE clients are display-only, so the server re-pushes the full world every
// ~1 s for production to appear to advance. A real mid-game snapshot is ~230 KiB
// and >90 % of it is slowly-changing structure (building lists, island geometry,
// ocean cells, skill unlocks) that is identical tick-to-tick. This module lets
// the server send only what changed since the last frame it sent on a socket,
// and the client merge it back into the previous snapshot.
//
// Encoding — a recursive merge-patch (RFC-7386-flavoured) with reserved marker
// keys so it stays unambiguous on JSON values that can themselves be `null`,
// arrays, or objects:
//   - `{ __set: v }`  → replace this key's value wholesale (primitive, an array
//     that is NOT a keyed collection, or a type change).
//   - `{ __del: true }` → delete this key.
//   - `{ __keyed: true, u?, a?, d?, o? }` → a KEYED-ARRAY patch (see below).
//   - any other object → a nested object patch: recurse and merge per key.
// The reserved keys `__set` / `__del` / `__keyed` never occur as real snapshot
// field names (field names + resource ids only), so markers can't collide.
//
// Keyed-array diffing is the crux of the size win. Several hot arrays are
// collections of objects with a stable unique string `id` — most importantly
// each island's `buildings` (and `world.islands` itself). Per tick EVERY
// operating building accrues `operatingMs` (duty-cycle wear), so a naive
// wholesale-array replace would resend the entire ~38 KiB building list every
// second. Instead, an array whose every element is a plain object with a unique
// string `id` is diffed BY ID: `u` (per-id recursive sub-patch), `a` (added
// elements, full), `d` (removed ids), `o` (the next id-order, only when it
// changed). A building whose only change is `operatingMs` then carries just that
// one number. Arrays that are not id-keyed (e.g. `revealedCells` strings,
// `oceanCells` `[key, cell]` tuples) fall back to wholesale `__set`, which is
// correct and cheap since they change rarely.
//
// `islandStates` (a positional `{ id, state }` array) is diffed by id at the top
// level too (`isUpd` / `isAdd` / `isDel`), with each `state` merge-patched.

import type {
  SaveSnapshot,
  SerializedWorld,
  SerializedIslandState,
  SerializedIslandStateEntry,
} from './persistence.js';

// ---------------------------------------------------------------------------
// JSON value helpers
// ---------------------------------------------------------------------------

type JsonObject = { [key: string]: unknown };

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural equality for JSON-safe values (no Dates/Maps/cycles — snapshots
 *  are already JSON). Used to decide whether a value changed at all. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!jsonEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Merge-patch core
// ---------------------------------------------------------------------------

interface SetMarker { readonly __set: unknown }
interface DelMarker { readonly __del: true }
/** A patch for an array of objects keyed by a unique string `id`. */
interface KeyedArrayPatch {
  readonly __keyed: true;
  /** id → recursive sub-patch for elements present in both. */
  readonly u?: { [id: string]: Patch };
  /** Full elements added (not in prev), in their `next` order. */
  readonly a?: ReadonlyArray<unknown>;
  /** ids removed (in prev, not in next). */
  readonly d?: ReadonlyArray<string>;
  /** The full id-order of `next`, present only when the surviving-plus-appended
   *  natural order differs from it (a reorder). */
  readonly o?: ReadonlyArray<string>;
}
/** A nested object patch: key → sub-patch. */
type ObjectPatch = { [key: string]: Patch };
export type Patch = SetMarker | DelMarker | KeyedArrayPatch | ObjectPatch;

function isSet(p: Patch): p is SetMarker {
  return isPlainObject(p) && Object.prototype.hasOwnProperty.call(p, '__set');
}
function isDel(p: Patch): p is DelMarker {
  return isPlainObject(p) && Object.prototype.hasOwnProperty.call(p, '__del');
}
function isKeyed(p: Patch): p is KeyedArrayPatch {
  return isPlainObject(p) && (p as { __keyed?: unknown }).__keyed === true;
}

/** Read an element's `id` when it is a plain object with a string id, else null. */
function elementId(v: unknown): string | null {
  if (!isPlainObject(v)) return null;
  const id = v['id'];
  return typeof id === 'string' ? id : null;
}

/** True when `v` is a non-empty array whose every element is a plain object with
 *  a UNIQUE string `id` — the shape that earns by-id element diffing. */
function isKeyedArray(v: unknown): v is ReadonlyArray<JsonObject> {
  if (!Array.isArray(v) || v.length === 0) return false;
  const ids = new Set<string>();
  for (const el of v) {
    const id = elementId(el);
    if (id === null || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function arraysEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Diff two id-keyed arrays into a {@link KeyedArrayPatch}. Caller guarantees
 *  both pass {@link isKeyedArray}. */
function diffKeyedArray(prev: ReadonlyArray<JsonObject>, next: ReadonlyArray<JsonObject>): KeyedArrayPatch {
  const prevById = new Map(prev.map((e) => [e['id'] as string, e]));
  const nextIds = new Set(next.map((e) => e['id'] as string));
  const u: { [id: string]: Patch } = {};
  const a: unknown[] = [];
  for (const e of next) {
    const id = e['id'] as string;
    const pe = prevById.get(id);
    if (pe === undefined) { a.push(e); continue; }
    const sub = diffValue(pe, e);
    if (sub !== NOCHANGE) u[id] = sub;
  }
  const d: string[] = [];
  for (const e of prev) {
    const id = e['id'] as string;
    if (!nextIds.has(id)) d.push(id);
  }
  const naturalOrder = [
    ...prev.map((e) => e['id'] as string).filter((id) => nextIds.has(id)),
    ...a.map((e) => (e as JsonObject)['id'] as string),
  ];
  const nextOrder = next.map((e) => e['id'] as string);
  const patch: {
    __keyed: true;
    u?: { [id: string]: Patch };
    a?: unknown[];
    d?: string[];
    o?: string[];
  } = { __keyed: true };
  if (Object.keys(u).length > 0) patch.u = u;
  if (a.length > 0) patch.a = a;
  if (d.length > 0) patch.d = d;
  if (!arraysEqual(naturalOrder, nextOrder)) patch.o = nextOrder;
  return patch;
}

/** Apply a {@link KeyedArrayPatch} to a previous array value. */
function applyKeyedArray(prev: unknown, patch: KeyedArrayPatch): unknown[] {
  const byId = new Map<string, unknown>(
    (Array.isArray(prev) ? prev : []).flatMap((e) => {
      const id = elementId(e);
      return id === null ? [] : [[id, e] as [string, unknown]];
    }),
  );
  if (patch.d) for (const id of patch.d) byId.delete(id);
  if (patch.u) {
    for (const id of Object.keys(patch.u)) {
      const cur = byId.get(id);
      if (cur !== undefined) byId.set(id, applyPatch(cur, patch.u[id]!));
    }
  }
  if (patch.a) for (const e of patch.a) { const id = elementId(e); if (id !== null) byId.set(id, e); }
  let result = [...byId.values()];
  if (patch.o) {
    const m = new Map<string, unknown>(result.map((e) => [elementId(e)!, e]));
    result = patch.o.flatMap((id) => (m.has(id) ? [m.get(id)] : []));
  }
  return result;
}

/** Sentinel returned by `diffValue` when nothing changed (cannot appear in a
 *  JSON patch, so it is safe to compare by identity). */
const NOCHANGE = Symbol('nochange');

/** Diff two JSON values into a {@link Patch}, or NOCHANGE when equal. Objects
 *  recurse; everything else (primitive, array, type mismatch) is `__set`. */
function diffValue(prev: unknown, next: unknown): Patch | typeof NOCHANGE {
  if (jsonEqual(prev, next)) return NOCHANGE;
  if (isKeyedArray(prev) && isKeyedArray(next)) {
    return diffKeyedArray(prev, next);
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const patch: ObjectPatch = {};
    for (const k of Object.keys(next)) {
      if (!Object.prototype.hasOwnProperty.call(prev, k)) {
        patch[k] = { __set: next[k] };
        continue;
      }
      const sub = diffValue(prev[k], next[k]);
      if (sub !== NOCHANGE) patch[k] = sub;
    }
    for (const k of Object.keys(prev)) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) patch[k] = { __del: true };
    }
    return patch;
  }
  return { __set: next };
}

/** Apply a {@link Patch} to a previous JSON value, returning a new value. The
 *  input is never mutated. */
function applyPatch(prev: unknown, patch: Patch): unknown {
  if (isSet(patch)) return patch.__set;
  if (isKeyed(patch)) return applyKeyedArray(prev, patch);
  if (isDel(patch)) return undefined; // handled by caller; top-level del is nonsensical
  const base: JsonObject = isPlainObject(prev) ? { ...prev } : {};
  for (const k of Object.keys(patch)) {
    const sub = patch[k]!;
    if (isDel(sub)) {
      delete base[k];
      continue;
    }
    base[k] = applyPatch(base[k], sub);
  }
  return base;
}

/** True when a per-island state patch carries ONLY the always-advancing clock
 *  field (`lastTick`) and nothing the player can observe — the signal the server
 *  uses to stay silent on an idle socket instead of pushing a no-op frame. */
function isOnlyClock(patch: Patch): boolean {
  if (isSet(patch) || isDel(patch)) return false;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((k) => k === 'lastTick');
}

// ---------------------------------------------------------------------------
// Snapshot delta
// ---------------------------------------------------------------------------

/** A wire-frame describing the change from one snapshot to the next. `savedAt`/
 *  `savedAtPerf` are always present (the client's clock anchor). `world` is a
 *  merge-patch of the world object; `isUpd`/`isAdd`/`isDel` reconcile the
 *  islandStates array by id. Absent fields mean "unchanged". */
export interface SnapshotDelta {
  readonly v?: number;
  readonly savedAt: number;
  readonly savedAtPerf: number;
  readonly world?: ObjectPatch;
  readonly isUpd?: ReadonlyArray<{ readonly id: string; readonly patch: Patch }>;
  readonly isAdd?: ReadonlyArray<SerializedIslandStateEntry>;
  readonly isDel?: ReadonlyArray<string>;
}

export interface SnapshotDeltaResult {
  readonly delta: SnapshotDelta;
  /** False when the only differences are clock advancement (`savedAt`,
   *  `savedAtPerf`, per-island `lastTick`). The server skips emitting in that
   *  case so an idle socket goes silent. */
  readonly substantive: boolean;
}

/** Compute the delta from `prev` to `next`. */
export function computeSnapshotDelta(prev: SaveSnapshot, next: SaveSnapshot): SnapshotDeltaResult {
  const delta: {
    v?: number;
    savedAt: number;
    savedAtPerf: number;
    world?: ObjectPatch;
    isUpd?: Array<{ id: string; patch: Patch }>;
    isAdd?: SerializedIslandStateEntry[];
    isDel?: string[];
  } = { savedAt: next.savedAt, savedAtPerf: next.savedAtPerf };
  let substantive = false;

  if (prev.v !== next.v) {
    delta.v = next.v;
    substantive = true;
  }

  const worldPatch = diffValue(prev.world, next.world);
  if (worldPatch !== NOCHANGE) {
    delta.world = worldPatch as ObjectPatch;
    substantive = true;
  }

  const prevById = new Map(prev.islandStates.map((e) => [e.id, e.state]));
  const nextIds = new Set(next.islandStates.map((e) => e.id));
  const upd: Array<{ id: string; patch: Patch }> = [];
  const add: SerializedIslandStateEntry[] = [];
  for (const e of next.islandStates) {
    const prevState = prevById.get(e.id);
    if (prevState === undefined) {
      add.push(e);
      substantive = true;
      continue;
    }
    const patch = diffValue(prevState, e.state);
    if (patch !== NOCHANGE) {
      upd.push({ id: e.id, patch });
      if (!isOnlyClock(patch)) substantive = true;
    }
  }
  const del: string[] = [];
  for (const e of prev.islandStates) {
    if (!nextIds.has(e.id)) {
      del.push(e.id);
      substantive = true;
    }
  }

  if (upd.length > 0) delta.isUpd = upd;
  if (add.length > 0) delta.isAdd = add;
  if (del.length > 0) delta.isDel = del;

  return { delta, substantive };
}

/** Reconstruct the next snapshot by applying `delta` to `prev`. `prev` is never
 *  mutated. Inverse of {@link computeSnapshotDelta} (assuming islandStates keep
 *  their relative order, which `serializeWorld` guarantees). */
export function applySnapshotDelta(prev: SaveSnapshot, delta: SnapshotDelta): SaveSnapshot {
  const world = delta.world
    ? (applyPatch(prev.world, delta.world) as SerializedWorld)
    : prev.world;

  let islandStates: ReadonlyArray<SerializedIslandStateEntry> = prev.islandStates;
  if (delta.isUpd || delta.isAdd || delta.isDel) {
    const byId = new Map(prev.islandStates.map((e) => [e.id, e.state]));
    if (delta.isDel) for (const id of delta.isDel) byId.delete(id);
    if (delta.isUpd) {
      for (const u of delta.isUpd) {
        const cur = byId.get(u.id);
        if (cur !== undefined) byId.set(u.id, applyPatch(cur, u.patch) as SerializedIslandState);
      }
    }
    if (delta.isAdd) for (const a of delta.isAdd) byId.set(a.id, a.state);
    islandStates = [...byId].map(([id, state]) => ({ id, state }));
  }

  return {
    v: (delta.v ?? prev.v) as SaveSnapshot['v'],
    savedAt: delta.savedAt,
    savedAtPerf: delta.savedAtPerf,
    world,
    islandStates,
  };
}
