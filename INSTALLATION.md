# ViTransfer-TVP Installation Guide

Step-by-step instructions for installing ViTransfer-TVP on various platforms.

> **Architecture:** linux/amd64 only. ARM64 is not supported.

## Quick Install (5 Minutes)

```bash
# 1. Download
mkdir vitransfer && cd vitransfer
curl -O https://raw.githubusercontent.com/thinkvp/ViTransfer-TVP/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/thinkvp/ViTransfer-TVP/main/.env.example

# 2. Configure
cp .env.example .env
nano .env  # Set ADMIN_EMAIL, ADMIN_PASSWORD, and replace secret placeholders

# 3. Generate secrets (run each command, paste output into .env)
openssl rand -hex 32      # → POSTGRES_PASSWORD
openssl rand -hex 32      # → REDIS_PASSWORD
openssl rand -base64 32   # → ENCRYPTION_KEY
openssl rand -base64 64   # → JWT_SECRET
openssl rand -base64 64   # → JWT_REFRESH_SECRET
openssl rand -base64 64   # → SHARE_TOKEN_SECRET

# 4. Start
docker-compose up -d

# 5. Access
# Open http://localhost:4321
```

## Detailed Installation

### Prerequisites

- Docker 20.10+ and Docker Compose 2.0+
- 4GB+ RAM
- 20GB+ disk space
- Linux, Windows (WSL2), or macOS
- **Architecture:** linux/amd64 only

### Step 1: Get ViTransfer-TVP

**Option A: Download files only (recommended)**
```bash
mkdir vitransfer && cd vitransfer
curl -O https://raw.githubusercontent.com/thinkvp/ViTransfer-TVP/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/thinkvp/ViTransfer-TVP/main/.env.example
```

**Option B: Git Clone (for contributors/developers)**
```bash
git clone https://github.com/thinkvp/ViTransfer-TVP.git
cd ViTransfer
git checkout main
```

### Step 2: Configure Environment

Create `.env` from template:
```bash
cp .env.example .env
```

Edit `.env` and set these required values:

```env
# Change these!
ADMIN_EMAIL=your-email@example.com
ADMIN_PASSWORD=YourSecurePassword123

# Generate these (see next step)
POSTGRES_PASSWORD=
REDIS_PASSWORD=
ENCRYPTION_KEY=
JWT_SECRET=
JWT_REFRESH_SECRET=
SHARE_TOKEN_SECRET=
```

### Step 3: Generate Secrets

Run each command individually and paste the output into the corresponding `.env` variable.

**Linux/Mac/WSL:**
```bash
openssl rand -hex 32      # → POSTGRES_PASSWORD (hex, no special chars)
openssl rand -hex 32      # → REDIS_PASSWORD (hex, no special chars)
openssl rand -base64 32   # → ENCRYPTION_KEY
openssl rand -base64 64   # → JWT_SECRET
openssl rand -base64 64   # → JWT_REFRESH_SECRET
openssl rand -base64 64   # → SHARE_TOKEN_SECRET
```

**Windows (PowerShell):**
```powershell
# For hex values (POSTGRES_PASSWORD, REDIS_PASSWORD):
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })

# For base64 values (ENCRYPTION_KEY — 32 bytes):
[Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Max 256) }))

# For base64 values (JWT secrets — 64 bytes):
[Convert]::ToBase64String((1..64 | ForEach-Object { [byte](Get-Random -Max 256) }))
```

**Important:** Use hex (`openssl rand -hex 32`) for `POSTGRES_PASSWORD` and `REDIS_PASSWORD`. Base64 output contains `+/=` characters that can break database connection URLs.

### Step 4: Start Services

```bash
docker-compose up -d
```

First startup takes 2-5 minutes:
- Pulls images (app + worker)
- Initializes database
- Runs migrations
- Starts worker

### Step 5: Verify Installation

Check services are running:
```bash
docker-compose ps
```

You should see all services "Up":
```
NAME                   STATUS
vitransfer-app        Up (healthy)
vitransfer-worker     Up (healthy)
vitransfer-postgres   Up (healthy)
vitransfer-redis      Up (healthy)
```

View logs if needed:
```bash
docker-compose logs -f app
```

### Step 6: Access ViTransfer-TVP

1. Open browser to `http://localhost:4321`
2. Login with your `ADMIN_EMAIL` and `ADMIN_PASSWORD`
3. Complete initial setup:
   - Settings > Domain Configuration
   - Settings > Email Configuration (optional, required for OTP auth and notifications)
   - Create your first project!

## Post-Installation

### Configure Reverse Proxy (Recommended)

For production use with a custom domain, set up a reverse proxy with HTTPS.
Tested with Cloudflare Tunnels — set `CLOUDFLARE_TUNNEL=true` in `.env`.

### Configure Email (Optional)

1. Go to Settings > Email Configuration
2. Add your SMTP server details
3. Test the connection
4. Save settings

Email is required for: OTP authentication, notification digests, and payment reminders.

### Create Projects

1. Projects > New Project
2. Add client information
3. Upload videos
4. Share link with client

## Troubleshooting

### "Service not healthy"
```bash
# Check specific service logs
docker-compose logs postgres
docker-compose logs redis

# Restart services
docker-compose restart
```

### "Can't connect to database"
```bash
# Verify DATABASE_URL format is correct internally
# Should be: postgresql://vitransfer:PASSWORD@postgres:5432/vitransfer?schema=public

# Check PostgreSQL is running
docker-compose ps postgres

# Reset if needed
docker-compose down -v  # WARNING: Deletes all data!
docker-compose up -d
```

### "Uploads fail"
```bash
# Check disk space
df -h

# Check permissions
ls -la ./

# Check logs
docker-compose logs app | grep upload
```

### "Can't login"
- Verify `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`
- Check there are no extra spaces
- Try restarting: `docker-compose restart app`

### "HTTPS lockout"
- Set `HTTPS_ENABLED=false` in `.env`
- Run `docker-compose restart app`
- The env var always overrides database settings

## Updating

```bash
# Backup first!
docker-compose down
# Back up your postgres data and uploads volumes

# Update
docker-compose pull
docker-compose up -d

# Database migrations run automatically
# Verify
docker-compose logs -f app
```

## Uninstalling

```bash
# Stop and remove containers
docker-compose down

# Remove volumes (WARNING: Deletes all data!)
docker-compose down -v

# Remove images
docker rmi thinkvp/vitransfer-tvp-app:latest thinkvp/vitransfer-tvp-worker:latest postgres:17-alpine redis:8-alpine
```

## Getting Help

- Check logs: `docker-compose logs`
- GitHub Issues: [thinkvp/ViTransfer-TVP](https://github.com/thinkvp/ViTransfer-TVP/issues)
- README.md: Full documentation

---

**Installation complete!**

Next steps:
1. Create your first project
2. Upload a video
3. Share with a client
4. Collect feedback
