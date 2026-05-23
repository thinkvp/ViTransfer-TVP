## Plan: Share Files Preview Generation (Images + Videos)

Introduce a durable, 3-layer preview pipeline for all previewable files in the Share FILES section (PROJECT root and UPLOADS root) — images (standard uploads, album photos) and videos (non-video-version assets uploaded via UPLOADS or VIDEO ASSETS). The existing icon + extension fallback stays as the baseline; this plan adds reliable async generation on top of it.

### Scope

Share FILES section only — share page file browser and admin share page file browser.  
Covers: `ShareUploadFile` records (UPLOADS root) and `VideoAsset` records (non-video-version assets in PROJECT root VIDEO ASSETS).  
Does NOT cover: internal project management pages, video processing pipeline for primary video versions (already durable).

---

## Architecture: 3-Layer Strategy

1. **Enqueue immediately** — After a file is successfully uploaded/finalized, enqueue a `share-upload-preview` worker job.
2. **UI fallback** — Display icon + file extension while preview is `PENDING` or `FAILED`. Add a subtle "generating..." badge for `PENDING` state. Keep existing fallback for files that will never have a preview (non-image, non-video).
3. **Hourly reconciliation** — A scheduled repeatable worker job scans for previewable files missing a preview (status `null`, `PENDING` with no recent queue activity, or `FAILED` with backoff expired) and re-enqueues them with a batch cap and cooldown guard.

### Video thumbnail: no full download required

For S3 mode, pass a **short-lived presigned URL directly as the FFmpeg `-i` input** instead of materializing the full file via `materializeStoragePathToLocalFile`. FFmpeg uses HTTP range requests internally:
- Reads the container index/moov atom (a few KB–a few MB for typical files)
- Seeks directly to the target timestamp frame (a few seconds of encoded data)
- Total data transferred: typically 5–20 MB even for large 4K files
- Edge case: MP4 with moov at the end (non-faststart) — FFmpeg issues a ranged GET to the tail first, then seeks; still avoids a full download

For local mode the file is already on disk — no change needed.

---

## Steps

### Phase 1: Schema — preview lifecycle fields

1. Add preview lifecycle columns to `ShareUploadFile` in `prisma/schema.prisma`:
   - `previewStatus       String?`  — `PENDING | PROCESSING | READY | FAILED`
   - `previewPath         String?`  — storage path of generated preview image
   - `previewError        String?`  — last error message on failure
   - `previewGeneratedAt  DateTime?`
   - `previewFileSize     BigInt?`
   - `previewAttempts     Int       @default(0)`
   - `previewQueuedAt     DateTime?`

2. Add same columns to `VideoAsset` in `prisma/schema.prisma` (non-video-version assets only — video versions already have their own thumbnail pipeline).

3. Create migration: `20260523000000_add_share_file_preview_fields`.

### Phase 2: Queue infrastructure

4. Add `share-upload-preview` job type to the queue definitions (`src/worker/queue.ts` or equivalent):
   ```ts
   interface ShareUploadPreviewJob {
     type: 'shareUploadFile' | 'videoAsset'
     recordId: string
     storagePath: string
     fileType: string
     fileName: string
     durationSeconds?: number | null
   }
   ```
5. Export a typed `enqueueShareUploadPreview(payload)` helper that:
   - Sets `previewStatus = 'PENDING'`, `previewQueuedAt = now()`, increments `previewAttempts` on the DB record
   - Adds the job to the Bull queue with `jobId = \`share-preview:\${type}:\${recordId}\`` for deduplication (Bull `jobId` deduplication prevents double-queueing)

### Phase 3: Preview worker processor

6. Add `src/worker/share-upload-preview-processor.ts`:
   - **Image files** (type starts with `image/`): use `sharp` to resize to max 1280×720, output JPEG quality 85, store at `getShareUploadPreviewStoragePath(storagePath, fileType)`
   - **Video files** (type starts with `video/`):
     - S3 mode: generate a short-lived presigned URL (5 min) for the source file via `s3GetPresignedStreamUrl`; pass presigned URL directly as the FFmpeg `-i` argument — no local download required
     - Local mode: resolve file path via `getFilePath` and pass directly
     - Call `generateThumbnail(inputPathOrUrl, tempOutputPath, timestamp)` where `timestamp = getThumbnailCaptureTimestamp(durationSeconds)`
     - Upload result via `uploadFile(tempOutputPath, previewStoragePath)`
   - **Idempotency**: skip generation and mark `READY` if preview already exists at the target storage path
   - **On success**: set `previewStatus = 'READY'`, `previewPath`, `previewFileSize`, `previewGeneratedAt`, clear `previewError`
   - **On failure**: set `previewStatus = 'FAILED'`, `previewError` with last error message; do not retry automatically beyond Bull's built-in retry (max 3 attempts, exponential backoff)
   - **Temp file cleanup**: always delete temp output file in finally block

7. Register processor in `src/worker/index.ts` alongside existing processors.

### Phase 4: Enqueue after upload completion

8. `src/app/api/share/[token]/uploads/files/route.ts` (direct/multipart upload completion):  
   After successful file record creation/update, call `enqueueShareUploadPreview` if `fileType` is previewable (image or video).

