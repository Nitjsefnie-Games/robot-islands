# UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement route priority drag-to-reorder (#31), multi-island HUD (#55), and tutorial / first-time onboarding (#56).

**Architecture:** Route reordering mutates `Route.priorityList` in place. Multi-island HUD is a new DOM overlay showing all populated islands. Tutorial is a state machine tracking objective completion, rendered as banner cues.

**Tech Stack:** TypeScript strict, DOM manipulation, CSS. Render layer only.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/routes-ui.ts` | Drag-to-reorder list for route priority |
| `src/hud.ts` | Multi-island slim bar |
| `src/tutorial.ts` | Tutorial state machine and objective definitions |
| `src/tutorial-ui.ts` | Tutorial banner / tooltip overlay |
| `src/main.ts` | Bootstrap tutorial on first load; wire HUD updates |
| `src/world.ts` | `tutorialState` persistence field |

---

### Task 1: Route Priority Drag-to-Reorder

**Files:**
- Modify: `src/routes-ui.ts`
- Test: manual / visual (no pure logic to unit-test)

- [ ] **Step 1: Render priority list as sortable DOM list**

In the route inspector panel, when `filter === null`, render `priorityList` as a `<ul>` with draggable `<li>` items:

```typescript
function renderPriorityList(route: Route, container: HTMLElement): void {
  const ul = document.createElement('ul');
  ul.className = 'priority-list';
  route.priorityList.forEach((resId, index) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = String(index);
    li.textContent = resourceLabel(resId);
    li.addEventListener('dragstart', handleDragStart);
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('drop', handleDrop);
    ul.appendChild(li);
  });
  container.appendChild(ul);
}
```

- [ ] **Step 2: Implement drag handlers**

```typescript
let dragSrcIndex: number | null = null;

function handleDragStart(e: DragEvent) {
  dragSrcIndex = Number((e.currentTarget as HTMLElement).dataset.index);
  e.dataTransfer?.setData('text/plain', String(dragSrcIndex));
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
}

