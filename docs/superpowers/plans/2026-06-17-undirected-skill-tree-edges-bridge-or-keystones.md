# Undirected Skill-Tree Edges + Bridge-OR Keystones Implementation Plan

> **For agentic workers:** Use direct execution in this session (Kimi Code CLI) or dispatch focused subagents per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-keystone skill-tree edges traversable in both directions, and allow keystones to be unlocked either through their existing AND-prereq path or through an active threshold-bridge.

**Architecture:** Keep the existing Dijkstra pathing engine but build bidirectional adjacency for standard edges and bridges. Preserve keystone AND-prereqs by treating any edge that touches a keystone as directed-only in its original direction, except bridges *into* keystones which provide the new OR path. Update the graphview click handler and server intent so keystones fall back to the bridge path when AND prereqs are not met.

**Tech Stack:** TypeScript strict, Vite 5, vitest, PixiJS 8 (graphview only), Fastify 5 server.

## Global Constraints

- `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — new code must compile clean.
- Every behavior change updates `SPEC.md` in the same commit.
- Client tests are pure-layer only; server tests hit a real Postgres via `DATABASE_URL=postgresql:///robot_islands_test`.
- Default commit style: conventional commits with `Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>`.
- Linear history: commit directly to `master` for this size of change.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/skilltree.ts` | Pure skill-tree engine: `costToUnlock`, `buyNode`, `nodePurchaseStatus`, `canBuyKeystone`, `buyKeystone`. |
| `src/skilltree-graphview.ts` | PixiJS graph overlay + click handler. Decides `buyKeystone` vs `buyNode` for keystones. |
| `src/mutation-gateway.ts` | LOCAL gateway seam for `unlockSkillNode` / `buyKeystone`. |
| `server/src/game/intents.ts` | REMOTE authoritative intent handlers for `unlock-skill-node` and `buy-keystone`. |
| `src/skilltree.test.ts` | Unit tests for pure skill-tree logic. |
| `src/skilltree-integration.test.ts` | Integration tests for buy paths. |
| `server/src/game/intents.test.ts` | Server intent tests against real Postgres. |
| `SPEC.md` | Source-of-truth spec update for §9.3. |

---

### Task 1: Make `costToUnlock` adjacency bidirectional with keystone protection

**Files:**
- Modify: `src/skilltree.ts:1584-1678`
- Test: `src/skilltree.test.ts`

**Interfaces:**
- Consumes: `Graph` (nodes, edges, bridges), `IslandState`, `isBridgeActive`, `depthTierEligible`, `stateT6Unlocked`, `KEYSTONE_TARGET_NODE_IDS`.
- Produces: `costToUnlock` returns a cheapest path that may traverse edges in reverse, and may end at a keystone if reached through a bridge.

- [ ] **Step 1: Add a node-cost lookup map at the top of `costToUnlock`**

```typescript
const nodeCostById = new Map<NodeId, number>();
for (const n of graph.nodes) nodeCostById.set(n.id as NodeId, n.cost);
```

- [ ] **Step 2: Replace the directed adjacency loop with a bidirectional one**

Old block (lines 1606-1622):

```typescript
for (const e of allEdges) {
  if (e.mode === 'and') continue;
  if (KEYSTONE_TARGET_NODE_IDS.has(String(e.to))) continue;
  const toDepth = nodeDepth.get(e.to as NodeId);
  if (toDepth !== undefined && !depthTierEligible(state.level, toDepth, t6)) continue;
  const list = adjacency.get(e.from as NodeId) ?? [];
  list.push(e);
  adjacency.set(e.from as NodeId, list);
}
```

New block:

```typescript
function addDirectedStep(from: NodeId, to: NodeId, edge: Edge, cost: number): void {
  const toDepth = nodeDepth.get(to);
  if (toDepth !== undefined && !depthTierEligible(state.level, toDepth, t6)) return;
  const step = { ...edge, from, to, cost } as Edge;
  const list = adjacency.get(from) ?? [];
  list.push(step);
  adjacency.set(from, list);
}

