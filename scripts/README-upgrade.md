# PostgreSQL 17 & Redis 8 Upgrade Scripts

Safe, interactive scripts for upgrading ViTransfer on TrueNAS Scale with Dockge.

## Overview

- **upgrade-postgres17-redis8.sh** - Main upgrade script with safety checks
- **rollback-postgres17-redis8.sh** - Emergency rollback if something goes wrong

## Features

✅ Interactive confirmations at critical steps  
✅ Automatic backups before any changes  
✅ Validation checks throughout  
✅ Detailed logging  
✅ Color-coded output  
✅ Safe rollback capability  

## Prerequisites

1. **TrueNAS Scale** with Dockge managing ViTransfer
2. **SSH access** to your TrueNAS server
3. **Root/sudo access**
4. Know your PostgreSQL password (from .env file)

## Upgrade Process

### 1. Copy Scripts to TrueNAS

```bash
# SSH into TrueNAS
ssh root@YOUR_TRUENAS_IP

# Create scripts directory
mkdir -p /root/vitransfer-scripts
cd /root/vitransfer-scripts

# Copy the upgrade script (use your preferred method):
# - WinSCP, FileZilla, or
# - nano/vi to create and paste content
```

### 2. Make Scripts Executable

```bash
chmod +x upgrade-postgres17-redis8.sh
chmod +x rollback-postgres17-redis8.sh
```

### 3. Review Configuration

Edit the script to verify paths match your setup:

```bash
nano upgrade-postgres17-redis8.sh
```

Check these variables at the top:
```bash
DATA_ROOT="/mnt/tank/apps/vitransfer"      # Your data location
BACKUP_ROOT="/mnt/tank/backups/vitransfer"  # Where to store backups
POSTGRES_USER="vitransfer"                  # Your PG username
CONTAINER_PREFIX="vitransfer"               # Container name prefix
```

### 4. Run Upgrade

```bash
sudo bash upgrade-postgres17-redis8.sh
```

The script will:
1. ✅ Check prerequisites
2. ✅ Create tar backups of data directories
3. ✅ Create SQL dump from PostgreSQL 16
4. ✅ Validate backups
5. ✅ Remove old PostgreSQL data
6. ⏸️ Pause for you to update Dockge compose file
7. ⏸️ Pause for you to start the stack
8. ✅ Restore database to PostgreSQL 17
9. ✅ Verify versions and health

**The script will pause at key points and wait for your confirmation.**

## Rollback Process

If something goes wrong:

```bash
sudo bash rollback-postgres17-redis8.sh 20260121-143052
```

Replace the timestamp with your backup timestamp (shown during upgrade).

This will:
1. Stop the stack
2. Delete PostgreSQL 17 and Redis 8 data
3. Restore PostgreSQL 16 and Redis 7 from backup
4. Guide you to update Dockge compose file back to 16/7

## What You Need to Do Manually

The scripts handle most work automatically, but **you** must:

### During Upgrade:

1. **Stop the stack** in Dockge web UI
2. **Edit compose file** in Dockge:
   - Change `postgres:16-alpine` → `postgres:17-alpine`
   - Change `redis:7-alpine` → `redis:8-alpine`
3. **Start the stack** in Dockge
4. **Test your application** after upgrade

### During Rollback:

1. **Stop the stack** in Dockge web UI
2. **Edit compose file** in Dockge:
   - Change `postgres:17-alpine` → `postgres:16-alpine`
   - Change `redis:8-alpine` → `redis:7-alpine`
3. **Start the stack** in Dockge
4. **Verify functionality**

## Troubleshooting

### Script fails with "Permission denied"
```bash
chmod +x *.sh
```

### Script can't find containers
Verify your `CONTAINER_PREFIX` matches your actual container names:
```bash
docker ps | grep vitransfer
```

### PostgreSQL won't start after upgrade
Check Dockge logs for the postgres container. Common issues:
- Compose file not updated
- Data directory permissions

### Want to see what changed during restore
```bash
cat /mnt/tank/backups/vitransfer/[TIMESTAMP]/restore.log
```

## Backup Locations

All backups are stored in timestamped directories:
```
/mnt/tank/backups/vitransfer/
  └── 20260121-143052/
      ├── postgres-data.tar.gz  (Full PG 16 data)
      ├── redis-data.tar.gz     (Full Redis 7 data)
      ├── database.sql          (SQL dump)
      └── restore.log           (Restoration log)
```

**Keep these backups for at least 1 week after successful upgrade.**

## Safety Notes

⚠️ **This modifies production data** - read through the scripts first  
⚠️ **Requires downtime** - your app will be offline during upgrade  
⚠️ **Test rollback procedure** - know how to rollback before upgrading  
⚠️ **Additional TrueNAS snapshot recommended** - use TrueNAS's ZFS snapshots for extra safety  

## Additional Protection: ZFS Snapshots

For maximum safety, create a TrueNAS snapshot before running:

1. Open TrueNAS Scale web UI
2. Go to **Datasets**
3. Find your `apps/vitransfer` dataset
4. Click **Create Snapshot**
5. Name it: `before-postgres17-upgrade`

This gives you a ZFS-level rollback option independent of the scripts.

## Questions?

- Scripts have issues? Check they're executable and running as root
- Need to customize paths? Edit variables at top of scripts
- Unsure about your setup? Review the script content first - it's all commented

## After Successful Upgrade

1. ✅ Test all functionality thoroughly
2. ✅ Keep backups for 1+ week
3. ✅ Remove old backups:
   ```bash
   rm -rf /mnt/tank/backups/vitransfer/TIMESTAMP
   ```
4. ✅ Optional: Remove these scripts if no longer needed
