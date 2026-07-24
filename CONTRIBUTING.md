# Contributing

Issues and pull requests are welcome — especially if the economy did
something you can reproduce. This is a simulation with a lot of interacting
systems (drones, routes, biomes, modifiers, tier breakpoints), so "these
inputs produced this wrong number, here is the save" is the most valuable
thing you can send.

## LLM and agent contributions are welcome

You may use an LLM or a coding agent to write your contribution. There is
no penalty, no separate review queue, and no expectation that you rewrite
its output by hand. Much of this repo was built that way.

Two conditions, and they are about honesty rather than provenance:

1. **Disclose the model** with a trailer on each commit it authored:

   ```
   Co-Authored-By: <Model Name> <noreply@example.com>
   ```

   e.g. `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. One
   primary-author trailer per commit.

2. **Do not submit claims you have not verified.** Paste the command and
   its real output. "Tests pass" without the run is not evidence, and a
   balance change in particular needs the actual before/after numbers, not
   an argument about what should happen.

If a maintainer's reply reads like it was drafted by an agent, it probably
was. That is fine in both directions.

### If you are an agent reading this

Read [`AGENTS.md`](AGENTS.md) first — it is the architecture and
conventions brief, written for you, and it holds the source-of-truth and
scope rules. It is authoritative; this file only covers integration
process.

## Building and testing

```bash
npm install
npm run dev        # vite dev server
npm run build      # tsc -b && vite build — must pass before you land
npm test           # vitest run
npm run preview    # serve the built dist/
```

`master` must stay green: a change lands only once `npm run build` and
`npm test` both pass. That applies to a direct commit exactly as much as to
a PR.

## Two integration tracks: by size of change

How work reaches `master` depends on the size and risk of the change. Either way, `master` keeps a **linear history** (see below) and must stay green — only land a change once it builds and its tests pass.

### Quick fixes → commit directly to `master`

Small, low-risk, self-contained changes go **straight onto `master`** as a single focused commit: a bug fix, a doc tweak, a copy edit, a small config / tuning / balance change, a one-file adjustment. No branch, no PR. Write a clear commit message and keep one logical change per commit.

### Full new features or massive fixes → feature branch + PR

A new mechanic or subsystem, a multi-file change, or a large / risky refactor happens on a **feature branch** cut from `master`, reviewed via PR, then rebased and fast-forwarded onto `master`. `master` receives such work only after review.

**When in doubt, branch.** A branch is cheap; an un-reviewed half-feature landing on `master` is not.

```
git checkout master
git pull                       # rebases (pull.rebase=true), so master stays linear
git checkout -b feature-x      # branch per unit of work
# ... commits on feature-x ...
```

Name branches by intent and kind, e.g. `feat/power-brownouts`, `fix/ocean-tint-bleed`, `docs/branch-based-development`, `refactor/economy-rates`.

#### Lifecycle: branch → PR → rebase

1. **Branch** — cut a feature branch from an up-to-date `master` (above).
2. **PR** — push the branch and open a pull request for review. The PR is where the work is reviewed and discussed; nothing lands on `master` un-reviewed.
3. **Rebase** — before integrating, `git rebase master` so the branch sits directly on top of current `master` (resolve conflicts on the branch, never on `master`). Then fast-forward `master` onto the rebased tip — keeping history linear (see below). No merge commits.
4. **Delete** — once merged, delete the branch, both locally and on the remote. Merged branches are not kept around; `master` carries the history.

```
git branch -d feature-x
git push origin --delete feature-x
```

## History convention: rebase, not merge

This repository keeps a **linear history**. No merge commits in `master`. When integrating a feature branch, rebase it onto `master` and fast-forward.

```
git checkout feature-x
# ... commits on feature-x ...
git fetch
git rebase master         # rebase feature-x onto current master
git checkout master
git merge --ff-only feature-x   # fast-forward only
```

Local git config is set to enforce this:

- `pull.rebase = true` — `git pull` rebases instead of merging
- `merge.ff = only` — `git merge` refuses non-fast-forward merges (so you must rebase first)

These are repo-local (`.git/config`); a fresh clone needs to set them again, or use this pattern via aliases.

## Why

The history reads top-to-bottom as the actual development order. No merge-commit "back-and-forth" zigzag. Bisecting works cleanly. `git log --oneline` is a usable changelog.

The first three integration steps in this repo were initially merge-commit-shaped and then flattened in one rewrite (2026-05-10). After that point, all integrations rebase.