for (const e of allEdges) {
  // AND-prereq edges are purchase gates, never traversable.
  if (e.mode === 'and') continue;

  const fromId = e.from as NodeId;
  const toId = e.to as NodeId;
  const fromIsKeystone = KEYSTONE_TARGET_NODE_IDS.has(String(fromId));
  const toIsKeystone = KEYSTONE_TARGET_NODE_IDS.has(String(toId));
  const isBridge = e.mode === 'or';

  // Forward direction (original edge) is allowed when the destination is not
  // a keystone, OR when the edge is a bridge into a keystone.
  if (!toIsKeystone || isBridge) {
    addDirectedStep(fromId, toId, e, e.cost);
  }

  // Reverse direction is allowed only for non-keystone endpoints. Bridges out
  // of keystones are blocked so a keystone cannot be used to bypass another
  // keystone's AND-prereqs, and keystone-owned notables cannot back-fill their
  // own prereqs through the keystone.
  if (!fromIsKeystone && !toIsKeystone) {
    const reverseCost = isBridge ? e.cost : (nodeCostById.get(fromId) ?? e.cost);
    addDirectedStep(toId, fromId, e, reverseCost);
  }
}
```

- [ ] **Step 3: Write a failing test for walking down a filler chain**

Add to `src/skilltree.test.ts` in the `costToUnlock` / `buyNode` describe block:

```typescript
it('walks down a filler chain when a deeper node is already owned', () => {
  const state = makeState({ level: 50, unspentSkillPoints: 100 });
  const target = 'mining.recipeRate.3' as NodeId;
  state.unlockedNodes.add(target);
  state.unlockedNodes.add('mining.recipeRate.2' as NodeId);

  const shallower = 'mining.recipeRate.1' as NodeId;
  const result = costToUnlock(DEFAULT_GRAPH, state.unlockedNodes, state.unlockedEdges, state, shallower);
  expect(result).not.toBeNull();
  expect(result!.totalCost).toBe(1); // depth-1 node cost

  buyNode(DEFAULT_GRAPH, state, shallower);
  expect(state.unlockedNodes.has(shallower)).toBe(true);
  expect(state.unspentSkillPoints).toBe(99);
});
```

- [ ] **Step 4: Run the new test and confirm it fails**

```bash
npx vitest run src/skilltree.test.ts -t "walks down a filler chain"
```

Expected: FAIL — `costToUnlock` returns null because adjacency is directed.

- [ ] **Step 5: Implement the change and run the test again**

Apply Step 2, then:

```bash
npx vitest run src/skilltree.test.ts -t "walks down a filler chain"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/skilltree.ts src/skilltree.test.ts
git commit -m "feat(skilltree): bidirectional adjacency in costToUnlock" -m "Allow walking down filler/notable edges while protecting keystone endpoints from reverse traversal." -m "Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>"
```

---

### Task 2: Allow bridges into keystones and add keystone bridge-OR status

**Files:**
- Modify: `src/skilltree.ts:1780-1807`
- Modify: `src/skilltree.ts:1606-1622` (continued from Task 1)
- Test: `src/skilltree.test.ts`

**Interfaces:**
- Consumes: `costToUnlock` (now bridge-keystone-capable), `keystonePrereqFor`, `canBuyKeystone`.
- Produces: `nodePurchaseStatus` reports a keystone as `purchasable` when either AND prereqs are met or a bridge path exists.

- [ ] **Step 1: Verify the forward-direction bridge-into-keystone path is enabled**

The change in Task 1 already includes `if (!toIsKeystone || isBridge) addDirectedStep(fromId, toId, e, e.cost)`. Confirm this line exists.

- [ ] **Step 2: Update `nodePurchaseStatus` for bridge-OR keystones**

Replace the keystone branch in `nodePurchaseStatus` (lines 1788-1794):

```typescript
  const ks = keystonePrereqFor(target);
  if (ks) {
    // AND path: every required notable owned.
    const andReady = ks.requires.every((req) => state.unlockedNodes.has(req as NodeId));
    if (andReady) {
      return state.unspentSkillPoints >= ks.cost ? 'purchasable' : 'insufficient-sp';
    }
    // Bridge-OR path: reachable via an active bridge.
    const result = costToUnlock(graph, state.unlockedNodes, state.unlockedEdges, state, target);
    if (result === null) return 'unreachable';
    return state.unspentSkillPoints >= result.totalCost ? 'purchasable' : 'insufficient-sp';
  }
