# 🚂 Deploy StackMemory to Railway

Quick deployment guide for hosting StackMemory MCP Server on Railway.app

## 📋 Prerequisites

1. **Railway Account**: Sign up at [railway.app](https://railway.app)
2. **GitHub Account**: For automatic deployments
3. **Credit Card**: For production use ($5/month minimum)

## 🚀 Quick Deploy (5 Minutes)

### Option A: Deploy from GitHub (Recommended)

1. **Push your code to GitHub**:
```bash
git add .
git commit -m "Add Railway deployment"
git push origin main
```

2. **Deploy on Railway**:
   - Go to [railway.app/new](https://railway.app/new)
   - Click **"Deploy from GitHub repo"**
   - Select your `stackmemory` repository
   - Railway auto-detects Node.js and creates services

3. **Add PostgreSQL**:
   - In Railway dashboard, click **"+ New"**
   - Select **"Database"** → **"PostgreSQL"**
   - It auto-connects with `DATABASE_URL`

4. **Add Redis** (Optional):
   - Click **"+ New"** → **"Database"** → **"Redis"**
   - Auto-connects with `REDIS_URL`

5. **Configure Environment Variables**:
   - Click on your service
   - Go to **"Variables"** tab
   - Add these:

```env
NODE_ENV=production
PORT=8080
AUTH_MODE=api_key
API_KEY_SECRET=your-secret-key-min-32-chars
JWT_SECRET=another-secret-min-32-chars
CORS_ORIGINS=https://claude.ai
RATE_LIMIT_ENABLED=true
ENABLE_ANALYTICS=true
ENABLE_WEBSOCKET=true
```

6. **Generate Domain**:
   - Go to **"Settings"** → **"Networking"**
   - Click **"Generate Domain"**
   - You'll get: `stackmemory-production.up.railway.app`

### Option B: Deploy with Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Link to existing project (if needed)
railway link

# Add PostgreSQL
railway add --database postgresql

# Add Redis (optional)
railway add --database redis

# Deploy
railway up

# Open dashboard
railway open
```

## 🔧 Configuration

### API Key Authentication (Simple)

1. Generate a secure API key:
```bash
openssl rand -hex 32
# Output: 7a8f9e2d4c6b8a3f5e7d9c2b4a6f8e3d5c7b9a2f4e6d8c3b5a7f9e2d4c6b8a3f
```

2. Set in Railway variables:
```env
API_KEY_SECRET=7a8f9e2d4c6b8a3f5e7d9c2b4a6f8e3d5c7b9a2f4e6d8c3b5a7f9e2d4c6b8a3f
```

3. Use in Claude.ai config:
```json
{
  "mcpServers": {
    "stackmemory": {
      "command": "curl",
      "args": [
        "-X", "POST",
        "-H", "Authorization: Bearer YOUR_API_KEY",
        "-H", "Content-Type: application/json",
        "https://your-app.railway.app/api/tools/execute"
      ]
    }
  }
}
```

### OAuth with Auth0 (Advanced)

1. Create Auth0 application
2. Set Railway variables:
```env
AUTH_MODE=oauth
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
```

## 📊 Monitoring

### View Logs
```bash
railway logs

# Or in dashboard:
# Click service → "Logs" tab
```

### Check Health
```bash
curl https://your-app.railway.app/health
```

### Metrics Dashboard
Railway provides built-in metrics:
- CPU usage
- Memory usage
- Network I/O
- Request count

## 💰 Costs

### Railway Pricing
- **Developer Plan**: $5/month (includes $5 credits)
- **Pro Plan**: $20/month (includes $20 credits)
- **Usage-based**: ~$0.01/GB RAM/hour

### Typical Costs for StackMemory
- **Small** (1GB RAM, PostgreSQL): ~$8/month
- **Medium** (2GB RAM, PostgreSQL, Redis): ~$15/month
- **Large** (4GB RAM, PostgreSQL, Redis, 2 replicas): ~$30/month

## 🔒 Security

### Environment Variables
Never commit secrets! Use Railway's environment variables:

```bash
# Set via CLI
railway variables set API_KEY_SECRET=your-secret

# Or use dashboard UI
```

### HTTPS
Railway provides automatic HTTPS for all deployments.

### CORS
Configure allowed origins:
```env
CORS_ORIGINS=https://claude.ai,https://yourdomain.com
```

## 🚨 Troubleshooting

### Build Fails
```bash
# Check build logs
railway logs --build

# Common fix: Clear cache
railway up --no-cache
```

### Database Connection Issues
```bash
# Check DATABASE_URL is set
railway variables

# Test connection
railway run node -e "console.log(process.env.DATABASE_URL)"
```

### Port Issues
Railway auto-injects PORT variable. Don't hardcode it!
```javascript
const port = process.env.PORT || 8080;
```

## 📈 Scaling

### Horizontal Scaling
```bash
# Via dashboard: Settings → Replicas → Set count

# Or Railway.json:
{
  "deploy": {
    "replicas": 3
  }
}
```

### Vertical Scaling
Automatic based on usage, or set limits:
```json
{
  "deploy": {
    "maxMemory": "2GB",
    "maxCPU": "2"
  }
}
```

## 🎯 Next Steps

1. **Test Deployment**:
```bash
# Health check
curl https://your-app.railway.app/health

# Save context
curl -X POST https://your-app.railway.app/api/context/save \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Test context", "type": "test"}'
```

2. **Configure Claude.ai**:
   - Add MCP server config with your Railway URL
   - Test connection from Claude

3. **Monitor**:
   - Set up alerts in Railway dashboard
   - Check logs regularly
   - Monitor costs

## 🆘 Support

- Railway Docs: [docs.railway.app](https://docs.railway.app)
- Railway Discord: [discord.gg/railway](https://discord.gg/railway)
- StackMemory Issues: [GitHub Issues](https://github.com/stackmemoryai/stackmemory/issues)

---

**Ready to deploy!** 🚀 Railway makes it super simple - just connect GitHub and go!