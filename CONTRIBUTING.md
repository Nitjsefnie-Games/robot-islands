# Contributing

## Development happens on branches

Do **not** commit directly to `master`. All work — features, fixes, docs, refactors — happens on a **feature branch** cut from `master`. `master` is integration-only: it advances solely by fast-forwarding a completed, rebased branch onto it.

```
git checkout master
git pull                       # rebases (pull.rebase=true), so master stays linear
git checkout -b feature-x      # branch per unit of work
# ... commits on feature-x ...
```

Name branches by intent and kind, e.g. `feat/power-brownouts`, `fix/ocean-tint-bleed`, `docs/branch-based-development`, `refactor/economy-rates`.

### Lifecycle: branch → PR → rebase

1. **Branch** — cut a feature branch from an up-to-date `master` (above).
2. **PR** — push the branch and open a pull request for review. The PR is where the work is reviewed and discussed; nothing lands on `master` un-reviewed.
3. **Rebase** — before integrating, `git rebase master` so the branch sits directly on top of current `master` (resolve conflicts on the branch, never on `master`). Then fast-forward `master` onto the rebased tip — keeping history linear (see below). No merge commits.

This reverses the repo's earlier "commit straight onto `master`" habit. From now on `master` only ever receives reviewed, rebased branch tips.

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