```

- [ ] **Step 3: Write a failing test for a bridge-reachable keystone**

Add to `src/skilltree.test.ts`:

```typescript
it('keystone is purchasable via an active bridge without its AND prereqs', () => {
  const state = makeState({ level: 70, unspentSkillPoints: 1_000_000 });
  // Own the bridge source and enough nodes to activate the threshold.
  // The bridge robotics.keystone.parallelConstruction -> electronics.keystone.quantumYield
  // requires extraction >= 18 and refinement >= 18 SP spent.
  const source = 'robotics.keystone.parallelConstruction' as NodeId;
  const target = 'electronics.keystone.quantumYield' as NodeId;

  // Give the source keystone and fake spent SP by unlocking many nodes.
  state.unlockedNodes.add(source);
  for (const n of DEFAULT_GRAPH.nodes) {
    if (n.subPath === 'mining' || n.subPath === 'forestry' || n.subPath === 'drilling' ||
        n.subPath === 'smelting' || n.subPath === 'chemistry' || n.subPath === 'electronics') {
      state.unlockedNodes.add(n.id as NodeId);
    }
  }

  expect(nodePurchaseStatus(DEFAULT_GRAPH, state, target)).toBe('purchasable');

  buyNode(DEFAULT_GRAPH, state, target);
  expect(state.unlockedNodes.has(target)).toBe(true);
});
```

- [ ] **Step 4: Run the new test and confirm it fails**

```bash
npx vitest run src/skilltree.test.ts -t "keystone is purchasable via an active bridge"
```

Expected: FAIL — `nodePurchaseStatus` returns `unreachable` because AND prereqs are missing.

- [ ] **Step 5: Apply the change and rerun**

Apply Step 2, then:

```bash
npx vitest run src/skilltree.test.ts -t "keystone is purchasable via an active bridge"
```

Expected: PASS.

- [ ] **Step 6: Add a negative test — keystone stays unreachable without bridge or prereqs**

```typescript
it('keystone stays unreachable when neither AND prereqs nor bridge path exist', () => {
  const state = makeState({ level: 70, unspentSkillPoints: 1_000_000 });
  const target = 'electronics.keystone.quantumYield' as NodeId;
  expect(nodePurchaseStatus(DEFAULT_GRAPH, state, target)).toBe('unreachable');
});
```

Run and confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add src/skilltree.ts src/skilltree.test.ts
git commit -m "feat(skilltree): bridge-OR unlock for keystones" -m "A keystone is purchasable either through its AND-prereq notables or via an active threshold-bridge." -m "Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>"
```

---

### Task 3: Update the graphview click handler for keystone fallback

**Files:**
- Modify: `src/skilltree-graphview.ts:348-377`
- Test: manual smoke-test only (UI interaction; no pure test).

**Interfaces:**
- Consumes: `keystonePrereqFor`, `canBuyKeystone`, `buyKeystone`, `buyNode`, `effectiveGraph`, `deps.gateway`.
- Produces: Clicking a keystone tries AND first, then bridge path.

- [ ] **Step 1: Replace the keystone click branch**

Old code:

```typescript
    const ks = keystonePrereqFor(nodeId);
    if (ks) {
      if (!canBuyKeystone(ks, state)) return;
      if (deps.gateway) {
        const res = await deps.gateway.buyKeystone(state.id, nodeId);
        if (!res.ok) return;
      } else {
        try { buyKeystone(ks, state); } catch { return; }
      }
      refresh();
      return;
    }
```

New code:

