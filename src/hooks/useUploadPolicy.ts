'use client'

import { useEffect, useState } from 'react'
import { DEFAULT_CLIENT_UPLOAD_POLICY, type ClientUploadPolicy } from '@/lib/upload-policy'

/**
 * The system-wide client upload type policy, fetched once per page load and shared by every
 * consumer. Used to pre-check a file selection and to render the "Supported file types" list;
 * the server re-checks the policy on every upload route, so a stale or failed fetch degrades
 * to a rejection at upload time rather than letting anything through.
 */
let cached: ClientUploadPolicy | null = null
let inFlight: Promise<ClientUploadPolicy> | null = null

async function loadUploadPolicy(): Promise<ClientUploadPolicy> {
  if (cached) return cached
  if (!inFlight) {
    inFlight = fetch('/api/upload-policy')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const policy: ClientUploadPolicy = data
          ? {
              categories: Array.isArray(data.categories) ? data.categories : [],
              customExtensions: Array.isArray(data.customExtensions) ? data.customExtensions : [],
            }
          : DEFAULT_CLIENT_UPLOAD_POLICY
        cached = policy
        return policy
      })
      .catch(() => DEFAULT_CLIENT_UPLOAD_POLICY)
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

export function useUploadPolicy(): ClientUploadPolicy {
  const [policy, setPolicy] = useState<ClientUploadPolicy>(cached ?? DEFAULT_CLIENT_UPLOAD_POLICY)

  useEffect(() => {
    let active = true
    loadUploadPolicy().then((loaded) => {
      if (active) setPolicy(loaded)
    })
    return () => {
      active = false
    }
  }, [])

  return policy
}
