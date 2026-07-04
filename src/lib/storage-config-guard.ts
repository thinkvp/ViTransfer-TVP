/**
 * Storage-config drift guard for the split app/worker topology.
 *
 * The web app (VPS) and the worker (NAS) are separate hosts with separate env
 * files, but they share one database and one storage backend. If they ever
 * disagree on STORAGE_PROVIDER / bucket / endpoint (e.g. the worker comes up in
 * local mode while the app is on R2), the worker writes files the app can't
 * serve and registers unreachable paths into the shared StoredFile registry —
 * silently, until users see broken previews.
 *
 * Each process publishes a fingerprint of its storage config to Redis at startup
 * and compares against the other process's fingerprint. A mismatch is loudly
 * logged on both sides. After an intentional config change the warning persists
 * until BOTH processes have restarted onto the new config — which is exactly the
 * reminder wanted.
 */

import { getRedis } from './redis'

const KEY_PREFIX = 'vitransfer:storage-config:'

export type StorageConfigRole = 'app' | 'worker'

function storageConfigFingerprint(): string {
  if (process.env.STORAGE_PROVIDER === 's3') {
    return JSON.stringify({
      provider: 's3',
      bucket: process.env.S3_BUCKET?.trim() || '',
      endpoint: process.env.S3_ENDPOINT?.trim() || '',
    })
  }
  return JSON.stringify({ provider: 'local' })
}

/**
 * Publish this process's storage config and warn if the counterpart process
 * (app ⇄ worker) last reported a different one. Never throws — a guard must not
 * take the service down.
 */
export async function publishAndCheckStorageConfig(role: StorageConfigRole): Promise<void> {
  try {
    const redis = getRedis()
    const fingerprint = storageConfigFingerprint()

    await redis.set(
      `${KEY_PREFIX}${role}`,
      JSON.stringify({ fingerprint, reportedAt: new Date().toISOString() }),
    )

    const otherRole: StorageConfigRole = role === 'app' ? 'worker' : 'app'
    const otherRaw = await redis.get(`${KEY_PREFIX}${otherRole}`)
    if (!otherRaw) return

    const other = JSON.parse(otherRaw) as { fingerprint?: string; reportedAt?: string }
    if (other.fingerprint && other.fingerprint !== fingerprint) {
      console.error(
        `[STORAGE-CONFIG] MISMATCH between app and worker storage configuration!\n` +
        `  this ${role}: ${fingerprint}\n` +
        `  ${otherRole} (reported ${other.reportedAt ?? 'unknown'}): ${other.fingerprint}\n` +
        `  Files written by the misconfigured process will be unreachable by the other. ` +
        `Fix the ${otherRole === 'worker' ? 'NAS worker' : 'VPS app'} env (STORAGE_PROVIDER/S3_BUCKET/S3_ENDPOINT) ` +
        `and restart both processes.`
      )
    }
  } catch (err) {
    // Redis unavailable at boot — skip the check rather than delaying startup.
    console.warn('[STORAGE-CONFIG] Could not verify storage config consistency:', err instanceof Error ? err.message : err)
  }
}