```typescript
    const ks = keystonePrereqFor(nodeId);
    if (ks) {
      // AND-prereq path first.
      if (canBuyKeystone(ks, state)) {
        if (deps.gateway) {
          const res = await deps.gateway.buyKeystone(state.id, nodeId);
          if (!res.ok) return;
        } else {
          try { buyKeystone(ks, state); } catch { return; }
        }
        refresh();
        return;
      }
      // Bridge-OR fallback: use the Dijkstra path.
      const graph = effectiveGraph(state);
      if (deps.gateway) {
        const res = await deps.gateway.unlockSkillNode(state.id, nodeId);
        if (!res.ok) return;
      } else {
        try { buyNode(graph, state, nodeId); } catch { return; }
      }
      refresh();
      return;
    }
```

- [ ] **Step 2: Typecheck the client**

```bash
cd /root/robot-islands && npx tsc -b
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/skilltree-graphview.ts
git commit -m "feat(skilltree-graphview): keystone bridge-OR click fallback" -m "If a keystone's AND prereqs are not met, try the unlock-skill-node bridge path." -m "Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>"
```

---

### Task 4: Update server intent to allow bridge-reachable keystones via `unlock-skill-node`

**Files:**
- Modify: `server/src/game/intents.ts:531-575`
- Test: `server/src/game/intents.test.ts`

**Interfaces:**
- Consumes: `keystonePrereqFor`, `nodePurchaseStatus`, `buyNode`, `effectiveGraph`.
- Produces: `unlock-skill-node` intent accepts a keystone target when `nodePurchaseStatus` says `purchasable` (i.e., bridge-reachable).

- [ ] **Step 1: Remove the keystone rejection from the intent handler**

Delete these lines from the `'unlock-skill-node'` handler:

```typescript
      // Anti-cheat: keystones are not in this intent's surface — buyNode throws
      // for them and the no-throw contract forbids leaning on the runner's
      // try/catch. Reject before any buyNode path can be reached.
      if (keystonePrereqFor(nodeId) !== undefined) {
        return { ok: false, error: 'keystone not purchasable via this intent' };
      }
```

Update the comment above the `nodePurchaseStatus` check to:

```typescript
      // Authoritative purchasability pre-check (anti-cheat): SP sufficiency +
      // depth→tier gate + reachability (including bridge-reachable keystones),
      // all recomputed from server state. Only a 'purchasable' status proceeds.
```

- [ ] **Step 2: Update the server test that expects keystone rejection**

Locate the test in `server/src/game/intents.test.ts` (~l.911):

```typescript
  it('illegal: a keystone target is rejected, save unchanged', async () => {
```

Change it to reflect that a keystone without AND prereqs or bridge is rejected:

```typescript
  it('illegal: a keystone without AND prereqs or bridge path is rejected', async () => {
    const now = Date.now();
    const uid = await aUserAtLevel5(100);
    await expectRejectNoChange(
      uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.keystone.veinmaster' }, seq: 2 },
      now,
    );
  });
```

- [ ] **Step 3: Add a server test for bridge-reachable keystone**

Add inside `describe('unlock-skill-node', ...)`:

```typescript
  it('legal: a keystone reachable via an active bridge can be bought', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home')!;
      state.level = 70;
      state.unspentSkillPoints = 1_000_000;
      // Own bridge source and many nodes to satisfy thresholds.
      state.unlockedNodes.add('robotics.keystone.parallelConstruction');
      for (const n of DEFAULT_GRAPH.nodes) {
        if (n.subPath === 'mining' || n.subPath === 'forestry' || n.subPath === 'drilling' ||
            n.subPath === 'smelting' || n.subPath === 'chemistry' || n.subPath === 'electronics') {
          state.unlockedNodes.add(n.id);
        }
      }
    });
    const ack = await applyIntent(
      pool, uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'electronics.keystone.quantumYield' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });
  });
```

- [ ] **Step 4: Typecheck the server**

