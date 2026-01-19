'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users, UserPlus, Trash2, Plus, Shield, ShieldOff, Check } from 'lucide-react'
import { apiDelete, apiFetch, apiPatch, apiPost } from '@/lib/api-client'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { defaultRolePermissions, normalizeRolePermissions, type RolePermissions } from '@/lib/rbac'
import { PROJECT_STATUS_OPTIONS, projectStatusBadgeClass, type ProjectStatus } from '@/lib/project-status'
import { cn } from '@/lib/utils'

interface User {
  id: string
  email: string
  username: string | null
  name: string | null
  displayColor: string | null
  appRoleId: string
  appRole: { id: string; name: string; isSystemAdmin: boolean }
  createdAt: string
  updatedAt: string
}

interface Role {
  id: string
  name: string
  isSystemAdmin: boolean
  permissions: unknown
  userCount: number
}

type PermissionGroup = {
  key: keyof RolePermissions['menuVisibility']
  label: string
  actions: Array<{ key: keyof RolePermissions['actions']; label: string }>
}

const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'projects',
    label: 'Projects',
    actions: [
      { key: 'accessProjectSettings', label: 'Access project settings' },
      { key: 'changeProjectSettings', label: 'Change project settings' },
      { key: 'uploadFilesToProjectInternal', label: 'Upload internal project files' },
      { key: 'uploadVideosOnProjects', label: 'Upload videos' },
      { key: 'manageProjectAlbums', label: 'Manage albums' },
      { key: 'sendNotificationsToRecipients', label: 'Send notifications to recipients' },
      { key: 'makeCommentsOnProjects', label: 'Make internal comments' },
      { key: 'changeProjectStatuses', label: 'Change project statuses' },
      { key: 'deleteProjects', label: 'Delete projects' },
    ],
  },
  {
    key: 'clients',
    label: 'Clients',
    actions: [
      { key: 'manageClients', label: 'Create/edit/delete clients' },
      { key: 'manageClientFiles', label: 'Manage client files' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    actions: [],
  },
  {
    key: 'settings',
    label: 'Settings',
    actions: [
      { key: 'changeSettings', label: 'Change global settings' },
      { key: 'sendTestEmail', label: 'Send test email' },
    ],
  },
  {
    key: 'users',
    label: 'Users',
    actions: [
      { key: 'manageUsers', label: 'Create/edit/delete users' },
      { key: 'manageRoles', label: 'Create/edit/delete roles' },
    ],
  },
  {
    key: 'security',
    label: 'Security',
    actions: [
      { key: 'viewSecurityEvents', label: 'View security events' },
      { key: 'manageSecurityEvents', label: 'Delete/purge security events' },
      { key: 'viewSecurityBlocklists', label: 'View blocklists' },
      { key: 'manageSecurityBlocklists', label: 'Manage blocklists' },
      { key: 'viewSecurityRateLimits', label: 'View rate limits' },
      { key: 'manageSecurityRateLimits', label: 'Clear rate limits' },
    ],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    actions: [
      { key: 'viewAnalytics', label: 'View analytics' },
    ],
  },
]

export default function UsersPage() {
  const router = useRouter()
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [rolesLoading, setRolesLoading] = useState(false)
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)
  const [roleDialogMode, setRoleDialogMode] = useState<'create' | 'edit'>('create')
  const [roleDialogError, setRoleDialogError] = useState('')
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null)
  const [roleName, setRoleName] = useState('')
  const [rolePermissions, setRolePermissions] = useState<RolePermissions>(() => defaultRolePermissions())

  useEffect(() => {
    void fetchUsersAndRoles()
  }, [])

  const fetchUsersAndRoles = async () => {
    try {
      const [usersRes, rolesRes] = await Promise.all([
        apiFetch('/api/users'),
        apiFetch('/api/roles'),
      ])

      if (!usersRes.ok) throw new Error('Failed to fetch users')
      if (!rolesRes.ok) throw new Error('Failed to fetch roles')

      const usersData = await usersRes.json()
      const rolesData = await rolesRes.json()

      setUsers(usersData.users)
      setRoles(rolesData.roles)
    } catch (err) {
      setError('Failed to load users')
    } finally{
      setLoading(false)
    }
  }

  const handleDelete = async (userId: string, userEmail: string) => {
    if (!confirm(`Are you sure you want to delete user ${userEmail}?`)) {
      return
    }

    try {
      await apiDelete(`/api/users/${userId}`)

      // Refresh user list
      void fetchUsersAndRoles()
    } catch (err: any) {
      alert(err.message)
    }
  }

  const openCreateRole = () => {
    setRoleDialogMode('create')
    setActiveRoleId(null)
    setRoleDialogError('')
    setRoleName('')
    setRolePermissions(defaultRolePermissions())
    setRoleDialogOpen(true)
  }

  const openEditRole = (role: Role) => {
    setRoleDialogMode('edit')
    setActiveRoleId(role.id)
    setRoleDialogError('')
    setRoleName(role.name)
    setRolePermissions(normalizeRolePermissions(role.permissions))
    setRoleDialogOpen(true)
  }

  const toggleStatus = (status: ProjectStatus) => {
    setRolePermissions((prev) => {
      const next = { ...prev, projectVisibility: { ...prev.projectVisibility } }
      const existing = new Set(prev.projectVisibility.statuses)
      if (existing.has(status)) existing.delete(status)
      else existing.add(status)
      next.projectVisibility.statuses = [...existing]
      return next
    })
  }

  const toggleArea = (area: keyof RolePermissions['menuVisibility'], enabled: boolean) => {
    setRolePermissions((prev) => {
      const group = PERMISSION_GROUPS.find((g) => g.key === area)
      const nextActions = { ...prev.actions }

      // If disabling the area, clear all child actions (prevents "hidden enabled" permissions)
      if (!enabled && group) {
        for (const a of group.actions) {
          nextActions[a.key] = false
        }
      }

      return {
        ...prev,
        menuVisibility: { ...prev.menuVisibility, [area]: enabled },
        actions: nextActions,
      }
    })
  }

  const saveRole = async () => {
    setRoleDialogError('')
    setRolesLoading(true)
    try {
      const payload = {
        name: roleName,
        permissions: rolePermissions,
      }

      if (roleDialogMode === 'create') {
        await apiPost('/api/roles', payload)
      } else {
        await apiPatch(`/api/roles/${activeRoleId}`, payload)
      }

      setRoleDialogOpen(false)
      void fetchUsersAndRoles()
    } catch (err: any) {
      setRoleDialogError(err?.message || 'Operation failed')
    } finally {
      setRolesLoading(false)
    }
  }

  const deleteRole = async (role: Role) => {
    if (role.isSystemAdmin) return
    if (role.userCount > 0) return
    if (!confirm(`Delete role "${role.name}"?`)) return
    try {
      await apiDelete(`/api/roles/${role.id}`)
      void fetchUsersAndRoles()
    } catch (err: any) {
      alert(err?.message || 'Operation failed')
    }
  }

  if (loading) {
    return (
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <p className="text-muted-foreground">Loading users...</p>
      </div>
    )
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <Users className="w-7 h-7 sm:w-8 sm:h-8" />
            User Management
          </h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Manage internal users and their roles.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>Users</CardTitle>
            <Button variant="default" size="default" onClick={() => router.push('/admin/users/new')}>
              <UserPlus className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Add New User</span>
            </Button>
          </CardHeader>
          <CardContent>
            {users.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">
                No users found. Create your first user to get started.
              </div>
            ) : (
              <div className="rounded-md border border-border bg-card overflow-hidden">
                <div className="w-full overflow-auto">
                  <table className="w-full table-fixed text-sm min-w-[340px] md:min-w-[520px]">
                    <thead className="bg-muted/40">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[55%]">User</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[140px] hidden md:table-cell">Username</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[220px] hidden md:table-cell">Email</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[35%]">Role</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[130px] hidden md:table-cell">Colour</th>
                        <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-muted-foreground w-[64px] whitespace-nowrap">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr
                          key={user.id}
                          className="border-b border-border last:border-b-0 hover:bg-muted/40 cursor-pointer"
                          onClick={() => router.push(`/admin/users/${user.id}`)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              router.push(`/admin/users/${user.id}`)
                            }
                          }}
                        >
                          <td className="px-3 py-2">
                            <div className="font-medium truncate">{user.name || user.username || user.email}</div>
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">
                            {user.username ? `@${user.username}` : '—'}
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">{user.email}</td>
                          <td className="px-3 py-2">
                            <span className={cn(
                              'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border',
                              user.appRole?.isSystemAdmin
                                ? 'bg-info-visible text-info border-2 border-info-visible'
                                : 'bg-muted text-muted-foreground border border-border'
                            )}>
                              {user.appRole?.isSystemAdmin ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                              <span className="truncate">{user.appRole?.name || '—'}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell">
                            <div className="flex items-center gap-2">
                              <span
                                className="h-4 w-4 rounded-full border border-border"
                                style={{ backgroundColor: user.displayColor || 'transparent' }}
                                aria-label={user.displayColor ? `Display colour ${user.displayColor}` : 'Display colour'}
                              />
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="inline-flex items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                aria-label="Delete user"
                                title="Delete"
                                onPointerDown={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                onKeyDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void handleDelete(user.id, user.email)
                                }}
                              >
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
      </Card>

      <div className="mt-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>Roles</CardTitle>
              <Button variant="default" onClick={openCreateRole}>
                <Plus className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Add New Role</span>
              </Button>
            </CardHeader>
            <CardContent>
              {roles.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">No roles found.</div>
              ) : (
                <div className="rounded-md border border-border bg-card overflow-hidden">
                  <div className="w-full overflow-auto">
                    <table className="w-full table-fixed text-sm min-w-[280px] sm:min-w-[420px]">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[70%]">Role</th>
                          <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[100px] hidden sm:table-cell">Users</th>
                          <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-muted-foreground w-[64px] whitespace-nowrap">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roles.map((role) => {
                          const canEdit = !role.isSystemAdmin && role.id !== 'role_admin'
                          const canDelete = canEdit && role.userCount === 0
                          return (
                            <tr
                              key={role.id}
                              className={cn(
                                'border-b border-border last:border-b-0 hover:bg-muted/40',
                                canEdit && 'cursor-pointer'
                              )}
                              onClick={() => {
                                if (!canEdit) return
                                openEditRole(role)
                              }}
                              role={canEdit ? 'button' : undefined}
                              tabIndex={canEdit ? 0 : -1}
                              onKeyDown={(e) => {
                                if (!canEdit) return
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  openEditRole(role)
                                }
                              }}
                            >
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span className={cn(
                                    'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border',
                                    role.isSystemAdmin
                                      ? 'bg-info-visible text-info border-2 border-info-visible'
                                      : 'bg-muted text-muted-foreground border border-border'
                                  )}>
                                    {role.isSystemAdmin ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                                    <span className="truncate">{role.name}</span>
                                  </span>
                                  {!canEdit && (
                                    <span className="text-xs text-muted-foreground">Protected</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">{role.userCount}</td>
                              <td className="px-2 py-2 text-right">
                                <div className="inline-flex items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-9 w-9 p-0"
                                    aria-label="Delete role"
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void deleteRole(role)
                                    }}
                                    disabled={!canDelete}
                                    title={!canDelete ? (role.userCount > 0 ? 'Role has assigned users' : 'Protected') : 'Delete role'}
                                  >
                                    <Trash2 className="w-4 h-4 text-destructive" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
          <DialogContent className="bg-background dark:bg-card border-border text-foreground dark:text-card-foreground max-w-[95vw] sm:max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{roleDialogMode === 'create' ? 'Add New Role' : 'Edit Role'}</DialogTitle>
              <DialogDescription>
                Configure access by area, project visibility, and allowed actions.
              </DialogDescription>
            </DialogHeader>

            {roleDialogError && (
              <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
                {roleDialogError}
              </div>
            )}

            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="roleName">Role Name</Label>
                <Input id="roleName" value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="e.g. Project Manager" />
              </div>

              <div className="space-y-4">
                <div className="text-sm font-medium">Areas & Actions</div>

                <div className="space-y-4">
                  {PERMISSION_GROUPS.map((group) => {
                    const areaEnabled = rolePermissions.menuVisibility[group.key] === true
                    return (
                      <div key={group.key} className="rounded-md border border-border bg-card p-3">
                        <div className="flex items-center justify-between gap-3">
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <Checkbox
                              checked={areaEnabled}
                              onCheckedChange={(checked) => toggleArea(group.key, checked === true)}
                            />
                            <span>{group.label}</span>
                          </label>

                          <span className={cn('text-xs', areaEnabled ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
                            {areaEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>

                        {group.actions.length > 0 && (
                          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {group.actions.map((item) => (
                              <label
                                key={item.key}
                                className={cn(
                                  'flex items-center gap-2 text-sm',
                                  !areaEnabled && 'opacity-60'
                                )}
                              >
                                <Checkbox
                                  checked={rolePermissions.actions[item.key]}
                                  disabled={!areaEnabled}
                                  onCheckedChange={(checked) =>
                                    setRolePermissions((prev) => ({
                                      ...prev,
                                      actions: { ...prev.actions, [item.key]: checked === true },
                                    }))
                                  }
                                />
                                <span>{item.label}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Project Visibility</div>
                <div className="space-y-2">
                  {(
                    [
                      ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'ON_HOLD'],
                      ['SHARE_ONLY', 'APPROVED', 'CLOSED'],
                    ] as ProjectStatus[][]
                  ).map((row) => (
                    <div key={row.join('|')} className="flex items-center justify-center gap-2">
                      {row.map((value) => {
                        const option = PROJECT_STATUS_OPTIONS.find((s) => s.value === value)
                        const label = option?.label || value
                        const selected = rolePermissions.projectVisibility.statuses.includes(value)
                        return (
                          <button
                            key={value}
                            type="button"
                            disabled={rolePermissions.menuVisibility.projects !== true}
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border transition-colors',
                              selected
                                ? cn(projectStatusBadgeClass(value), 'border-2 font-semibold')
                                : 'bg-muted text-muted-foreground border border-border opacity-70 hover:opacity-100'
                            )}
                            onClick={() => {
                              if (rolePermissions.menuVisibility.projects !== true) return
                              toggleStatus(value)
                            }}
                            aria-pressed={selected}
                          >
                            {selected && <Check className="h-3.5 w-3.5" />}
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button className="w-full sm:w-auto" variant="outline" onClick={() => setRoleDialogOpen(false)} disabled={rolesLoading}>
                Cancel
              </Button>
              <Button className="w-full sm:w-auto" variant="default" onClick={() => void saveRole()} disabled={rolesLoading}>
                {rolesLoading ? 'Saving...' : 'Save Role'}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>
    </div>
  )
}
