# Arena.ai Deployment Guide for Retroflex

## Quick Start
1. Clone: `https://github.com/Raheelatta1984/Rideshare-Retroflectivapp`
2. Deploy to Arena.ai
3. Set env var: `REACT_APP_RELAY_SERVER=https://relay.retroflex.app`
4. Auto-redeploy on push to main branch

## Deploy Button
Add this to Arena.ai:
```
Repository: Raheelatta1984/Rideshare-Retroflectivapp
Branch: main
Build: npm install && npm run build
Output: dist/
Framework: React + Vite
```

## Environment Variables
```
REACT_APP_RELAY_SERVER=https://relay.retroflex.app
VITE_APP_RELAY_SERVER=https://relay.retroflex.app
```

## After Deploy
New URL will appear at: `https://{deployment-id}.arena.site/`

Test with:
- Visit `/#/lab` (phone + tablet test)
- Login with demo: `driver@retroflex.app` / `demo1234`
- Open `/#/display/7K2M9Q` in another tab
- Verify "Connected" status appears
