'use client'

import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch } from '@/lib/api-client'
import { Bell, BellOff, Plus, Shield, Trash2 } from 'lucide-react'
import type { ButtonProps } from '@/components/ui/button'
import { InitialsAvatar } from '@/components/InitialsAvatar'

export type AssignableUser = {
  id: string
  name: string | null
  email: string
  username?: string | null
  displayColor?: string | null
  appRole?: { id: string; name: string; isSystemAdmin: boolean } | null
  canAccessSharePage?: boolean
  receiveNotifications?: boolean
}

interface ProjectUsersEditorProps {
  label?: ReactNode
  description?: string
  value: AssignableUser[]
  onChange: (next: AssignableUser[]) => void
  disabled?: boolean
  addButtonLabel?: string
  addButtonIconOnly?: boolean
  addButtonHideLabelOnMobile?: boolean
  addButtonSize?: ButtonProps['size']
  addButtonVariant?: ButtonProps['variant']
  addButtonClassName?: string
}

export function ProjectUsersEditor({
  label = 'Users',
  description = 'Assign internal users who can access this project',
  value,
  onChange,
  disabled = false,
  addButtonLabel = 'Add User',
  addButtonIconOnly = false,
  addButtonHideLabelOnMobile = false,
  addButtonSize = 'sm',
  addButtonVariant = 'default',
  addButtonClassName,
}: ProjectUsersEditorProps) {
  const selectedRaw = useMemo(() => value || [], [value])
  const selected = useMemo(() => {
    const next = [...selectedRaw]
    next.sort((a, b) => {
      const aIsAdmin = a.appRole?.isSystemAdmin === true
      const bIsAdmin = b.appRole?.isSystemAdmin === true
      if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1
      const aName = (a.name || a.email || '').toLowerCase()
      const bName = (b.name || b.email || '').toLowerCase()
      return aName.localeCompare(bName)
    })
    return next
  }, [selectedRaw])
  const [showAddForm, setShowAddForm] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<AssignableUser[]>([])
  const [loading, setLoading] = useState(false)

  const normalizeKey = (u: AssignableUser) => String(u?.id || '')

  const adminCount = useMemo(
    () => selected.filter((u) => u.appRole?.isSystemAdmin === true).length,
    [selected]
  )

  const loadSuggestions = async (q: string, opts?: { allowEmpty?: boolean }) => {
    const trimmed = q.trim()
    if (!trimmed && !opts?.allowEmpty) {
      setSuggestions([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const queryParam = trimmed ? `?query=${encodeURIComponent(trimmed)}` : ''
      const res = await apiFetch(`/api/users/assignable${queryParam}`)
      if (!res.ok) {
        setSuggestions([])
        return
      }
      const data = await res.json()
      setSuggestions((data?.users || []) as AssignableUser[])
    } catch {
      setSuggestions([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!showAddForm) return
    const handle = setTimeout(() => {
      void loadSuggestions(query, { allowEmpty: true })
    }, 200)
    return () => clearTimeout(handle)
  }, [query, showAddForm])

  const addUser = (u: AssignableUser) => {
    if (disabled) return
    const id = normalizeKey(u)
    if (!id) return
    if (selected.some((s) => normalizeKey(s) === id)) return
    onChange([
      ...selected,
      {
        ...u,
        receiveNotifications: u.receiveNotifications !== false,
      },
    ])
    setQuery('')
    setSuggestions([])
    setShowAddForm(false)
  }

  const removeUser = (id: string) => {
    if (disabled) return
    const toRemove = selected.find((u) => normalizeKey(u) === String(id))
    const isRemovingAdmin = toRemove?.appRole?.isSystemAdmin === true
    if (isRemovingAdmin) {
      const adminCount = selected.filter((u) => u.appRole?.isSystemAdmin === true).length
      if (adminCount <= 1) return
    }
    onChange(selected.filter((u) => normalizeKey(u) !== id))
  }

  const toggleNotifications = (id: string) => {
    if (disabled) return
    const next = selected.map((u) => {
      if (normalizeKey(u) !== String(id)) return u

      const roleName = typeof u.appRole?.name === 'string' ? u.appRole.name : ''
      const isAdminRole = u.appRole?.isSystemAdmin === true || roleName.trim().toLowerCase() === 'admin'
      const hasShareAccess = isAdminRole || u.canAccessSharePage !== false
      if (!hasShareAccess) return { ...u, receiveNotifications: false }

      return { ...u, receiveNotifications: !(u.receiveNotifications !== false) }
    })
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {addButtonHideLabelOnMobile ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-medium">{label}</div>
            {String(description || '').trim().length > 0 && (
              <p className="text-xs text-muted-foreground mt-1">{description}</p>
            )}
          </div>
          <div className="flex justify-end shrink-0">
            <Button
              type="button"
              variant={addButtonVariant}
              size={addButtonSize}
              onClick={() => {
                if (disabled) return
                setShowAddForm(true)
                void loadSuggestions('', { allowEmpty: true })
              }}
              disabled={disabled || showAddForm}
              className={addButtonClassName}
            >
              <Plus className={addButtonIconOnly ? 'w-4 h-4' : 'w-4 h-4 sm:mr-2'} />
              {!addButtonIconOnly && (
                <span className="hidden sm:inline">{addButtonLabel}</span>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-base font-medium">{label}</div>
            {String(description || '').trim().length > 0 && (
              <p className="text-xs text-muted-foreground mt-1">{description}</p>
            )}
          </div>
          <div className="w-full sm:w-64 flex justify-end">
            <Button
              type="button"
              variant={addButtonVariant}
              size={addButtonSize}
              onClick={() => {
                if (disabled) return
                setShowAddForm(true)
                void loadSuggestions('', { allowEmpty: true })
              }}
              disabled={disabled || showAddForm}
              className={addButtonClassName || 'w-full'}
            >
              <Plus className={addButtonIconOnly ? 'w-4 h-4' : 'w-4 h-4 mr-2'} />
              {!addButtonIconOnly && <span>{addButtonLabel}</span>}
            </Button>
          </div>
        </div>
      )}

      {selected.length === 0 && !showAddForm ? (
        <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
          No users assigned yet.
        </div>
      ) : (
        <div className="space-y-2">
          {selected.map((u) => {
            const roleName = typeof u.appRole?.name === 'string' ? u.appRole.name : ''
            const isAdminRole = u.appRole?.isSystemAdmin === true || roleName.trim().toLowerCase() === 'admin'
            const hasShareAccess = isAdminRole || u.canAccessSharePage !== false

            const shareEmailOptIn = hasShareAccess && u.receiveNotifications !== false
            const bellDisabled = disabled || !hasShareAccess
            const notificationTitle = !hasShareAccess
              ? 'No Share Page Access'
              : shareEmailOptIn
                ? 'Share-page activity emails enabled'
                : 'Share-page activity emails disabled'

            return (
              <div key={u.id} className="border rounded-lg bg-card">
              <div className="flex items-start justify-between gap-2 p-3">
                <div className="flex-1 space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <InitialsAvatar name={u.name} email={u.email} displayColor={u.displayColor} />
                    <span className="text-sm font-medium truncate">{u.name || u.email}</span>
                    {u.appRole?.isSystemAdmin === true && (
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground border border-border flex-shrink-0">
                        <Shield className="w-3 h-3" />
                        Admin
                      </span>
                    )}
                    {u.appRole?.isSystemAdmin !== true && u.appRole?.name && (
                      <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground border border-border flex-shrink-0">
                        {u.appRole.name}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                </div>

                <div className="flex items-center justify-end gap-2 flex-shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => toggleNotifications(u.id)}
                    disabled={bellDisabled}
                    title={notificationTitle}
                    aria-label={notificationTitle}
                    className={
                      shareEmailOptIn
                        ? 'text-success hover:text-success hover:bg-success-visible'
                        : 'text-muted-foreground hover:text-muted-foreground'
                    }
                  >
                    {shareEmailOptIn ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => removeUser(u.id)}
                    disabled={disabled || (u.appRole?.isSystemAdmin === true && adminCount <= 1)}
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {showAddForm && (
        <div className="border rounded-lg bg-card p-4 space-y-3">
          <div className="space-y-2">
            <Label htmlFor="project-user-search">Search Users</Label>
            <Input
              id="project-user-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search users..."
              autoFocus
              onFocus={() => void loadSuggestions(query, { allowEmpty: true })}
            />
          </div>

          <div className="space-y-1">
            {loading ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : suggestions.length === 0 ? (
              <div className="text-xs text-muted-foreground">No matching users.</div>
            ) : (
              <div className="border rounded-md overflow-hidden">
                {suggestions.map((u) => {
                  const isSelected = selected.some((s) => normalizeKey(s) === normalizeKey(u))
                  return (
                    <button
                      key={u.id}
                      type="button"
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-muted ${isSelected ? 'opacity-50 cursor-not-allowed' : ''}`}
                      onClick={() => {
                        if (isSelected) return
                        addUser(u)
                      }}
                      disabled={isSelected}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <InitialsAvatar name={u.name} email={u.email} displayColor={u.displayColor} />
                            <div className="font-medium truncate">{u.name || u.email}</div>
                            {u.appRole?.isSystemAdmin === true && (
                              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground border border-border flex-shrink-0">
                                <Shield className="w-3 h-3" />
                                Admin
                              </span>
                            )}
                            {u.appRole?.isSystemAdmin !== true && u.appRole?.name && (
                              <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground border border-border flex-shrink-0">
                                {u.appRole.name}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setShowAddForm(false)
                setQuery('')
                setSuggestions([])
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
