## Share Page Uploads Remediation

Date: 2026-05-22

### Purpose
Track post-review defects found in Share Page Uploads implementation and capture the applied fixes.

### Defects Confirmed
1. Upload cancel action did not stop remaining queued files in a multi-file batch.
2. Upload failure could leave optimistic UPLOADS rows stale because final reconciliation refresh was skipped on thrown error.
3. Share upload delete endpoints did not recalculate `project.totalBytes`, causing stale storage totals.
4. Transfer panel status label showed "Downloading" for upload transfers in `transferring` state.

### Remediation Plan
1. Update share upload batch logic to support full-batch cancel semantics.
2. Ensure upload file list reconciliation runs after batch completion, cancellation, and failure.
3. Recalculate project bytes after upload file/folder deletes.
4. Make transfer status text direction-aware for upload/download.

### Validation
- Run `npm run test:share-uploads`
- Manual smoke:
  - Start multi-file upload then cancel; verify no queued files continue.
  - Force upload error and verify UPLOADS list re-syncs.
  - Delete upload file/folder and verify Project Data totals update.

### Additional Hardening Completed
1. Added explicit share upload lifecycle APIs for S3 multipart:
  - `POST /api/share/[token]/uploads/s3/presign`
  - `POST /api/share/[token]/uploads/s3/complete`
  - `POST /api/share/[token]/uploads/s3/abort`
2. Updated share-page upload orchestration to use init -> multipart PUTs -> complete in S3 mode.
3. Added abort-on-error/cancel behavior for multipart uploads to reduce orphaned incomplete uploads.
4. Preserved one-time 401 retry token refresh behavior for share upload requests.

### Automated Check Results
- `npm run test:share-uploads` passed after these changes.
