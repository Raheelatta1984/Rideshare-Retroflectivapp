# Manual GitHub Update Package

This source archive contains the complete current project. Extract all files into the root of your local clone or Codespace; do not place the extracted `Rideshare-Retroflectivapp/` folder inside another folder.

## Required Files

```text
src/
public/
scripts/
.devcontainer/
.github/
package.json
vite.config.ts
tsconfig.json
index.html
README.md
MOBILE-CODESPACES.md
```

## Build Locally

```bash
npm install
npm run build
```

## Sync To GitHub

```bash
bash scripts/recover-main.sh
git add -A
git commit -m "Sync current Retroflex source"
git push origin main
```

If the repository has old placeholder files, delete them before committing:

```bash
rm -rf .github/workflow
rm -f public.nojekyll public/Test.test public/images/Test.test scripts/Test.test
```

Read `MOBILE-CODESPACES.md` before resolving a detached HEAD or merge conflict.