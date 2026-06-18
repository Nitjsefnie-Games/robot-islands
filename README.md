# 🤖 Robot Islands

### You are a machine intelligence waking up alone on a single island. The ocean is endless. So is your ambition.

Robot Islands is a browser-based 2D idle game about **becoming a civilization**.
You start as one robot on one island — a handful of stone, some wood, a single
Foundation Kit. You end as a post-physics network mind rewriting the rules of
matter across an infinite world. Everything in between is yours to build.

> Discover islands. Settle them. Wire them together. Climb five tech tiers all
> the way to transcendence — and keep going, because the world never stops
> producing, even when you log off.

---

## 🌊 An ocean that never ends

The world is infinite and procedurally generated, yet every island, biome,
storm, and ocean trench is seed-deterministic under the hood — a world that
feels random to you and reproducible to the engine. Push drones past the
horizon. Float satellites overhead. Light a Lighthouse and watch a whole
region of the map snap into view. There is always one more island out there.

## ⚙️ Factories with real physics

This isn't "click a button, number goes up." Every island is a tiled
factory floor with footprints, rotation, and terrain rules. Buildings share
**heat** with their neighbours, scrub each other's exhaust, and poison each
other if you place reactors carelessly. Power grids **brown out** under load.
A continuous net-flow solver keeps thousand-step production chains correct in
real time — and resolves *exactly* even after a 24-hour offline catch-up.

From raw ore to steel, copper, aluminium, oil, petrochemicals, glass,
electronics, and the exotic T5 materials of the endgame: the full chain is
there to be optimized.

## 🚀 From rowboats to orbit

- **Drones** (T1–T6) scout the unknown — cheap biofuel scouts to long-range
  weather-rugged explorers.
- **Ships and helicopters** carry Foundation Kits to plant new colonies.
- **Routes** — cargo, drone, airship, mass-driver, teleporter, power cable —
  stitch your islands into one logistics web with priority dispatch you can
  drag to reorder.
- **Satellites** take it orbital: scanners, sweepers, relays, store-and-forward
  comms, debris fields, Kessler cascades, and repair drones.

## 🌳 A skill tree with real depth

~357 nodes. Five branches. Twenty sub-paths. Filler chains, hand-curated
notables, gated keystones, threshold-bridges that unlock as you invest, and
auras that amplify everything around them. Pick a node and the game
pathfinds the cheapest route of skill points to reach it.

## 🌌 An endgame that bends reality

Reach Tier 5 and the toys stop being subtle: **Time Lock** banks and spends
time itself, the **Omniscient Lattice** fuses your islands into one shared
mind, the **Reality Forge** rewrites buildings into eternal servitors, the
**Universe Editor** reassigns biomes, and the **Genesis Chamber** creates
matter from nothing. Forge the three great artifacts — the Genesis Cell, the
Omniscient Lattice, the Ascendant Core — and ascend to Tier 6 and the stars.

There's no win screen. There's no ceiling. There's just the next island.

## 🏝️ A world that lives while you're away

Weather forecasts and storms. A day–night cycle. Six biomes and an ocean
floor of shallows, trenches, nodule fields, and hydrothermal vents. Trade
offers, island merging, terrain modifiers, an active-play bonus, and a
guided tutorial to ease you in. Close the tab and your empire keeps working;
come back to a pile of resources and decisions waiting.

---

## ▶️ Play it

```bash
npm install
npm run dev        # vite dev server on http://localhost:5173
```

Open the URL and you're in. The game boots online (server-authoritative) by
default — add `?server=0` to play fully offline in your browser.

Building for production:

```bash
npm run build      # tsc -b && vite build
npm run preview    # serve the built bundle
```

---

## 🛠️ Under the hood

Robot Islands is **server-authoritative**: the browser is a slick display +
intent-sender, while the `server/` workspace owns every byte of authoritative
state and re-runs the pure game rules to validate each move. Intents fly over a
WebSocket channel; validated state streams back. Prefer to tinker offline? The
LOCAL mode runs the identical rules client-side against IndexedDB. Both paths
funnel through one **mutation-gateway** seam, so they can never drift apart.

The codebase rigorously separates **pure simulation math** from **PixiJS
rendering** — ~123 single-responsibility modules with ~107 colocated test
files, all targeting the renderer-free core. That's why a thousand-building
economy is fully testable without ever drawing a pixel.

**Client:** Vite 5 · TypeScript (strict) · PixiJS 8 · vitest — no framework,
hand-built UI.
**Server:** Fastify 5 · Postgres · TypeScript strict via `tsx` — cookie auth,
per-IP rate limiting, a hardened WebSocket transport, and SQL migrations.

### Running the server

```bash
cd server
cp .env.example .env       # configure DATABASE_URL
npm install
npx tsx src/migrate.ts     # apply migrations (needs Postgres)
npx tsx src/index.ts       # serve API + WebSocket + /health
```

### Tests

```bash
npm test                   # client + server vitest projects (server needs Postgres)
npx vitest run src/economy.test.ts                       # one file
npx vitest run -t "Mine fills iron_ore to exactly cap"   # one test
```

---

## 📚 For contributors

`SPEC.md` is the locked, section-by-section source of truth — code and spec
move together, always. `AGENTS.md` carries the architecture and conventions;
`CONTRIBUTING.md` defines the workflow: small fixes land straight on `master`,
features go branch → PR → rebase, and history stays **linear** (rebase and
fast-forward, never merge commits).

---

<p align="center"><em>One island. Infinite ocean. Build the network.</em></p>
