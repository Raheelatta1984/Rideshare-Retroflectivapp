#!/usr/bin/env bash
# Safely recover a detached-HEAD Codespace and merge its work into main.

set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "Retroflex branch recovery"
echo "Remote: $REMOTE · target: $BRANCH"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this from the repository root."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Saving uncommitted work…"
  git stash push --include-untracked -m "retroflex-recovery-$STAMP"
  STASHED=1
else
  STASHED=0
fi

CURRENT_BRANCH="$(git branch --show-current || true)"
if [ -z "$CURRENT_BRANCH" ]; then
  RESCUE="rescue-$STAMP"
  echo "Detached HEAD found. Preserving it as $RESCUE…"
  git switch -c "$RESCUE"
else
  RESCUE="$CURRENT_BRANCH"
fi

git fetch "$REMOTE" --prune

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git switch "$BRANCH"
else
  git switch -c "$BRANCH" --track "$REMOTE/$BRANCH"
fi

git pull --ff-only "$REMOTE" "$BRANCH"

if [ "$RESCUE" != "$BRANCH" ]; then
  echo "Merging preserved work from $RESCUE…"
  git merge --no-edit "$RESCUE"
fi

if [ "$STASHED" = "1" ]; then
  echo "Restoring uncommitted work…"
  git stash pop
fi

npm install
npm run build

echo "Recovery complete."
echo "Next: git add . && git commit -m 'Sync refined Retroflex build' && git push origin $BRANCH"