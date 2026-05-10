/**
 * S3-compatible storage library for Cloudflare R2.
 *
 * This module is the single source of truth for all S3 operations.
 * It is only active when STORAGE_PROVIDER=s3. All other code branches on
 * isS3Mode() before calling anything here.
 *
 * R2 compatibility notes:
 * - requestChecksumCalculation / responseChecksumValidation must be
 *   'WHEN_REQUIRED' to avoid 400/501 errors from R2.
 * - forcePathStyle should be true for custom endpoint URLs.
 * - Region is always 'auto' for R2.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'stream'

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

// In development, Next.js hot-reloads modules but `globalThis` persists across
// reloads. Store the singleton there so we don't create a new S3Client on every
// file-save, while still letting env-var changes take effect after a full restart.
const g = globalThis as typeof globalThis & { __s3Client?: S3Client }

export function isS3Mode(): boolean {
  return process.env.STORAGE_PROVIDER === 's3'
}

export function getS3Client(): S3Client {
  if (g.__s3Client) return g.__s3Client

  const endpoint = process.env.S3_ENDPOINT?.trim()
  const region = process.env.S3_REGION?.trim() || 'auto'
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim()

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 storage is not fully configured: missing S3_ENDPOINT, S3_ACCESS_KEY_ID, or S3_SECRET_ACCESS_KEY'
    )
  }

  g.__s3Client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    // Required for R2 and other S3-compatible endpoints
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    // Prevent 400/501 errors on R2 — these options tell the SDK not to
    // calculate/validate checksums unless the server explicitly requests them.
    requestChecksumCalculation: 'WHEN_REQUIRED' as any,
    responseChecksumValidation: 'WHEN_REQUIRED' as any,
  })

  return g.__s3Client
}

export function getS3Bucket(): string {
  const bucket = process.env.S3_BUCKET?.trim()
  if (!bucket) throw new Error('S3_BUCKET is not configured')
  return bucket
}

// ---------------------------------------------------------------------------
// Basic file operations
// ---------------------------------------------------------------------------

/** Upload a file to S3. Uses multipart for files over MULTIPART_THRESHOLD_BYTES. */
export async function s3UploadFile(
  key: string,
  body: Readable | Buffer,
  contentType: string,
  size: number
): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: size,
    })
  )
}

/** Download a file from S3. Returns the stream and the object's byte length (0 if unknown). */
export async function s3DownloadFile(key: string): Promise<{ stream: Readable; contentLength: number }> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  )

  if (!response.Body) {
    throw new Error(`S3 object has no body: ${key}`)
  }

  return {
    stream: response.Body as unknown as Readable,
    contentLength: response.ContentLength ?? 0,
  }
}

/** Delete a single file from S3. Silently ignores 404 (file already gone). */
export async function s3DeleteFile(key: string): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  )
}

/**
 * Delete all objects whose key starts with the given prefix (simulates directory delete).
 * Processes in batches of 1000 (S3 DeleteObjects limit).
 */
export async function s3DeleteDirectory(prefix: string): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  // Ensure prefix ends with '/' to avoid matching neighbouring "directories"
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`

  let continuationToken: string | undefined

  do {
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    )

    const objects = listResponse.Contents ?? []
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map((obj) => ({ Key: obj.Key! })),
            Quiet: true,
          },
        })
      )
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined
  } while (continuationToken)
}

/** Check whether a key exists in S3. */
export async function s3FileExists(key: string): Promise<boolean> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (err: any) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false
    throw err
  }
}

/** Get the size of an S3 object in bytes. Returns null if the object doesn't exist. */
export async function s3GetFileSize(key: string): Promise<number | null> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return response.ContentLength ?? null
  } catch (err: any) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null
    throw err
  }
}

/**
 * Sum the size of all objects under a prefix.
 * Useful for logical directories such as timeline sprite folders.
 */
export async function s3SumPrefixSize(prefix: string): Promise<number> {
  const client = getS3Client()
  const bucket = getS3Bucket()
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`

  let continuationToken: string | undefined
  let total = 0

  do {
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    )

    for (const obj of listResponse.Contents ?? []) {
      total += Number(obj.Size || 0)
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined
  } while (continuationToken)

  return Math.max(0, total)
}

// ---------------------------------------------------------------------------
// Presigned URLs
// ---------------------------------------------------------------------------

/**
 * Generate a presigned GET URL for streaming (no Content-Disposition header).
 * Used for video/image streaming directly from R2.
 */
export async function s3GetPresignedStreamUrl(
  key: string,
  expiresInSeconds: number,
  contentType?: string
): Promise<string> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  })

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

/**
 * Generate a presigned GET URL for file download (sets Content-Disposition: attachment).
 */
export async function s3GetPresignedDownloadUrl(
  key: string,
  expiresInSeconds: number,
  filename: string,
  contentType?: string
): Promise<string> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    // RFC 6266 / RFC 5987: use filename* for proper UTF-8 encoding.
    // The plain filename= fallback (ASCII-safe) handles older clients.
    ResponseContentDisposition:
      `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  })

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

// ---------------------------------------------------------------------------
// Server-side multipart upload (for worker output uploads)
// ---------------------------------------------------------------------------

/**
 * Initiate a multipart upload and return the upload ID.
 */
export async function s3InitiateMultipartUpload(
  key: string,
  contentType: string
): Promise<string> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const response = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    })
  )

  if (!response.UploadId) {
    throw new Error(`Failed to initiate multipart upload for key: ${key}`)
  }

  return response.UploadId
}

/**
 * Generate a presigned URL for uploading a single part of a multipart upload.
 * The browser uses this to PUT directly to R2 without going through the server.
 */
export async function s3GetPresignedPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds: number = 3600
): Promise<string> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  })

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export type CompletedPart = { ETag: string; PartNumber: number }

/**
 * Complete a multipart upload with the list of uploaded parts and their ETags.
 */
export async function s3CompleteMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[]
): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ ETag: p.ETag, PartNumber: p.PartNumber })),
      },
    })
  )
}

/**
 * Abort a multipart upload, releasing any stored parts.
 */
export async function s3AbortMultipartUpload(
  key: string,
  uploadId: string
): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    })
  )
}

/**
 * List and abort all incomplete multipart uploads older than `ageMs` milliseconds.
 * Call this from a maintenance job to prevent orphaned parts accumulating costs.
 */
export async function s3AbortIncompleteMultipartUploadsOlderThan(
  prefix: string,
  ageMs: number
): Promise<number> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const cutoff = new Date(Date.now() - ageMs)
  let aborted = 0
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined

  do {
    const response = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      })
    )

    const uploads = response.Uploads ?? []
    for (const upload of uploads) {
      if (upload.Initiated && upload.Initiated < cutoff && upload.Key && upload.UploadId) {
        try {
          await s3AbortMultipartUpload(upload.Key, upload.UploadId)
          aborted++
        } catch {
          // Best-effort: log and continue
        }
      }
    }

    if (response.IsTruncated) {
      keyMarker = response.NextKeyMarker
      uploadIdMarker = response.NextUploadIdMarker
    } else {
      break
    }
  } while (true)

  return aborted
}
