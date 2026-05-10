# Contributing

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
