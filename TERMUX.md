# Push Retroflex from Termux

This preview **cannot control your phone**. Termux runs on *your* Android. Paste the block below into Termux. Do **not** paste a GitHub token into this chat.

Repo: https://github.com/Raheelatta1984/Rideshare-Retroflectivapp

## 0. Revoke the old token first

The token you pasted in chat is burned. Delete it:

https://github.com/settings/tokens

We will sign in from Termux with a **one-time device code**. No token in chat.

## 1. Put this project on the phone

Termux can only push files that are already on the device.

- Copy the whole project folder (the one with `package.json`, `src`, `.devcontainer`, `.github`) into **Downloads**, and name it `Rideshare-Retroflectivapp`.
- Include hidden folders. If your file manager hides them, enable “show hidden files”.

You need at least:

```
Rideshare-Retroflectivapp/
  .devcontainer/
  .github/
  public/
  src/
  index.html
  package.json
  README.md
  vite.config.ts
```

## 2. Open Termux and paste this

```bash
pkg update -y
pkg install -y git gh
termux-setup-storage

cd /sdcard/Download/Rideshare-Retroflectivapp || cd ~/storage/downloads/Rideshare-Retroflectivapp

git config --global user.name "Raheelatta1984"
git config --global user.email "raheelatta1984@users.noreply.github.com"

gh auth login
```

When `gh` asks:

1. **GitHub.com**
2. **HTTPS**
3. **Login with a web browser**
4. It prints a one-time code
5. On the phone browser open https://github.com/login/device
6. Type that code and authorize

Then push:

```bash
cd /sdcard/Download/Rideshare-Retroflectivapp || cd ~/storage/downloads/Rideshare-Retroflectivapp

git init
git add .
git commit -m "Retroflex rear window beacon"
git branch -M main
git remote remove origin 2>/dev/null
git remote add origin https://github.com/Raheelatta1984/Rideshare-Retroflectivapp.git
git push -u origin main --force
```

`--force` is OK: the GitHub repo only has the default LICENSE + stub README.

## 3. Confirm it landed

```bash
gh repo view Raheelatta1984/Rideshare-Retroflectivapp
```

Or open: https://github.com/Raheelatta1984/Rideshare-Retroflectivapp

You should see `src/`, `.devcontainer/`, `.github/`.

## 4. After the push

**Codespaces (easiest live demo)**  
https://codespaces.new/Raheelatta1984/Rideshare-Retroflectivapp

**GitHub Pages public URL**  
Repo → Settings → Pages → Source: **GitHub Actions**

https://raheelatta1984.github.io/Rideshare-Retroflectivapp/#/lab

## Optional: run the app inside Termux

```bash
pkg install -y nodejs
cd /sdcard/Download/Rideshare-Retroflectivapp
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Then open `http://127.0.0.1:5173/#/lab` in the phone browser.

## If `gh` is missing

```bash
pkg install -y git
cd /sdcard/Download/Rideshare-Retroflectivapp
git init
git add .
git commit -m "Retroflex rear window beacon"
git branch -M main
git remote add origin https://github.com/Raheelatta1984/Rideshare-Retroflectivapp.git
git push -u origin main --force
```

Username: `Raheelatta1984`  
Password: a **new** Personal Access Token (never the old one, never your GitHub password).

Create a token here: https://github.com/settings/tokens  
Fine-grained, only this repo, Contents = Read and write.

## Do not

- Do not paste tokens into chat
- Do not commit `.env` or a token file
- Do not skip hidden folders `.devcontainer` and `.github`
