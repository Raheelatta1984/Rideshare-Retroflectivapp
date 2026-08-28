# Arena.ai Deployment Setup - Step by Step

## Prerequisites
- Arena.ai account (https://arena.ai)
- GitHub account access
- Repository: `Raheelatta1984/Rideshare-Retroflectivapp`

---

## 🚀 Step 1: Connect Repository to Arena.ai

1. **Go to Arena.ai Dashboard**
   - URL: https://arena.ai/dashboard
   - Sign in with your account

2. **Create New Project**
   - Click "New Project" or "+ Project"
   - Select "Connect from GitHub"

3. **Authorize GitHub**
   - Click "Install GitHub App"
   - Select `Raheelatta1984/Rideshare-Retroflectivapp`
   - Click "Install & Authorize"

4. **Configure Build Settings**
   ```
   Repository: Raheelatta1984/Rideshare-Retroflectivapp
   Branch: main
   Framework: React
   Build Command: npm install && npm run build
   Output Directory: dist/
   ```

---

## 🔧 Step 2: Set Environment Variables

In Arena.ai Dashboard → Project Settings → Environment Variables:

```
REACT_APP_RELAY_SERVER=https://relay.retroflex.app
VITE_APP_RELAY_SERVER=https://relay.retroflex.app
```

---

## ⚡ Step 3: Enable Auto-Deployment

1. **In Project Settings → Deployments**
2. **Enable "Auto-deploy on push to main"**
3. Save

---

## 📋 Step 4: Configure GitHub Webhook (Optional - for real-time updates)

### If you want instant deployments on push:

**Get Webhook URL from Arena.ai:**
1. Go to Project Settings → Webhooks
2. Copy the webhook URL (looks like: `https://webhook.arena.ai/...`)

**Add to GitHub:**
1. Go to repo: https://github.com/Raheelatta1984/Rideshare-Retroflectivapp
2. Settings → Webhooks → Add webhook
3. Paste Arena.ai webhook URL
4. Events: Push events
5. Click "Add webhook"

---

## ✅ Step 5: First Deployment

1. **Trigger Manual Deploy** (if not auto-deployed)
   - Arena.ai Dashboard → Project → Deploy button

2. **Wait for Build**
   - Should take 2-3 minutes
   - Watch logs for any errors

3. **Get Your URL**
   - Once deployed, Arena.ai shows:
   ```
   https://retroflex-XXXXXX.arena.site/
   ```

---

## 🧪 Step 6: Test Deployment

### Open in Browser:
```
https://retroflex-XXXXXX.arena.site/#/lab
```

### Login with Demo:
- Email: `driver@retroflex.app`
- Password: `demo1234`

### Test Connectivity:
1. Open `#/lab` - should show phone + tablet simulator
2. Toggle the ON/OFF switch
3. Open another tab with `?mode=tablet&display=7K2M9Q`
4. Both should stay in sync ✅

---

## 📊 Monitor Deployments

**In Arena.ai Dashboard:**
- Deployment History
- Build Logs
- Error Messages
- Performance Metrics

---

## 🔄 Auto-Updates

After first deployment:
- **Every push to `main` branch** → Auto-redeploys
- **Build logs** available in Arena.ai dashboard
- **URL stays the same** across deployments

---

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| Build fails | Check logs in Arena.ai dashboard for errors |
| Slow deployment | First build takes longer; subsequent builds are cached |
| Connectivity not working | Verify relay server env var is set |
| Display shows "Waiting..." | Check browser console for errors |

---

## 📝 Your Arena.ai Project URL

After deployment completes, your app will be at:
```
https://retroflex-XXXXXX.arena.site/
```

**Replace XXXXXX with your actual project ID shown in Arena.ai**

---

## 🔐 Security Notes

- Keep `GITHUB_WEBHOOK_SECRET` secret (don't commit)
- Use environment variables for sensitive data
- Enable 2FA on GitHub and Arena.ai accounts
- Review webhook logs regularly

---

## 📞 Support

- Arena.ai Docs: https://docs.arena.ai
- GitHub Webhooks: https://docs.github.com/webhooks
- Repository: https://github.com/Raheelatta1984/Rideshare-Retroflectivapp
