#!/data/data/com.termux/files/usr/bin/bash
# Retroflex → GitHub  (run this INSIDE Termux)
# Usage:  bash termux-push.sh
# Never put a GitHub token in this file.

set -euo pipefail

REPO_URL="https://github.com/Raheelatta1984/Rideshare-Retroflectivapp.git"
REPO_SLUG="Raheelatta1984/Rideshare-Retroflectivapp"

echo
echo "  RETROFLEX  ·  Termux push"
echo "  $REPO_SLUG"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "Installing git…"
  pkg install -y git
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Installing GitHub CLI…"
  pkg install -y gh
fi

git config --global user.name "${GIT_USER_NAME:-Raheelatta1984}"
git config --global user.email "${GIT_USER_EMAIL:-raheelatta1984@users.noreply.github.com}"

if ! gh auth status >/dev/null 2>&1; then
  echo
  echo "Sign in with a browser code (do not paste a token here)."
  echo "Pick: GitHub.com → HTTPS → Login with a web browser"
  echo
  gh auth login
fi

if [ ! -f package.json ] || [ ! -d src ]; then
  echo "Run this from the project folder (the one that contains package.json and src/)."
  echo "Tried: $(pwd)"
  exit 1
fi

git init
git add .
git status --short | head -n 40

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git commit -m "Retroflex rear window beacon" || true
else
  git commit -m "Retroflex rear window beacon"
fi

git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

echo
echo "Pushing to $REPO_URL …"
git push -u origin main --force

echo
echo "Done."
echo "Repo:        https://github.com/$REPO_SLUG"
echo "Codespaces:  https://codespaces.new/$REPO_SLUG"
echo "Pages lab:   https://raheelatta1984.github.io/Rideshare-Retroflectivapp/#/lab"
echo
echo "Turn on Pages: repo Settings → Pages → Source: GitHub Actions"
