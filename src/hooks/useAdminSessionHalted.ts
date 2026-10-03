'use client'

import { useSyncExternalStore } from 'react'
import { isAdminSessionHalted, subscribeAdminSessionHalt } from '@/lib/api-client'

/**
 * True once this tab's admin session is known dead (see haltAdminSession in
 * api-client). Gate polling / token-refresh effects on it so they stop at the
 * first expiry instead of collecting 401s until the login redirect lands.
 */
export function useAdminSessionHalted(): boolean {
  return useSyncExternalStore(subscribeAdminSessionHalt, isAdminSessionHalted, () => false)
}
