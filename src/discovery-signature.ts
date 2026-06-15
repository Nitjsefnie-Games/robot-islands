// World-layer rebuild gate — pure fingerprint of the visual state.
//
// `discoverySignature` hashes only the fields that change the baked GPU
// textures in `renderIsland` / `renderBuildings` (world.ts / buildings.ts):
// island population/discovered flags, ellipse geometry, terrain modifiers and
// tile overrides, and per-building defId + position + rotation. It deliberately
// excludes non-visual fields such as forceRun, paused, cargoLabel, anchorIslandId
// and the construction boolean so those toggles do not churn the GPU layers.
//
// Extracted from main.ts so the rebuild gate is unit-testable without importing
// the render bootstrap.

import type { IslandSpec, WorldState } from './world.js';

function extraEllipsesDigest(
  extras: NonNullable<IslandSpec['extraEllipses']>,
): string {
  return extras
    .map((e) => `${e.major},${e.minor},${e.rotation ?? 0},${e.offsetX},${e.offsetY}`)
    .join(';');
}

function tileOverridesDigest(
  overrides: IslandSpec['tileOverrides'],
): string {
  if (!overrides) return '-';
  const entries = Object.entries(overrides);
  if (entries.length === 0) return '-';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join(';');
}

/** Cheap fingerprint of the world-layer-relevant state for REMOTE/LOCAL
 *  rebuild gating: discovered-island count + revealed-cell count +
 *  depth-revealed-cell count PLUS a structural fingerprint of every island's
 *  rendered geometry (buildings + terrain modifiers + populated/discovered
 *  flags + ellipse radii + tile overrides).
 *
 *  `renderIsland` draws building sprites and terrain tiles, so a building
 *  placed / demolished / moved / upgraded, an island expanded/merged, or a
 *  terrain-modifier/tile-override change must repaint. The ocean feature-glyph
 *  layer (refreshed inside `rebuildWorldLayers`) is gated by both
 *  `revealedCells` and `depthRevealedCells`; omitting `depthRevealedCells.size`
 *  caused depth-scout reveals on already-surface-revealed cells to skip the
 *  repaint (#78, #83).
 *
 *  Non-visual fields such as forceRun, paused, cargoLabel, anchorIslandId and
 *  the construction boolean are intentionally excluded — they affect
 *  overlays/economy, not the baked world-layer texture. */
export function discoverySignature(worldState: WorldState): string {
  let discovered = 0;
  const parts: string[] = [];
  for (const s of worldState.islands) {
    if (s.discovered) discovered++;
    const extras = s.extraEllipses && s.extraEllipses.length > 0
      ? extraEllipsesDigest(s.extraEllipses)
      : '-';
    let seg = `${s.id}:${s.populated ? 1 : 0}:${s.discovered ? 1 : 0}:` +
      `${s.majorRadius},${s.minorRadius}:${extras}:` +
      `${s.modifiers.join(',') || '-'}:${tileOverridesDigest(s.tileOverrides)}#`;
    for (const b of s.buildings) {
      seg += `${b.id}@${b.x},${b.y}/${b.rotation ?? 0}:${b.defId};`;
    }
    parts.push(seg);
  }
  return `${discovered}|${worldState.revealedCells.size}|${worldState.depthRevealedCells.size}|${parts.join('|')}`;
}
