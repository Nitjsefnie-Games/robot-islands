import { ensureCellGenerated } from './src/world.js';
import type { WorldState } from './src/world.js';

const world: WorldState = {
  islands: [],
  drones: [],
  routes: [],
  vehicles: [],
  revealedCells: new Set(),
  seed: '0',
  satellites: [],
  repairDrones: [],
  debrisFields: [],
  endgameState: { achieved: new Set(), firstAchievedMs: null },
  latticeActive: false,
  latticeNodeIslands: [],
  islandStates: new Map(),
  commPackets: [],
  totalCo2Kg: 0,
  playerLat: null,
  playerLon: null,
  oceanCells: new Map(),
  depthRevealedCells: new Set(),
  recentBuildAttempts: new Set(),
  recentBuildAttemptTs: new Map(),
} as WorldState;

const r = 400;
const CELL_SIZE = 16;
const cMinX = Math.floor(-r / CELL_SIZE);
const cMaxX = Math.floor(r / CELL_SIZE);
const cMinY = Math.floor(-r / CELL_SIZE);
const cMaxY = Math.floor(r / CELL_SIZE);

const t0 = Date.now();
let cellCount = 0;
let islandCount = 0;
for (let cy = cMinY; cy <= cMaxY; cy++) {
  for (let cx = cMinX; cx <= cMaxX; cx++) {
    const newSpecs = ensureCellGenerated(world, cx, cy);
    islandCount += newSpecs.length;
    cellCount++;
  }
}
const elapsed = Date.now() - t0;
console.log(`Cells: ${cellCount}, Islands generated: ${islandCount}, Time: ${elapsed}ms`);
