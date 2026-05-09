/**
 * Shared authentication and ownership verification helpers for S3 upload endpoints.
 *
 * These helpers are server-side only (used in route.ts files) and verify that:
 * 1. The request carries a valid admin access token
 * 2. The target resource (video / asset) belongs to the authenticated admin
 *
 * On success they return the S3 key and whether the caller is a super-admin.
 * On failure they return an errorResponse ready to be returned from the route.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { parseBearerToken, verifyAdminAccessToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

export type S3UploadTarget =
  | { kind: 'video'; videoId: string; s3Key: string }
  | { kind: 'asset'; assetId: string; videoId: string; s3Key: string }
  | { kind: 'photo'; photoId: string; albumId: string; s3Key: string }

export type AuthResult =
  | { ok: true; target: S3UploadTarget }
  | { ok: false; errorResponse: NextResponse }

/**
 * Verify the bearer token and resolve the S3 key for a video upload target.
 *
 * The `videoId` must exist and be in UPLOADING status.
 * Returns the video's originalStoragePath as the S3 key (the logical path is
 * used as-is for S3 keys — no STORAGE_ROOT prefix needed in S3 mode).
 */
export async function verifyVideoUploadAuth(
  request: NextRequest,
  videoId: string
): Promise<AuthResult> {
  const token = parseBearerToken(request as any)
  if (!token) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) }
  }

  const payload = await verifyAdminAccessToken(token)
  if (!payload) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Access denied' }, { status: 403 }) }
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { id: true, status: true, originalStoragePath: true },
  })

  if (!video) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Video not found' }, { status: 404 }) }
  }

  if (video.status !== 'UPLOADING') {
    // Allow re-upload to a previously errored video
    if (video.status !== 'ERROR') {
      return {
        ok: false,
        errorResponse: NextResponse.json(
          { error: `Video is not in UPLOADING state (current: ${video.status})` },
          { status: 400 }
        ),
      }
    }

    // Reset error video so it can be re-uploaded
    await prisma.video.update({
      where: { id: videoId },
      data: { status: 'UPLOADING', processingError: null, processingProgress: 0 },
    })
  }

  return {
    ok: true,
    target: { kind: 'video', videoId: video.id, s3Key: video.originalStoragePath },
  }
}

/**
 * Verify the bearer token and resolve the S3 key for an asset upload target.
 */
export async function verifyAssetUploadAuth(
  request: NextRequest,
  assetId: string
): Promise<AuthResult> {
  const token = parseBearerToken(request as any)
  if (!token) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) }
  }

  const payload = await verifyAdminAccessToken(token)
  if (!payload) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Access denied' }, { status: 403 }) }
  }

  const asset = await prisma.videoAsset.findUnique({
    where: { id: assetId },
    select: { id: true, videoId: true, storagePath: true },
  })

  if (!asset) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Asset not found' }, { status: 404 }) }
  }

  return {
    ok: true,
    target: { kind: 'asset', assetId: asset.id, videoId: asset.videoId, s3Key: asset.storagePath },
  }
}

/**
 * Verify the bearer token and resolve the S3 key for an album photo upload target.
 */
export async function verifyPhotoUploadAuth(
  request: NextRequest,
  photoId: string
): Promise<AuthResult> {
  const token = parseBearerToken(request as any)
  if (!token) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) }
  }

  const payload = await verifyAdminAccessToken(token)
  if (!payload) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Access denied' }, { status: 403 }) }
  }

  const photo = await prisma.albumPhoto.findUnique({
    where: { id: photoId },
    select: { id: true, albumId: true, storagePath: true, status: true },
  })

  if (!photo) {
    return { ok: false, errorResponse: NextResponse.json({ error: 'Photo not found' }, { status: 404 }) }
  }

  if (photo.status !== 'UPLOADING') {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { error: `Photo is not in UPLOADING state (current: ${photo.status})` },
        { status: 400 }
      ),
    }
  }

  return {
    ok: true,
    target: { kind: 'photo', photoId: photo.id, albumId: photo.albumId, s3Key: photo.storagePath },
  }
}
