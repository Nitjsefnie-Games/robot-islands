// Regenerate the world map paths embedded in src/map-picker.ts.
//
// Both layers derive from a single Natural Earth 1:110m dataset (world-atlas
// `countries-110m`, public domain) so coastline and country borders align by
// construction:
//   • land fill  = topojson.merge(all country geometries)  → dissolved union
//   • borders    = topojson.mesh(countries, a≠b)           → interior borders
//
// Projected to the map-picker's 360×180 plate-carrée viewBox via d3-geo,
// whose default antimeridian clipping correctly splits rings crossing ±180°
// (Chukotka/Aleutians) and closes pole-enclosing rings (Antarctica):
//   geoEquirectangular().scale(180/π).translate([180,90])
//     lon −180→x0, +180→x360 ; lat 90→y0, −90→y180  (matches clickToLatLon)
//
// Output: JSON { land, borders } (space-separated, 1-decimal SVG path d
// strings) written to /tmp/map-paths.json. The splice step pastes them as
// WORLD_SVG_PATH and BORDERS_SVG_PATH in map-picker.ts.
//
// Usage:  node scripts/gen-map-path.mjs   (writes /tmp/map-paths.json)
//
// Requires the d3-geo + topojson-client devDependencies and (first run)
// network access to fetch the dataset (cached to /tmp).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { merge, mesh } from 'topojson-client';

const CACHE = '/tmp/countries-110m.json';
const URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

let raw;
if (existsSync(CACHE)) {
  raw = readFileSync(CACHE, 'utf8');
} else {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`fetch ${URL} → HTTP ${res.status}`);
  raw = await res.text();
  writeFileSync(CACHE, raw);
}

const topo = JSON.parse(raw);
const countries = topo.objects.countries;

const land = merge(topo, countries.geometries);
const borders = mesh(topo, countries, (a, b) => a !== b);

const projection = geoEquirectangular()
  .scale(180 / Math.PI)
  .translate([180, 90]);

// Custom context: round to 1 decimal and emit the space-separated "M x y"
// format the picker's regression tests parse (geoPath's default emits
// comma-separated full-precision coords — both larger and test-incompatible).
const r1 = (n) => (Math.round(n * 10) / 10).toString();
function toPath(geom) {
  let d = '';
  const ctx = {
    moveTo(x, y) { d += `M${r1(x)} ${r1(y)}`; },
    lineTo(x, y) { d += `L${r1(x)} ${r1(y)}`; },
    closePath() { d += 'Z'; },
    arc() {},
  };
  geoPath(projection, ctx)(geom);
  return d;
}

const out = { land: toPath(land), borders: toPath(borders) };
writeFileSync('/tmp/map-paths.json', JSON.stringify(out));
process.stderr.write(`[gen-map-path] land ${out.land.length} chars, borders ${out.borders.length} chars\n`);
