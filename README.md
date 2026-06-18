# Robot Islands

A browser-based 2D idle game. You play a self-expanding industrial robot
intelligence growing across an infinite world of discrete islands —
discovering, settling, and networking them into a production empire that
climbs through five technology tiers and into post-physics transcendence.

The world is procedurally generated and seed-deterministic: from the player's
view it's an endless ocean of random islands; under the hood every island,
biome, ocean feature, and weather roll is reproducible from a seed. Islands
keep producing while you're away, so each return is a fresh round of
decisions — spend skill points, redirect production chains, found new
colonies, and push drones and satellites into the unknown.

---

## Gameplay at a glance

- **Develop islands.** Place buildings on tiled island terrain with real
  footprints, rotation, and terrain requirements. Plan adjacency for heat
  sharing, exhaust scrubbing, and reactor toxicity. Manage storage caps,
  maintenance, and a construction queue with running slots and floor upgrades.
- **Run production chains.** A deep T0–T5 resource catalog (raws,
  intermediates, components) feeds recipe chains for iron/steel, copper,
  aluminium, oil and petrochemicals, glass, electronics, mechanical and power
  components, and the T4/T5 endgame materials. The economy runs an
  event-driven piecewise integrator with a continuous net-flow solver, so
  producer→consumer chains stay correct and offline catch-up over many hours
  resolves exactly.
- **Power the grid.** Per-island electrical grids brown out under load, heat
  flows M:N between adjacent buildings, and cables link islands into shared
  power components — including a Singularity Battery that buffers surplus into
  deficits.
- **Explore and expand.** Dispatch drones (T1–T6) to scan for islands, then
  settle them with ships and helicopters carrying a Foundation Kit. Vision
  sources, Lighthouses, and orbital satellites also reveal the map. Build
  artificial islands and reclaim land to grow your footprint.
- **Network the world.** Connect islands with cargo, drone, airship,
  mass-driver, teleporter, and cable routes, with priority-list dispatch and
  drag-to-reorder. Reach Network Consciousness milestones for global
  production buffs and auto-patronage.
- **Climb the skill tree.** A ~357-node mixed graph across five branches and
  twenty sub-paths — filler chains, hand-curated notables, keystones,
  threshold-bridges, and amplifying auras. Purchases pathfind the cheapest
  skill-point route and auto-own intermediates.
- **Reach the endgame.** Tier breakpoints gate progression to T5 (Time Lock,
  Lattice Node, Reality Forge, Universe Editor, Genesis Chamber, Probability
  Engine, Eternal Servitors) and T6 orbital play (Spaceport, satellites,
  communication networks, debris and Kessler cascades, repair drones). Craft
  the three endgame artifacts — Genesis Cell, Omniscient Lattice, Ascendant
  Core — and keep going; the game continues indefinitely.
- **Living world.** Biomes, weather forecasts and storms, a day–night cycle,
  ocean terrain (shallows, trenches, nodule fields, hydrothermal vents),
  trade offers, island merging, an active-play production bonus, and a
  guided tutorial.

---

## Architecture

The codebase strictly separates **pure simulation math** from **PixiJS
rendering**, so every game system is testable without a renderer.

- **Pure layer** (no PixiJS) — the large majority of `src/`: all game systems
  (`economy.ts`, `recipes.ts`, `placement.ts`, `drones.ts`, `routes.ts`, the
  `skilltree-*` family, `weather.ts`, `orbital.ts`, `lattice.ts`,
  `vision-source.ts`, …) plus `camera.ts` and `input.ts`. Tests target this
  layer.
- **Render layer** (imports `pixi.js`) — `main.ts`, `ocean.ts`,
  `buildings.ts`, `grid.ts`, the `*-ui.ts` panels, the `*-overlay.ts` map
  overlays, and the routes/skilltree renderers. Render code reads state; it
  never owns it.

One responsibility per file: ~123 production modules in `src/` (one mechanic
or system each) alongside ~107 colocated `*.test.ts` files. Pure systems are
named for their mechanic, DOM/Pixi panels end in `-ui.ts`, and map overlays
end in `-overlay.ts`.

### Server-authoritative play

Robot Islands runs **server-authoritative** by default. The browser is a
display + intent-sender; the `server/` workspace owns all authoritative state
and persistence for accounts and re-runs the pure rules to validate every
mutation.

