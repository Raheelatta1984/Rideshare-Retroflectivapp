# Push to https://github.com/Raheelatta1984/Rideshare-Retroflectivapp

The GitHub repo exists and is public. This preview **cannot log into your account** and **cannot run Termux on your phone**. You push from Termux (or a laptop) after signing in as you.

**Do not paste GitHub tokens into chat.** Revoke any token that already appeared here: https://github.com/settings/tokens

## Termux (phone) — use this

Full walkthrough: **[TERMUX.md](./TERMUX.md)**

Short version, after the project folder is in Downloads:

```bash
pkg update -y
pkg install -y git gh
termux-setup-storage
cd /sdcard/Download/Rideshare-Retroflectivapp
bash termux-push.sh
```

`gh auth login` → GitHub.com → HTTPS → **Login with a web browser** → enter the one-time code at https://github.com/login/device

## Laptop

```bash
git init
git add .
git commit -m "Retroflex rear window beacon"
git branch -M main
git remote add origin https://github.com/Raheelatta1984/Rideshare-Retroflectivapp.git
git push -u origin main --force
```

Or `gh auth login` then the same push.

`--force` is OK: GitHub currently only has the default LICENSE + stub README.

## After the push

1. Confirm files: https://github.com/Raheelatta1984/Rideshare-Retroflectivapp
2. Codespaces: https://codespaces.new/Raheelatta1984/Rideshare-Retroflectivapp
3. Pages: Settings → Pages → Source: GitHub Actions  
   https://raheelatta1984.github.io/Rideshare-Retroflectivapp/#/lab