```bash
cd /root/robot-islands/server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run the server skill-tree intent tests**

```bash
cd /root/robot-islands/server && npx vitest run src/game/intents.test.ts -t "unlock-skill-node"
```

Expected: PASS (requires running Postgres).

- [ ] **Step 6: Commit**

```bash
git add server/src/game/intents.ts server/src/game/intents.test.ts
git commit -m "feat(server): allow bridge-reachable keystones via unlock-skill-node" -m "Remove the blanket keystone rejection; nodePurchaseStatus now authoritatively decides bridge reachability." -m "Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>"
```

---

### Task 5: Update `SPEC.md` §9.3

**Files:**
- Modify: `SPEC.md:1131-1207`

- [ ] **Step 1: Update the graph description**

In `SPEC.md` line 1133, change:

```markdown
The skill tree is a **directed graph** of nodes connected by edges.
```

to:

```markdown
The skill tree is a graph of nodes connected by edges. Standard filler-chain edges and notable-anchor edges are **traversable in both directions**: owning a deeper node lets you walk back and claim shallower nodes you skipped. Edges into keystones remain directed, except for threshold-bridges.
```

- [ ] **Step 2: Update the purchasing section**

After line 1176 (the bullet about redundant edges), add:

```markdown
* Edges can be walked "downward" as well as upward. If you own a depth-4 node, you can later buy depth-3, depth-2, and depth-1 of the same chain without re-climbing from the bottom.
* **Keystones have two unlock paths:** (1) own every node in their AND-prerequisite list and pay the flat keystone cost, OR (2) reach the keystone through an active threshold-bridge from another owned node.
```

- [ ] **Step 3: Update the keystone gates paragraph**

Change line 1178:

```markdown
**Keystone gates.** Each keystone has an AND-prerequisite list of specific upstream nodes that must already be owned before the keystone can be purchased (`canBuyKeystone` / `buyKeystone`). This is separate from the graph pathing — even if a path exists, the keystone stays locked until every prereq is satisfied.
```

to:

```markdown
**Keystone gates.** Each keystone has an AND-prerequisite list of specific upstream nodes (`canBuyKeystone` / `buyKeystone`). In addition, a keystone is unlocked if it can be reached through an active threshold-bridge (`buyNode`). The two paths are independent: satisfying either one unlocks the keystone.
```

- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §9.3 undirected edges and bridge-OR keystones" -m "Document the new traversal rules and keystone unlock alternatives." -m "Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>"
```

---

### Task 6: Full test run and build

- [ ] **Step 1: Run client tests**

```bash
cd /root/robot-islands && npx vitest run src/skilltree.test.ts src/skilltree-integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run server tests**

```bash
cd /root/robot-islands/server && npx vitest run src/game/intents.test.ts -t "unlock-skill-node" && npx vitest run src/game/intents.test.ts -t "buy-keystone"
```

Expected: PASS.

- [ ] **Step 3: Full typecheck**

```bash
cd /root/robot-islands && npx tsc -b
cd /root/robot-islands/server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Production build**

```bash
cd /root/robot-islands && npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Restart services**

```bash
systemctl restart robot-islands-dev.service robot-islands-auth.service
systemctl status robot-islands-dev.service robot-islands-auth.service --no-pager
```

Expected: both active.

- [ ] **Step 6: Final commit if any fixes were needed**

If any test/build fixes were required, commit them; otherwise this task adds no commit.

---

## Self-Review

**Spec coverage:**
- Undirected non-keystone traversal → Task 1.
- Bridge-OR for keystones → Tasks 2, 3, 4.
- Spec update → Task 5.

**Placeholder scan:**
- No TODOs/TBDs.
- Every step includes exact file paths, code blocks, and commands.

**Type consistency:**
- `costToUnlock` signature unchanged.
- `nodePurchaseStatus` signature unchanged.
- `buyNode` signature unchanged.
- `buyKeystone` / `canBuyKeystone` unchanged.

**Known edge cases not explicitly tested in this plan:**
- Walking down a notable anchor to its chain node (same logic as filler chain; covered implicitly).
- Bridge reverse traversal between two non-keystones (covered by bidirectional bridge cost).
- Aura adjacency is intentionally unchanged.