- **REMOTE** (default) — intents flow to the server over a WebSocket channel;
  the server validates, advances the authoritative simulation, and pushes
  state back.
- **LOCAL** — a client-only IndexedDB mode for offline/debug play, selectable
  with `?server=0` or `localStorage.setItem('ri_server','0')`.

Mutations pass through a single **mutation-gateway** seam: REMOTE turns them
into WS intents, LOCAL calls the pure layer directly — so both paths share the
exact same rules.

### Coordinate systems

Tiles are the unit (`TILE_PX = 24`). World pixels = `tile × TILE_PX`; screen
pixels = `world_px × zoom + camera offset`. `IslandSpec` holds the static
`readonly` definition (terrain, ellipse, building positions); `IslandState`
holds the mutable runtime (inventory, XP, level, lastTick).

### Input registry

Every key goes through a registry in `input.ts` (`actions` + `bindings`, keyed
on `KeyboardEvent.code` for layout independence). UI buttons reuse the same
dispatcher, so keyboard and mouse paths never drift — WASD/arrows pan, +/-
zoom, and a toggle key per panel (buildings, construction, inventory, drones,
skill tree, routes, settlement, and more).

---

## Tech stack

**Client** (`src/`): Vite 5 · TypeScript (strict, `noUncheckedIndexedAccess`)
· PixiJS 8 · vitest. No framework — the UI is hand-built DOM + Pixi.

**Server** (`server/`): Fastify 5 · Postgres · TypeScript strict, run directly
through the `tsx` loader. Cookie auth with per-IP rate limiting, a WebSocket
intent transport with frame-size caps and `permessage-deflate`, and SQL
migrations under `server/migrations/`.

---

## Getting started

### Client

```bash
npm install
npm run dev        # vite dev server on 0.0.0.0:5173 (HMR)
npm run build      # tsc -b && vite build
npm run preview    # serve the built dist/
```

Open the printed URL. The client boots in REMOTE mode against the server;
append `?server=0` to the URL to play in LOCAL mode without a server.

### Server

```bash
cd server
cp .env.example .env          # set DATABASE_URL etc.
npm install
npm run typecheck             # strict typecheck (with tests)
npx tsx src/migrate.ts        # apply SQL migrations
npx tsx src/index.ts          # run the API + WebSocket server
```

A Postgres instance is required. The server exposes auth routes, game routes,
the WebSocket intent channel, and a `/health` check. Deployment notes and a
systemd unit live in `server/deploy/`.

---

## Testing

```bash
npm test                      # both client and server vitest projects
npx vitest run src/economy.test.ts          # a single file
npx vitest run -t "Mine fills iron_ore to exactly cap"   # a single test
```

`npm test` runs two vitest projects — `client` and `server`. The `server`
project connects to a real Postgres (default `postgresql:///robot_islands_test`),
runs migrations, and exercises the authoritative rules end-to-end, so a
running Postgres is a prerequisite for the full suite. Client-only tests need
no database. Server-only commands:

```bash
cd server
npx tsc --noEmit              # build typecheck (excludes tests)
npm run typecheck             # typecheck including tests
npm test                      # server vitest only
```

---

## Repository layout

```
src/                 client: pure game systems + render/UI layer (+ colocated tests)
  test-helpers/      shared test utilities
  fixtures/          persistence and snapshot fixtures
server/              Fastify + Postgres authoritative backend
  src/               app, db, auth, game routes, WebSocket transport, migrations runner
  migrations/        SQL schema migrations
  deploy/            systemd unit + deployment README
docs/                design specs and engineering reports
SPEC.md              the locked, section-by-section game specification (source of truth)
AGENTS.md            architecture and conventions for contributors
CONTRIBUTING.md      integration tracks and linear-history workflow
TODO.md              working punch list
```

---

## Source of truth & contributing

`SPEC.md` is the locked specification — the authoritative description of every
mechanic, organised by section. Code and spec move together: any behaviour
change updates the relevant `SPEC.md` section in the same change.

`CONTRIBUTING.md` defines the workflow. Small, self-contained changes commit
directly to `master`; new features and large or risky changes go on a feature
branch, are reviewed via PR, then rebased and fast-forwarded. Either way
`master` stays green and keeps a **linear history** — integrate by rebasing
and fast-forwarding, never with merge commits. `AGENTS.md` carries the deeper
architecture notes and coding conventions.
