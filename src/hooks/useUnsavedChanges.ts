'use client'

import { useEffect, useCallback, useRef } from 'react'

const DEFAULT_CONFIRM_MESSAGE = 'You have unsaved changes. Are you sure you want to leave?'

interface UseUnsavedChangesOptions {
  message?: string
  onDiscard?: () => void
}

function isSameDocumentNavigation(nextUrl: URL) {
  return nextUrl.origin === window.location.origin &&
    nextUrl.pathname === window.location.pathname &&
    nextUrl.search === window.location.search
}

/**
 * Hook that warns users when they try to navigate away with unsaved changes.
 * Handles:
 *  - browser close / reload (beforeunload)
 *  - Next.js App Router client-side navigation (history.pushState / replaceState)
 *  - browser back / forward (popstate)
 *
 * @param hasUnsavedChanges - whether the form currently has unsaved changes
 */
export function useUnsavedChanges(
  hasUnsavedChanges: boolean,
  options: UseUnsavedChangesOptions = {}
) {
  const dirtyRef = useRef(hasUnsavedChanges)
  const messageRef = useRef(options.message || DEFAULT_CONFIRM_MESSAGE)
  const onDiscardRef = useRef(options.onDiscard)
  const allowedHistoryTransitionsRef = useRef(0)

  useEffect(() => {
    dirtyRef.current = hasUnsavedChanges
  }, [hasUnsavedChanges])

  useEffect(() => {
    messageRef.current = options.message || DEFAULT_CONFIRM_MESSAGE
    onDiscardRef.current = options.onDiscard
  }, [options.message, options.onDiscard])

  const consumeAllowedHistoryTransition = useCallback(() => {
    if (allowedHistoryTransitionsRef.current <= 0) return false
    allowedHistoryTransitionsRef.current -= 1
    return true
  }, [])

  const confirmNavigation = useCallback((preApproveNextHistoryTransition = true): boolean => {
    if (!dirtyRef.current) return true

    const shouldLeave = window.confirm(messageRef.current)
    if (!shouldLeave) return false

    if (preApproveNextHistoryTransition) {
      allowedHistoryTransitionsRef.current = 2
    }

    onDiscardRef.current?.()
    return true
  }, [])

  // Browser close / reload guard
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Intercept Next.js App Router client-side navigation (pushState / replaceState)
  // and browser back/forward (popstate).
  useEffect(() => {
    const originalPushState = history.pushState.bind(history)
    const originalReplaceState = history.replaceState.bind(history)
    let revertingPopstate = false

    history.pushState = function (data: any, unused: string, url?: string | URL | null) {
      if (consumeAllowedHistoryTransition()) {
        return originalPushState(data, unused, url)
      }

      if (dirtyRef.current && !confirmNavigation(false)) {
        return // block navigation
      }

      return originalPushState(data, unused, url)
    }

    history.replaceState = function (data: any, unused: string, url?: string | URL | null) {
      if (consumeAllowedHistoryTransition()) {
        return originalReplaceState(data, unused, url)
      }

      // Allow same-URL replaceState calls (scroll restoration, hash changes, etc.)
      if (url) {
        const nextUrl = new URL(url, location.href)
        if (!isSameDocumentNavigation(nextUrl) && dirtyRef.current && !confirmNavigation(false)) {
          return
        }
      }

      return originalReplaceState(data, unused, url)
    }

    const handleDocumentClick = (event: MouseEvent) => {
      if (!dirtyRef.current) return
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(target instanceof HTMLAnchorElement)) return
      if (target.target && target.target !== '_self') return
      if (target.hasAttribute('download')) return

      const href = target.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return

      const nextUrl = new URL(target.href, window.location.href)
      if (isSameDocumentNavigation(nextUrl)) return

      if (!confirmNavigation(true)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    const handlePopState = () => {
      if (revertingPopstate) {
        revertingPopstate = false
        return
      }

      if (consumeAllowedHistoryTransition()) return
      if (!dirtyRef.current) return
      if (!confirmNavigation(false)) {
        revertingPopstate = true
        history.go(1)
      }
    }

    document.addEventListener('click', handleDocumentClick, true)
    window.addEventListener('popstate', handlePopState)

    return () => {
      history.pushState = originalPushState
      history.replaceState = originalReplaceState
      document.removeEventListener('click', handleDocumentClick, true)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [confirmNavigation, consumeAllowedHistoryTransition])

  return { confirmNavigation }
}
