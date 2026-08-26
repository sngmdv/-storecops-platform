# Storecops Deployment Guide

## Prerequisites

- Node.js ≥ 18 installed
- Docker (optional, for containerized deployment)
- Railway account (recommended) or any Node.js hosting platform

---

## Option 1: Railway (Recommended)

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/storecops-platform.git
git push -u origin main
```

### Step 2: Connect Railway
1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository

### Step 3: Add Persistent Storage
1. In Railway dashboard, click your service
2. Go to "Volumes" tab
3. Add volume:
   - Mount Path: `/app/data`
   - Size: 1GB (minimum)

### Step 4: Configure Environment Variables
Go to "Variables" tab and add:

```bash
NODE_ENV=production
PORT=4000
API_KEY=<generate-with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
PUBLIC_URL=<railway-assigned-url>
DEFAULT_STORE_ID=store_demo
EMAIL_PROVIDER=console
WHATSAPP_PROVIDER=console
```

### Step 5: Deploy
Railway auto-deploys on push. Check logs for:
```
[BOOT] Storecops Growth Platform live on port 4000
[BOOT] Layers: Data → Intelligence → Decision → Execution → Reporting → Growth Loop
```

---

## Option 2: Docker

### Build Image
```bash
docker build -t storecops .
```

### Run Container
```bash
docker run -d \
  --name storecops \
  -p 4000:4000 \
  -v storecops-data:/app/data \
  -e NODE_ENV=production \
  -e API_KEY=your-strong-random-key \
  -e PUBLIC_URL=https://your-domain.com \
  storecops
```

### Docker Compose
```yaml
version: '3.8'
services:
  storecops:
    build: .
    ports:
      - "4000:4000"
    volumes:
      - storecops-data:/app/data
    environment:
      - NODE_ENV=production
      - API_KEY=your-strong-random-key
      - PUBLIC_URL=https://your-domain.com
      - EMAIL_PROVIDER=resend
      - RESEND_API_KEY=your-resend-key
    restart: unless-stopped

volumes:
  storecops-data:
```

---

## Option 3: VPS (DigitalOcean, Linode, etc.)

### Step 1: SSH into Server
```bash
ssh root@your-server-ip
```

### Step 2: Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Step 3: Clone Repository
```bash
git clone https://github.com/yourusername/storecops-platform.git
cd storecops-platform
```

### Step 4: Install Dependencies
```bash
npm install --production
```

### Step 5: Configure Environment
```bash
cp .env.example .env
nano .env
```

Edit `.env` with your production values.

### Step 6: Start with PM2
```bash
npm install -g pm2
pm2 start server.js --name storecops
pm2 startup
pm2 save
```

### Step 7: Configure Nginx (Optional)
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Environment Variables Reference

### Required
| Variable | Description | Example |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `production` |
| `API_KEY` | Master API key | Random 64-char string |
| `PUBLIC_URL` | Public-facing URL | `https://your-app.up.railway.app` |

### Optional (Email)
| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_PROVIDER` | Email service | `console` |
| `RESEND_API_KEY` | Resend API key | — |
| `EMAIL_FROM` | Sender email | — |

### Optional (WhatsApp)
| Variable | Description | Default |
|----------|-------------|---------|
| `WHATSAPP_PROVIDER` | WhatsApp service | `console` |
| `WHATSAPP_ACCESS_TOKEN` | Meta API token | — |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID | — |

### Optional (Payments)
| Variable | Description | Default |
|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | Stripe secret | — |
| `RAZORPAY_KEY_ID` | Razorpay key | — |

---

## Post-Deployment Checklist

- [ ] Verify health check: `GET /health`
- [ ] Create admin account via signup
- [ ] Connect test store
- [ ] Run free audit on a URL
- [ ] Verify email delivery (if configured)
- [ ] Verify WhatsApp delivery (if configured)
- [ ] Check logs for errors
- [ ] Set up monitoring (optional)

---

## Troubleshooting

### "SQLITE_CANTOPEN" Error
- Ensure `/app/data` directory exists and is writable
- Check volume mount in Railway/Docker

### "EACCES" Permission Error
- Run: `chmod -R 755 data/`
- Or recreate volume with correct permissions

### Webhook Verification Failed
- Ensure `WHATSAPP_WEBHOOK_VERIFY_TOKEN` matches Meta config
- Check `WEBHOOK_SECRET` is set for HMAC verification

### Rate Limiting Issues
- Adjust `RATE_LIMIT_MAX` for your plan
- Check `X-RateLimit-*` headers in responses

---

## Updating

### Railway
Just push to GitHub — Railway auto-deploys.

### Docker
```bash
git pull
docker build -t storecops .
docker stop storecops
docker rm storecops
docker run -d ... (same command as before)
```

### PM2
```bash
git pull
npm install --production
pm2 restart storecops
```

---

## Backups

### SQLite Database
```bash
# Local
cp data/storecops.db backups/storecops-$(date +%Y%m%d).db

# Docker
docker exec storecops cp /app/data/storecops.db /app/data/backup.db
docker cp storecops:/app/data/backup.db ./backups/
```

### Automated Backups (Railway)
Use Railway's volume snapshots or a cron job:
```bash
# Daily backup cron
0 2 * * * cp /app/data/storecops.db /backups/storecops-$(date +\%Y\%m\%d).db
```

---

*Last updated: 2026-08-14*