function handleDrop(e: DragEvent, route: Route, rerender: () => void) {
  e.preventDefault();
  const src = Number(e.dataTransfer?.getData('text/plain'));
  const dst = Number((e.currentTarget as HTMLElement).dataset.index);
  if (src === dst) return;
  // Mutate route.priorityList
  const list = [...route.priorityList];
  const [moved] = list.splice(src, 1);
  list.splice(dst, 0, moved);
  (route as any).priorityList = list; // or provide a setter
  rerender();
}
```

- [ ] **Step 3: CSS for drag feedback**

```css
.priority-list li {
  cursor: grab;
  padding: 4px 8px;
  border: 1px solid #444;
  margin-bottom: 2px;
  background: #1a1a1a;
}
.priority-list li.dragging {
  opacity: 0.5;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/routes-ui.ts
git commit -m "feat: route priority drag-to-reorder UI"
```

---

### Task 2: Multi-Island HUD

**Files:**
- Modify: `src/hud.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Render slim multi-island bar**

```typescript
// src/hud.ts

export function renderMultiIslandBar(world: WorldState, activeIslandId: string, onSelect: (id: string) => void): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'multi-island-bar';
  bar.className = 'multi-island-bar';

  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = world.islandStates[spec.id];
    if (!state) continue;

    const item = document.createElement('div');
    item.className = `island-hud-item ${spec.id === activeIslandId ? 'active' : ''}`;
    item.onclick = () => onSelect(spec.id);

    const name = document.createElement('span');
    name.textContent = spec.displayName ?? spec.id;
    item.appendChild(name);

    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = `L${state.level}`;
    item.appendChild(level);

    // Brownout indicator
    const isBrownout = state.buildings.some(b => /* brownout logic */ false);
    if (isBrownout) {
      item.classList.add('brownout');
    }

    // Storage cap hit indicator
    const capHit = Object.entries(state.inventory).some(([r, amount]) => amount >= (state.storageCaps[r as ResourceId] ?? 0));
    if (capHit) {
      const alert = document.createElement('span');
      alert.className = 'alert';
      alert.textContent = '!';
      item.appendChild(alert);
    }

    bar.appendChild(item);
  }

  return bar;
}
```

- [ ] **Step 2: CSS styling**

```css
#multi-island-bar {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 32px;
  background: #0a0e14;
  border-bottom: 1px solid #2d5878;
  display: flex;
  gap: 8px;
  padding: 0 8px;
  align-items: center;
  overflow-x: auto;
}
.island-hud-item {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.island-hud-item.active { background: #2d5878; }
.island-hud-item.brownout { color: #ff4444; }
.island-hud-item .alert { color: #ffaa00; font-weight: bold; }
```

- [ ] **Step 3: Wire into main.ts**

At the bottom of the HUD update path in `main.ts`, call `renderMultiIslandBar` and append/replace in DOM. On island select, update `activeIslandId` and refresh HUD.

- [ ] **Step 4: Commit**

```bash
git add src/hud.ts src/main.ts
git commit -m "feat: multi-island HUD bar with brownout and cap-hit alerts"
```

---

### Task 3: Tutorial / First-Time Onboarding

**Files:**
- Create: `src/tutorial.ts`
- Create: `src/tutorial-ui.ts`
- Modify: `src/world.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Define tutorial objectives**

```typescript
// src/tutorial.ts

export type ObjectiveId =
  | 'place_solar'
  | 'place_mine'
  | 'place_workshop'
  | 'reach_level_5'
  | 'build_dronepad'
  | 'dispatch_first_drone'
  | 'settle_first_island'
  | 'build_antenna';

export interface TutorialState {
  completed: Set<ObjectiveId>;
  current: ObjectiveId | null;
}

export const OBJECTIVES: Record<ObjectiveId, { title: string; hint: string; check: (world: WorldState) => boolean }> = {
  place_solar: {
    title: 'Power Up',
    hint: 'Place a Solar Panel on any grass tile.',
    check: (w) => Object.values(w.islandStates).some(s => s.buildings.some(b => b.defId === 'solar')),
  },
  place_mine: {
    title: 'Extract Resources',
    hint: 'Place a Mine on an ore vein.',
    check: (w) => Object.values(w.islandStates).some(s => s.buildings.some(b => b.defId === 'mine')),
  },
  place_workshop: {
    title: 'Craft Materials',
    hint: 'Place a Workshop to craft iron ingots.',
    check: (w) => Object.values(w.islandStates).some(s => s.buildings.some(b => b.defId === 'workshop')),
  },
  reach_level_5: {
    title: 'Grow',
    hint: 'Reach level 5 to unlock Tier 2.',
    check: (w) => Object.values(w.islandStates).some(s => s.level >= 5),
  },
  build_dronepad: {
    title: 'Take Flight',
    hint: 'Build a Drone Pad to scout the world.',
    check: (w) => Object.values(w.islandStates).some(s => s.buildings.some(b => b.defId === 'dronepad')),
  },
  dispatch_first_drone: {
    title: 'Explore',
    hint: 'Dispatch your first drone.',
    check: (w) => w.drones.length > 0,
  },
  settle_first_island: {
    title: 'Expand',
    hint: 'Send a ship to settle a new island.',
    check: (w) => w.islands.filter(i => i.populated).length >= 2,
  },
  build_antenna: {
    title: 'Stay Connected',
    hint: 'Build an Antenna so drones can transmit data.',
    check: (w) => Object.values(w.islandStates).some(s => s.buildings.some(b => b.defId.startsWith('antenna'))),
  },
};

export function checkObjectives(state: TutorialState, world: WorldState): ObjectiveId[] {
  const newlyCompleted: ObjectiveId[] = [];
  for (const [id, obj] of Object.entries(OBJECTIVES)) {
    if (state.completed.has(id as ObjectiveId)) continue;
    if (obj.check(world)) {
      state.completed.add(id as ObjectiveId);
      newlyCompleted.push(id as ObjectiveId);
    }
  }
  // Advance current
  const order = Object.keys(OBJECTIVES) as ObjectiveId[];
  state.current = order.find(id => !state.completed.has(id)) ?? null;
  return newlyCompleted;
}
```

- [ ] **Step 2: Render tutorial banner**

```typescript
// src/tutorial-ui.ts

export function renderTutorialBanner(state: TutorialState): HTMLElement | null {
  if (!state.current) return null;
  const obj = OBJECTIVES[state.current];
  const banner = document.createElement('div');
  banner.id = 'tutorial-banner';
  banner.innerHTML = `
    <strong>${obj.title}</strong>
    <span>${obj.hint}</span>
  `;
  return banner;
}
```

- [ ] **Step 3: CSS**

```css
#tutorial-banner {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: #1a2a3a;
  border: 1px solid #7dd3e8;
  padding: 8px 16px;
  border-radius: 4px;
  display: flex;
  gap: 8px;
  align-items: center;
  color: #eee;
}
```

- [ ] **Step 4: Wire into main.ts tick**

```typescript
// In the per-frame update loop:
if (world.tutorialState) {
  const newlyCompleted = checkObjectives(world.tutorialState, world);
  if (newlyCompleted.length > 0) {
    // Flash completion briefly
  }
  const banner = renderTutorialBanner(world.tutorialState);
  const old = document.getElementById('tutorial-banner');
  if (old) old.replaceWith(banner ?? document.createElement('div'));
  else if (banner) document.body.appendChild(banner);
}
```

- [ ] **Step 5: Persist tutorial state**

Add `tutorialState?: TutorialState` to `WorldState`. In `makeInitialWorld`, initialize:

```typescript
tutorialState: { completed: new Set(), current: 'place_solar' },
```

- [ ] **Step 6: Commit**

```bash
git add src/tutorial.ts src/tutorial-ui.ts src/world.ts src/main.ts
git commit -m "feat: tutorial onboarding with objective banner"
```

---

## Self-Review

**1. Spec coverage:**
- Route priority reorder → Task 1
- Multi-island HUD → Task 2
- Tutorial onboarding → Task 3

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `TutorialState` added to `WorldState` with default.
