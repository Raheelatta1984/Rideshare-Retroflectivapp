# Retroflex — Rideshare Rear Window Beacon

**Repo:** [Raheelatta1984/Rideshare-Retroflectivapp](https://github.com/Raheelatta1984/Rideshare-Retroflectivapp)

A tablet on the inside of the rear glass. It sleeps. When Uber, DiDi or any rideshare assigns a passenger, it wakes. After the car is still for five seconds, it paints their name across the window.

Frontend only. Driver booth, rides, display settings and phone↔tablet pairing run in the browser. No Neon. No database. Built for **GitHub Codespaces** and **GitHub Pages**.

## Live routes (after Codespaces or Pages is up)

| Path | What to test |
| --- | --- |
| `#/lab` | Phone + rear tablet on one screen. Start here. |
| `?mode=terminal` | **Terminal sign-up QR** — scan, log in or sign up, assign, glass |
| `#/review` | Review checklist |
| `#/demo` | Cinematic pickup of Sarah |
| `#/login` | Driver booth |
| `#/display/7K2M9Q` | Rear tablet authorization/display route |
| `#/forgot-password` | Local password reset request form |

The dedicated QR/tablet receiver uses:

```text
https://YOUR-APP-URL/?mode=tablet&display=PAIRCODE
```

The terminal sign-up QR carries no code, so one QR works for every tablet:

```text
https://YOUR-APP-URL/?mode=terminal
```

Scanning it opens a bare shell — pair-code login, or sign-up, then one Assign
step (rear or front glass, terminal name). Nothing else from the website is
reachable there, and the tablet never gets the console: brightness, apps, power,
campaigns and releasing a terminal all stay on the driver phone. Full flow,
security posture and the Supabase path are in **[TERMINAL-SIGNUP.md](./TERMINAL-SIGNUP.md)**.

## Owner Source Archive

The complete source archive is available only after login through **Booth → Owner Source Vault** for:

- `tic.raheel@gmail.com`
- `driver@retroflex.app` / `demo1234`

The download is generated in the authorized browser session as `Rideshare-Retroflectivapp.zip`.

**Demo booth**

- Email: `driver@retroflex.app`
- Password: `demo1234`
- Pair code: `7K2M9Q`

## 1. Push this project into the repo

This environment cannot log into your GitHub account and cannot drive Termux on your phone.

**On Android / Termux** — copy this folder to Downloads, then see **[TERMUX.md](./TERMUX.md)**:

```bash
pkg update -y && pkg install -y git gh
termux-setup-storage
cd /sdcard/Download/Rideshare-Retroflectivapp
bash termux-push.sh
```

Sign in with `gh auth login` → **Login with a web browser** (one-time code). Never paste a token into chat.

**On a laptop:**

```bash
git init
git add .
git commit -m "Retroflex rear window beacon"
git branch -M main
git remote add origin https://github.com/Raheelatta1984/Rideshare-Retroflectivapp.git
git push -u origin main --force
```

Include hidden folders **`.devcontainer`** and **`.github`**. Those are what make Codespaces and Pages work.

For a safe mobile Codespaces update or detached-HEAD recovery, see [MOBILE-CODESPACES.md](./MOBILE-CODESPACES.md).

## 2. Open GitHub Codespaces

One click after the push:

**[Open in Codespaces](https://codespaces.new/Raheelatta1984/Rideshare-Retroflectivapp)**

Or in the repo: **Code → Codespaces → Create codespace on main**.

The container runs `npm install` and starts Vite on port **5173**. When the port toast appears, open it. To test on a phone or tablet, set the port to **Public**.

If Vite did not start:

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Then open `#/lab` on the forwarded URL.

### Detached HEAD On Mobile

If a Codespace opens with a detached HEAD, do not commit directly. The full mobile recovery procedure is in [MOBILE-CODESPACES.md](./MOBILE-CODESPACES.md). From the project root, run:

```bash
bash scripts/recover-main.sh
```

It creates a rescue branch, returns to `main`, merges the preserved work, installs dependencies, and verifies the build.

## 3. Public demo on GitHub Pages

After the first push:

1. Repo **Settings → Pages**
2. Source: **GitHub Actions**
3. The workflow `.github/workflows/pages.yml` builds and publishes `dist`

Your public demo will be:

**https://raheelatta1984.github.io/Rideshare-Retroflectivapp/**

Direct lab link:

**https://raheelatta1984.github.io/Rideshare-Retroflectivapp/#/lab**

## How the product works

1. Mount a cheap Android tablet **landscape** on the **inside** of the rear window, screen facing the street.
2. Keep it charging. Enable stay-awake while plugged in.
3. Pair it to the driver phone with code `7K2M9Q` (or your own booth code).
4. Uber / DiDi stay on the phone. Retroflex only receives the passenger packet — name, color, PIN.
5. The glass stays black until a request. After five seconds at 0 km/h the name goes full-bleed.

Official rideshare APIs are closed. The booth supports paste-from-clipboard, voice, simulator cards, and a live pair channel (BroadcastChannel + PeerJS) so the phone and tablet can be different devices.

## Project map

```
src/App.tsx                     hash router
src/store.tsx                   driver booth + rides
src/components/Landing.tsx      marketing site
src/components/ReviewLab.tsx    phone + tablet review
src/components/DemoStudio.tsx   cinematic pickup
src/components/DriverConsole.tsx phone app
src/components/DisplayScreen.tsx rear-window OS
.devcontainer/                  Codespaces auto-start
.github/workflows/pages.yml     GitHub Pages deploy
```

## Testing & configuration

```bash
npm ci
npm run verify     # typecheck + 55 tests + build + artifact checks
npm run dev -- --host 0.0.0.0
```

CI runs the same on every push to `main` (`.github/workflows/ci.yml`).
See **[TESTING.md](./TESTING.md)** for the automated coverage map and the manual
QA script, and **[BUG-REPORT.md](./BUG-REPORT.md)** for the fixes shipped in this
pass (mangled template literals, the missing PeerJS dial, the dead relay).

Environment variables are all optional — copy `.env.example` to `.env.local`:

| Variable | Purpose |
| --- | --- |
| `VITE_RELAY_SERVER` | Your own relay + PeerJS host. Unset = public PeerJS cloud, no relay traffic |
| `VITE_PEER_HOST` / `_PORT` / `_PATH` | PeerJS signalling server (defaults to `0.peerjs.com:443`) |
| `VITE_TURN_URL` / `_USERNAME` / `_CREDENTIAL` | TURN relay for restrictive mobile networks |
