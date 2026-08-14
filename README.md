# Retroflex — Rideshare Rear Window Beacon

**Repo:** [Raheelatta1984/Rideshare-Retroflectivapp](https://github.com/Raheelatta1984/Rideshare-Retroflectivapp)

A tablet on the inside of the rear glass. It sleeps. When Uber, DiDi or any rideshare assigns a passenger, it wakes. After the car is still for five seconds, it paints their name across the window.

Frontend only. Driver booth, rides, display settings and phone↔tablet pairing run in the browser. No Neon. No database. Built for **GitHub Codespaces** and **GitHub Pages**.

## Live routes (after Codespaces or Pages is up)

| Path | What to test |
| --- | --- |
| `#/lab` | Phone + rear tablet on one screen. Start here. |
| `#/review` | Review checklist |
| `#/demo` | Cinematic pickup of Sarah |
| `#/login` | Driver booth |
| `#/display/7K2M9Q` | Full-screen rear glass |
| `#/download` | **Download the full source as a ZIP** |

On the live preview, open **`#/download`**. The browser saves `Rideshare-Retroflectivapp.zip`.

After the code is on GitHub, this official archive also works:

https://github.com/Raheelatta1984/Rideshare-Retroflectivapp/archive/refs/heads/main.zip

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
