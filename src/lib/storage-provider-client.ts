'use client'

/**
 * Runtime storage-provider detection for client-side code.
 *
 * NEXT_PUBLIC_* variables are baked into the JS bundle at build time, so
 * pre-built Docker images cannot reflect a user's STORAGE_PROVIDER setting.
 * This module fetches the active provider from the server on first call and
 * caches it for the lifetime of the page — exactly like transfer-tuning-client.
 *
 * Usage in async callbacks (upload hooks):
 *   const isS3 = await isS3Mode()
 *   if (isS3) { ... }
 *
 * Usage in React components:
 *   const { isS3Mode, loading } = useStorageProvider()
 */

import { useEffect, useState } from 'react'

type StorageProvider = 'local' | 's3' | 'dropbox'

// Build-time hint from NEXT_PUBLIC_STORAGE_PROVIDER (may be stale for pre-built images).
// Used only as the initial synchronous value before the API response arrives.
const BUILD_TIME_PROVIDER = (
  (process.env.NEXT_PUBLIC_STORAGE_PROVIDER ?? 'local') as StorageProvider
)

let cachedProvider: StorageProvider | null = null
let providerRequest: Promise<StorageProvider> | null = null

/**
 * Fetch the storage provider from the server, with module-level caching.
 * Subsequent calls within the same page session return the cached value.
 */
async function fetchStorageProvider(): Promise<StorageProvider> {
  if (cachedProvider !== null) return cachedProvider

  if (!providerRequest) {
    providerRequest = fetch('/api/meta/storage-provider', {
      method: 'GET',
      credentials: 'same-origin',
    })
      .then(async (r) => {
        if (!r.ok) return BUILD_TIME_PROVIDER
        const data = await r.json()
        const p = data?.provider
        return (p === 's3' || p === 'dropbox' ? p : 'local') as StorageProvider
      })
      .catch(() => BUILD_TIME_PROVIDER)
      .then((value) => {
        cachedProvider = value
        return value
      })
      .finally(() => {
        providerRequest = null
      })
  }

  return providerRequest
}

/**
 * Async helper for use inside upload callbacks.
 * Resolves almost instantly after the first call (returns cached value).
 */
export async function isS3Mode(): Promise<boolean> {
  return (await fetchStorageProvider()) === 's3'
}

/**
 * React hook — mirrors useTransferTuning in structure.
 * Starts with the build-time hint and updates once the API resolves.
 */
export function useStorageProvider(): { provider: StorageProvider; isS3Mode: boolean; loading: boolean } {
  const [provider, setProvider] = useState<StorageProvider>(cachedProvider ?? BUILD_TIME_PROVIDER)
  const [loading, setLoading] = useState<boolean>(cachedProvider === null)

  useEffect(() => {
    if (cachedProvider !== null) {
      setProvider(cachedProvider)
      setLoading(false)
      return
    }

    let active = true
    void fetchStorageProvider().then((value) => {
      if (active) {
        setProvider(value)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [])

  return { provider, isS3Mode: provider === 's3', loading }
}
