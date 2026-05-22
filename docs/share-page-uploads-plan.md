## Plan: Share Page Uploads Root + Storage Integration

Introduce a first-class UPLOADS root in Share Files for authenticated users, reusing existing share auth/session patterns and transfer UI while adding a new upload-file domain (paths + APIs + counters). Keep comment attachments working, and make the existing upload quota/toggle apply to both comment attachments and UPLOADS traffic.

## Steps
1. Phase 1: Data model + path primitives (blocks all later phases)
2. Add upload-domain persistence for files and folders: new Prisma model for share upload files (and optional explicit folder table only if empty-folder support cannot be safely achieved path-only).
3. Add storage path builders under project root uploads subtree (projects/.../uploads/...), including folder path normalization and traversal-safe relative path validation.
4. Extend aggregate storage calculators so project total bytes include UPLOADS bytes.
5. Phase 2: Share auth + permissions + quota semantics (depends on Phase 1)
6. Define share upload permission matrix.
7. Admin/internal users with accessSharePage may create folder/upload/delete.
8. Authenticated non-guest clients may upload/create folder only when allowClientUploadFiles is true; no delete permissions.
9. Guests blocked.
10. Apply maxClientUploadAllocationMB quota to combined bytes: comment attachments + share uploads.
11. Add/adjust quota endpoint response to reflect combined usage and keep existing comment-upload UX compatible.
12. Add token-longevity strategy for long uploads: silent share-token refresh cadence while upload queue has active items, and retry once on 401 for presign/complete calls by forcing project refresh/token renewal.
13. Phase 3: Uploads API surface (depends on Phases 1-2)
14. Add share-upload listing endpoint returning folder tree + file metadata for UPLOADS root.
15. Add create-folder endpoint (path-only mode creates marker entry if required for empty folder visibility).
16. Add upload init endpoint for share uploads (record creation + sanitized path assignment).
17. Add upload complete endpoint (and abort path for S3 multipart) with role-aware authorization.
18. Add delete endpoint for files/folders with recursive behavior for privileged users.
19. Wire upload bytes into project-total recalculation triggers.
20. Phase 4: Transfer subsystem for uploads (depends on Phase 3; parallel with Phase 5 after contracts fixed)
21. Generalize transfer orchestration so upload direction is first-class, not download-only.
22. Reuse existing TRANSFER panel in VideoSidebar with upload status labels and progress metrics.
23. Add completed-upload auto-clear policy (deferred clear timer after 100%, preserving failures/canceled rows).
24. Phase 5: Share Files UI (PROJECT + UPLOADS roots) (depends on Phase 3; parallel with Phase 4 once data contracts stabilize)
25. Extend downloadable/share files data types to support a second root section (UPLOADS) and uploadable folder/file nodes.
26. Update ShareFilesBrowser root rendering to show PROJECT then UPLOADS.
27. In UPLOADS root/subfolders, show + File and + Folder controls left of Select All/Clear.
28. Add drag-and-drop upload targeting current folder and folder tiles.
29. Implement optimistic rows for attempted uploads: immediate row insertion with circular percent + progress bar, then finalize metadata on success.
30. Enforce per-role UI affordances.
31. Admin/internal: create folder, upload, delete file/folder.
32. Authenticated client: upload/create folder (if enabled), no delete actions.
33. Guest: read-only/no upload controls.
34. Phase 6: Settings copy + semantics updates (parallel with Phases 3-5 once quota behavior is final)
35. Rename labels:
36. "Default max allowed data allocation for client uploads" -> "Default max allowed data allocation for project uploads".
37. "Allow clients to upload files with comments" -> "Allow clients to upload files to Projects".
38. Update helper descriptions to clarify:
39. Toggle controls client access to UPLOADS on Share page.
40. Quota applies to total project uploads (comment attachments + UPLOADS files).
41. Preserve existing DB field names for backward compatibility unless migration is explicitly desired.
42. Phase 7: Storage dashboards + backup + migration (depends on Phase 1, parallelizable internal tasks)
43. Project page Project Data card: add Uploads row in breakdown.
44. Settings Storage Overview: add Uploads category and include in total.
45. Projects Dashboard Data column: ensure totals include uploads (through project.totalBytes pipeline).
46. Daily S3->local backup: add optional uploads category and wire category key through settings UI, API validation, and backup collector.
47. Local->S3 migration tool: include uploads files and folder-derived keys in referenced manifest and dry-run counts.
48. Phase 8: QA hardening + migration rollout (depends on all prior phases)
49. Add DB migration(s) for new upload domain tables/indexes.
50. Add API tests for role gating, quota enforcement, and delete constraints.
51. Add Share UI smoke checks for root rendering, drag-drop, optimistic progress, and transfer-panel behavior.
52. Add regression checks for existing comment attachment uploads.

## Copy Decisions (Approved)
1. Quota applies to total project uploads (comment attachments + UPLOADS files).
2. Allows authenticated client uploads to the UPLOADS root on the Share page.

## Current Execution Order
1. Phase 6 copy updates in settings UI labels/help text.
2. Phase 1 storage/path + model groundwork.
3. Phase 2 permissions/quota/token longevity.
4. Phase 3 APIs.
5. Phase 4 transfer plumbing.
6. Phase 5 Share Files UI and optimistic upload states.
7. Phase 7 storage/backup/migration updates.
8. Phase 8 QA and rollout checks.

## Additional Ideas (Backlog - Review Later)
These are optional enhancements and are not required to complete the current plan phases.

1. Byte-accurate in-row upload progress using upload-progress events instead of coarse phase status.
2. Resumable uploads for large files (resume interrupted uploads without restarting from zero).
3. Upload conflict policy options (keep both, replace, or skip when file names collide).
4. Folder rename and move operations within UPLOADS with traversal-safe server-side validation.
5. Bulk actions in UPLOADS (multi-select delete and multi-folder upload targeting).
6. Search and filter inside UPLOADS (name, type, date, size).
7. Optional malware scanning hook on completed uploads with quarantine state.
8. Upload activity/audit log entries (who uploaded, deleted, created folders, and when).
9. Optional upload notification events (admin digest or webhook when new uploads arrive).
10. Retention and lifecycle policies for UPLOADS files (age-based cleanup/archival).
