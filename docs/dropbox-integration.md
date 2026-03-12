# Dropbox Integration Guide

## Overview

ViTransfer-TVP supports optional Dropbox integration for offloading large files from the local server to Dropbox cloud storage. When enabled, Dropbox serves as the delivery backend for video originals, video assets, and photo album ZIP downloads, reducing server bandwidth and disk I/O.

### Benefits

- **Bandwidth offloading** — downloads are served directly from Dropbox via temporary links, eliminating the need to stream multi-GB files through the application server.
- **Storage flexibility** — original video files can be stored in Dropbox while transcoded previews remain local for fast playback.
- **Photo album ZIPs** — generated ZIP files for photo albums can be automatically uploaded to Dropbox and served to clients via direct download links.
- **Automatic lifecycle management** — when photos are added or removed from an album, the Dropbox copies are invalidated and re-uploaded automatically after new ZIPs are generated.
- **Running Jobs visibility** — all Dropbox upload activity appears in the bell icon's running jobs panel so admins can track progress in real time.

---

## Dropbox App Setup

### 1. Create a Dropbox App

1. Go to [https://www.dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
2. Click **Create app**
3. Choose **Scoped access**
4. Choose **App Folder** access to isolate ViTransfer files (recommended) or "Full Dropbox"
5. Name the app (e.g. `ViTransfer-TVP`)
6. Click **Create app**

### 2. Configure Permissions

In the app's **Permissions** tab, enable:

- `files.metadata.read`
- `files.metadata.write`
- `files.content.read`
- `files.content.write`

Click **Submit** to save the permissions.

### 3. Generate a Refresh Token

Dropbox uses OAuth 2 with short-lived access tokens and long-lived refresh tokens. ViTransfer-TVP needs a refresh token to maintain access without manual re-authentication.

1. In the app's **Settings** tab, note the **App key** and **App secret**
2. Generate an authorization code by visiting this URL in your browser (replace `YOUR_APP_KEY`):

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&response_type=code&token_access_type=offline
   ```

3. Authorize the app and copy the authorization code
4. Exchange the code for a refresh token:

   ```bash
   curl -X POST https://api.dropboxapi.com/oauth2/token \
     -d code=YOUR_AUTH_CODE \
     -d grant_type=authorization_code \
     -d client_id=YOUR_APP_KEY \
     -d client_secret=YOUR_APP_SECRET
   ```

5. The response includes a `refresh_token` — save this securely

### 4. Configure ViTransfer-TVP

Add the following environment variables to your `.env` file or Docker Compose configuration:

```env
DROPBOX_APP_KEY=your_app_key
DROPBOX_APP_SECRET=your_app_secret
DROPBOX_REFRESH_TOKEN=your_refresh_token
DROPBOX_ROOT_PATH=              # Optional: prefix for all Dropbox paths (e.g. /ViTransfer/Production)
```

In `docker-compose.yml`, these are passed to both the `app` and `worker` services automatically.

Restart the application after setting these variables. The admin settings page will show "Dropbox: Connected" when configured correctly.

---

## Feature Overview

### Video Originals

When a video version has the **Approvable?** toggle enabled, admins can click the **cloud icon** on the video version to upload the original file to Dropbox. Once uploaded:

- The download modal on the share page shows a **Dropbox / Local Server** toggle, defaulting to Dropbox
- Clients can switch to Local Server at any time if they experience issues with the Dropbox link
- If the upload is still in progress (PENDING or UPLOADING), the Download Video button is disabled with a message to switch to Local Server or wait

> **Note:** The Dropbox upload button is only available for videos with "Approvable?" enabled.

### Photo Album ZIPs

Admins can click the **cloud icon** next to the "Regenerate ZIPs" button on any photo album to upload the generated Full Resolution and Social Media ZIP files to Dropbox.

**Automatic lifecycle:**
- When Dropbox is enabled on an album, both Full and Social ZIPs are uploaded
- If photos are added or removed, ZIPs are regenerated and automatically re-uploaded to Dropbox
- If the admin clicks "Regenerate ZIPs", old Dropbox copies are deleted and new ones are uploaded after generation completes
- The cloud icon spins while uploads are in progress
- All upload activity appears in the **Running Jobs** bell icon

**Share page downloads:**
- When Dropbox copies are complete, the download modal shows a **Dropbox / Local Server** toggle so clients can choose their preferred source
- Clients can manually switch to Local Server if they have trouble downloading from Dropbox

### Video Assets

Video assets can also be uploaded to Dropbox on a per-asset basis using the cloud icon in the asset list.

---

## Architecture

### Storage Paths

Dropbox paths mirror the local storage structure exactly. Files are organised by real client name and project title for easy navigation in your Dropbox:

```
# Video original
dropbox:/clients/{Client Name}/projects/{Project Title}/videos/{Video Name}/{Version Label}/{filename}

# Video asset
dropbox:/clients/{Client Name}/projects/{Project Title}/videos/{Video Name}/{Version Label}/assets/{filename}

# Photo album ZIP (full resolution)
dropbox:/clients/{Client Name}/projects/{Project Title}/albums/{Album Name}/zips/{AlbumName}_Full_Res.zip

# Photo album ZIP (social crops)
dropbox:/clients/{Client Name}/projects/{Project Title}/albums/{Album Name}/zips/{AlbumName}_Social_Sized.zip
```

If `DROPBOX_ROOT_PATH` is set, it is prepended to all paths in the Dropbox API (e.g. `/ViTransfer-TVP/Production/clients/...`).

### Background Workers

Dropbox uploads run as background BullMQ jobs processed by the worker service:

| Queue | Purpose |
|-------|---------|
| `dropbox-upload` | Video originals and asset uploads to Dropbox |
| `album-zip-dropbox-upload` | Album ZIP uploads to Dropbox |

Jobs have automatic retry (3 attempts with exponential backoff) and progress tracking stored in the database.

### Download Flow

1. Client opens the download modal, which shows a **Dropbox / Local Server** toggle when Dropbox is enabled (defaults to Dropbox)
2. Client clicks download → server generates a short-lived token stored in Redis
3. Client navigates to `/api/content/photo-zip/{token}` (or `/api/content/{token}` for videos)
4. If Dropbox is selected → server issues a `307 Redirect` to a temporary Dropbox download link (~4 hours TTL)
5. If Local Server is selected (or `?forceLocal=true` is appended) → server streams the file directly from local storage

---

## Troubleshooting

### Dropbox shows as "Not Connected"

- Verify all four environment variables are set: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- Restart both the `app` and `worker` containers after changing environment variables
- Check that the Dropbox app has the required permissions (see step 2 above)

### Uploads fail with "Dropbox delete failed" or "Dropbox upload failed"

- Check the worker logs: `docker compose logs worker --tail=50`
- Verify the refresh token hasn't been revoked in the Dropbox app console
- If using `DROPBOX_ROOT_PATH`, ensure the path exists in Dropbox (it won't be created automatically)

### ZIP downloads still stream from local instead of Dropbox

- Check that the album's Dropbox upload status shows "COMPLETE" (visible in the Running Jobs panel)
- The Dropbox redirect only activates after the upload is fully complete
- If an upload errored, click the cloud icon to disable and re-enable Dropbox for that album

### Cloud icon doesn't appear on video versions

- The Dropbox button only appears for videos with **Approvable?** enabled
- Ensure Dropbox is configured (all environment variables set)
- The video must be in **READY** status (not processing or errored)
