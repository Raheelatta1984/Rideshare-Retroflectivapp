# Mobile Codespaces And Detached HEAD Recovery

Repository: https://github.com/Raheelatta1984/Rideshare-Retroflectivapp

## Difference Found

The GitHub `main` branch is an older partial snapshot, not the current refined build.

- It has `.github/workflow/pages.yml` (singular) with no workflow contents. The working build uses `.github/workflows/pages.yml`.
- It lacks `.devcontainer/devcontainer.json`, so Codespaces cannot auto-install and start the app.
- It lacks the latest device profile, tablet consent, activity log, battery, role and QR updates.
- It needs `scripts/build-zip.d.mts`, required by the current `vite.config.ts`.
- It contains obsolete paths such as `public.nojekyll` and placeholder `Test.test` files.

Replace/merge the complete current archive into `main`; do not copy isolated files.

## Mobile Steps

1. Log in as `tic.raheel@gmail.com` or `driver@retroflex.app`.
2. Open **Booth → Owner Source Vault** and download `Rideshare-Retroflectivapp.zip`.
3. Start Codespaces from main: https://codespaces.new/Raheelatta1984/Rideshare-Retroflectivapp
4. Extract/copy the archive contents into the repository root, replacing old files.
5. Run `bash scripts/recover-main.sh`.
6. Commit and push main after the build succeeds.

## Detached HEAD Recovery

If Codespaces says `HEAD detached`, run:

```bash
bash scripts/recover-main.sh
```

The script saves uncommitted work, creates a rescue branch, switches to `main`, pulls `origin/main`, merges preserved work, restores uncommitted changes, and runs `npm install` plus `npm run build`.

If it reports a merge conflict, run `git status`, resolve the listed files, then run:

```bash
git add .
git commit -m "Resolve Retroflex merge"
npm run build
git push origin main
```

## Clean Replacement Option

If the old branch is disposable, use a fresh clone:

```bash
cd /workspaces
git clone https://github.com/Raheelatta1984/Rideshare-Retroflectivapp.git retroflex-clean
cd retroflex-clean
```

Copy/extract the owner ZIP contents into `retroflex-clean`, then run:

```bash
npm install
npm run build
git add .
git commit -m "Sync refined Retroflex build"
git push origin main
```

## Mobile Preview

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Open forwarded port `5173` and set it to **Public** for driver phone/tablet testing.

## Required Paths

Keep these exact paths:

```text
.devcontainer/devcontainer.json
.github/workflows/pages.yml
public/.nojekyll
public/tablet.html
scripts/build-zip.mjs
scripts/build-zip.d.mts
```

Delete old placeholder paths if they remain:

```text
.github/workflow/pages.yml
public.nojekyll
public/Test.test
public/images/Test.test
scripts/Test.test
```