9. `src/app/api/share/[token]/uploads/s3/complete/route.ts` (S3 multipart complete):  
   After successful S3 completion and DB record update, call `enqueueShareUploadPreview`.

10. `src/pages/api/uploads/[[...path]].ts` (video asset uploads for non-video versions):  
    After successful VideoAsset record creation, call `enqueueShareUploadPreview` with `type: 'videoAsset'` if the asset is a previewable non-video-version file (i.e. `category !== 'video'` but `fileType` is image or video).

11. `src/app/api/videos/[id]/assets/route.ts` (POST — admin video asset upload):  
    Same as above — enqueue after VideoAsset record creation for previewable non-video-version assets.

### Phase 5: Expose preview status + URL in download/listing routes

12. `src/app/api/share/[token]/uploads/route.ts` (UPLOADS listing):  
    Include `previewStatus` and `previewUrl` (presigned/content URL when `READY`) in `FileListItem` response shape.

13. `src/app/api/share/[token]/downloadable-files/route.ts`:  
    Include `previewStatus` and `previewUrl` for `ShareUploadFile` and `VideoAsset` entries.

14. `src/app/api/share/[token]/uploads/download-token/route.ts`:  
    When `previewStatus` is `null` (never queued) for a previewable file, call `enqueueShareUploadPreview` as a backfill trigger (best-effort, non-blocking).

### Phase 6: UI — ShareFilesBrowser preview states

15. `src/components/ShareFilesBrowser.tsx`:
    - When `previewStatus === 'READY'` and `previewUrl` is set: render the preview image (existing path, currently image-only — extend to cover video thumbnails too)
    - When `previewStatus === 'PENDING' || previewStatus === 'PROCESSING'`: render the existing icon + extension fallback with a small "Generating preview..." text or subtle spinner overlay
    - When `previewStatus === 'FAILED'` or no preview fields: render the existing icon + extension fallback (no change from today's behaviour)
    - No polling needed — status is loaded on mount; user can refresh to see updated state. (A future enhancement could add a light SSE or polling mechanism, but that is out of scope for this plan.)

### Phase 7: Hourly reconciliation job

16. Add a repeatable Bull job `share-upload-preview-reconcile` to `src/worker/index.ts` scheduler (alongside the existing hourly/daily jobs):
    - Runs every 60 minutes
    - Queries for previewable `ShareUploadFile` records where:
      - `previewStatus IS NULL` (never queued), OR
      - `previewStatus = 'PENDING'` AND `previewQueuedAt < now() - 30 min` (stale queue entry, job may have been lost), OR
      - `previewStatus = 'FAILED'` AND `previewAttempts < 5` AND `previewGeneratedAt < now() - 2 hours` (retry with backoff)
    - Same query for `VideoAsset` records
    - Cap at 100 records per run (prevent thundering herd on first deploy with many existing files)
    - For each: call `enqueueShareUploadPreview` (Bull `jobId` deduplication makes this safe if already queued)
    - Logs count of queued items

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/worker/share-upload-preview-processor.ts` | Worker processor for image + video preview generation |
| `prisma/migrations/20260523000000_add_share_file_preview_fields/migration.sql` | Schema migration |

## Files to Modify

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add preview fields to `ShareUploadFile` and `VideoAsset` |
| `src/worker/queue.ts` | Add `ShareUploadPreviewJob` type + `enqueueShareUploadPreview` helper |
| `src/worker/index.ts` | Register processor + hourly reconcile job |
| `src/app/api/share/[token]/uploads/files/route.ts` | Enqueue after direct upload completion |
| `src/app/api/share/[token]/uploads/s3/complete/route.ts` | Enqueue after S3 multipart complete |
| `src/pages/api/uploads/[[...path]].ts` | Enqueue after VideoAsset upload (non-video-version) |
| `src/app/api/videos/[id]/assets/route.ts` | Enqueue after admin VideoAsset creation (non-video-version) |
| `src/app/api/share/[token]/uploads/route.ts` | Include `previewStatus` + `previewUrl` in listing response |
| `src/app/api/share/[token]/downloadable-files/route.ts` | Include `previewStatus` + `previewUrl` in response |
| `src/app/api/share/[token]/uploads/download-token/route.ts` | Backfill enqueue when preview missing |
| `src/components/ShareFilesBrowser.tsx` | Add `PENDING`/`PROCESSING` generating state; extend preview rendering to video thumbnails |

---

## Key Design Decisions

- **`jobId` deduplication in Bull** prevents double-queueing the same file (safe to call enqueue multiple times).
- **No DB polling from the UI** in this phase — the fallback icon is acceptable until the next page load or manual refresh.
- **Presigned URL for FFmpeg input (S3 mode)** avoids downloading the full video; FFmpeg uses HTTP range requests to fetch only the moov atom + target frame region.
- **`previewAttempts` cap at 5** prevents infinite retry loops for permanently broken files.
- **Batch cap of 100 per reconcile run** prevents a large backfill from overwhelming the queue on first deployment.
- **Existing `ensureShareUploadVideoThumbnail` / `ensureShareUploadImagePreview` functions** in `share-upload-video-thumbnail.ts` remain as the synchronous on-demand path (used by download-token route today); the new worker processor calls the same underlying `generateThumbnail` / `sharp` logic, just from a queued async context.
