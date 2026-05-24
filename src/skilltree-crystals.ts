import type { CrystalDef, CrystalId } from './skilltree-graph.js';
import type { SubPathId } from './skilltree.js';

function cid(id: string): CrystalId {
  return id as CrystalId;
}

function miningCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseYield = 0.16;
  const baseTrickle = 0.10;
  const baseFiller = 0.04;

  return {
    id: cid(`mining_crystal_t${tier}`),
    displayName: `Mining Crystal T${tier}`,
    tier,
    eligibleSubPaths: ['mining' as SubPathId],
    nodes: [
      {
        idSuffix: 'core',
        cost: 3 * tier,
        magnitude: baseYield * scale,
        effect: { kind: 'mineYieldBonusMul' },
        description: `Mine yield bonus (+${Math.round(baseYield * scale * 100)}%)`,
        position: { dx: 0, dy: 40 },
      },
      {
        idSuffix: 'left1',
        cost: 1 * tier,
        magnitude: baseFiller * scale,
        effect: { kind: 'mineYieldBonusMul' },
        description: `Minor mine yield bonus (+${Math.round(baseFiller * scale * 100)}%)`,
        position: { dx: -30, dy: 20 },
      },
      {
        idSuffix: 'left2',
        cost: 1 * tier,
        magnitude: baseTrickle * scale,
        effect: { kind: 'mineRareTrickleMul' },
        description: `Mine rare trickle bonus (+${Math.round(baseTrickle * scale * 100)}%)`,
        position: { dx: -50, dy: 40 },
      },
      {
        idSuffix: 'right1',
        cost: 1 * tier,
        magnitude: baseFiller * scale,
        effect: { kind: 'mineYieldBonusMul' },
        description: `Minor mine yield bonus (+${Math.round(baseFiller * scale * 100)}%)`,
        position: { dx: 30, dy: 20 },
      },
      {
        idSuffix: 'right2',
        cost: 1 * tier,
        magnitude: baseTrickle * scale,
        effect: { kind: 'mineRareTrickleMul' },
        description: `Mine rare trickle bonus (+${Math.round(baseTrickle * scale * 100)}%)`,
        position: { dx: 50, dy: 40 },
      },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'core', cost: 0 },
      { fromSuffix: 'socket', toSuffix: 'left1', cost: 1 * tier },
      { fromSuffix: 'left1', toSuffix: 'left2', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right1', cost: 1 * tier },
      { fromSuffix: 'right1', toSuffix: 'right2', cost: 1 * tier },
    ],
  };
}

export const CRYSTAL_CATALOG: ReadonlyArray<CrystalDef> = [
  miningCrystal(1, 1),
  miningCrystal(2, 1.5),
  miningCrystal(3, 2.25),
];
