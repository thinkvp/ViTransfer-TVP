'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users, UserPlus, Edit, Trash2, Plus, Pencil, Shield, ShieldOff, RefreshCw, Check } from 'lucide-react'
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

const MENU_ITEMS: Array<{ key: keyof RolePermissions['menuVisibility']; label: string }> = [
  { key: 'projects', label: 'Projects' },
  { key: 'clients', label: 'Clients' },
  { key: 'settings', label: 'Settings' },
  { key: 'users', label: 'Users' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'security', label: 'Security' },
]

const ACTION_ITEMS: Array<{ key: keyof RolePermissions['actions']; label: string }> = [
  { key: 'accessProjectSettings', label: 'Access project settings' },
  { key: 'changeProjectSettings', label: 'Change project settings' },
  { key: 'sendNotificationsToRecipients', label: 'Send notifications' },
  { key: 'makeCommentsOnProjects', label: 'Make comments' },
  { key: 'changeProjectStatuses', label: 'Change project statuses' },
  { key: 'deleteProjects', label: 'Delete projects' },
  { key: 'viewAnalytics', label: 'View analytics' },
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
            Users
          </h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Manage internal users and their roles.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="default" onClick={() => void fetchUsersAndRoles()}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="default" size="default" onClick={() => router.push('/admin/users/new')}>
            <UserPlus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Add New User</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
          </CardHeader>
          <CardContent>
            {users.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">
                No users found. Create your first user to get started.
              </div>
            ) : (
              <div className="rounded-md border border-border bg-card overflow-hidden">
                <div className="w-full overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[180px]">User</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[140px] hidden md:table-cell">Username</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[220px]">Email</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[140px]">Role</th>
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[130px]">Colour</th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-[140px]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id} className="border-b border-border last:border-b-0 hover:bg-muted/40">
                          <td className="px-3 py-2">
                            <div className="font-medium">{user.name || user.username || user.email}</div>
                            <div className="text-xs text-muted-foreground md:hidden">{user.username ? `@${user.username}` : ''}</div>
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">
                            {user.username ? `@${user.username}` : '—'}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{user.email}</td>
                          <td className="px-3 py-2">
                            <span className={cn(
                              'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border',
                              user.appRole?.isSystemAdmin
                                ? 'bg-info-visible text-info border-2 border-info-visible'
                                : 'bg-muted text-muted-foreground border border-border'
                            )}>
                              {user.appRole?.isSystemAdmin ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                              {user.appRole?.name || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span
                                className="h-4 w-4 rounded-full border border-border"
                                style={{ backgroundColor: user.displayColor || 'transparent' }}
                                aria-label="Display colour"
                              />
                              <span className="text-xs text-muted-foreground">{user.displayColor || '—'}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="inline-flex items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => router.push(`/admin/users/${user.id}`)}>
                                <Edit className="w-4 h-4 sm:mr-2" />
                                <span className="hidden sm:inline">Edit</span>
                              </Button>
                              <Button variant="destructive" size="sm" onClick={() => handleDelete(user.id, user.email)}>
                                <Trash2 className="w-4 h-4 sm:mr-2" />
                                <span className="hidden sm:inline">Delete</span>
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
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-xl font-semibold">Roles</h2>
          <Button variant="default" onClick={openCreateRole}>
            <Plus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Add New Role</span>
          </Button>
        </div>

          <Card>
            <CardContent className="pt-6">
              {roles.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">No roles found.</div>
              ) : (
                <div className="rounded-md border border-border bg-card overflow-hidden">
                  <div className="w-full overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[200px]">Role</th>
                          <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[100px]">Users</th>
                          <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-[160px]">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roles.map((role) => {
                          const canEdit = !role.isSystemAdmin && role.id !== 'role_admin'
                          const canDelete = canEdit && role.userCount === 0
                          return (
                            <tr key={role.id} className="border-b border-border last:border-b-0 hover:bg-muted/40">
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span className={cn(
                                    'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border',
                                    role.isSystemAdmin
                                      ? 'bg-info-visible text-info border-2 border-info-visible'
                                      : 'bg-muted text-muted-foreground border border-border'
                                  )}>
                                    {role.isSystemAdmin ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                                    {role.name}
                                  </span>
                                  {!canEdit && (
                                    <span className="text-xs text-muted-foreground">Protected</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">{role.userCount}</td>
                              <td className="px-3 py-2 text-right">
                                <div className="inline-flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openEditRole(role)}
                                    disabled={!canEdit}
                                  >
                                    <Pencil className="w-4 h-4 sm:mr-2" />
                                    <span className="hidden sm:inline">Edit</span>
                                  </Button>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => void deleteRole(role)}
                                    disabled={!canDelete}
                                    title={!canDelete ? (role.userCount > 0 ? 'Role has assigned users' : 'Protected') : 'Delete role'}
                                  >
                                    <Trash2 className="w-4 h-4 sm:mr-2" />
                                    <span className="hidden sm:inline">Delete</span>
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{roleDialogMode === 'create' ? 'Add New Role' : 'Edit Role'}</DialogTitle>
              <DialogDescription>
                Configure menu visibility, project visibility, and actions.
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

              <div className="space-y-2">
                <div className="text-sm font-medium">Menu Visibility</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {MENU_ITEMS.map((item) => (
                    <label key={item.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={rolePermissions.menuVisibility[item.key]}
                        onCheckedChange={(checked) =>
                          setRolePermissions((prev) => ({
                            ...prev,
                            menuVisibility: { ...prev.menuVisibility, [item.key]: checked === true },
                          }))
                        }
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Project Visibility</div>
                <div className="flex flex-wrap gap-2">
                  {PROJECT_STATUS_OPTIONS.map((s) => {
                    const selected = rolePermissions.projectVisibility.statuses.includes(s.value)
                    return (
                      <button
                        key={s.value}
                        type="button"
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border transition-colors',
                          selected
                            ? cn(projectStatusBadgeClass(s.value), 'border-2 font-semibold')
                            : 'bg-muted text-muted-foreground border border-border opacity-70 hover:opacity-100'
                        )}
                        onClick={() => toggleStatus(s.value)}
                        aria-pressed={selected}
                      >
                        {selected && <Check className="h-3.5 w-3.5" />}
                        {s.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Actions</div>
                <div className="grid grid-cols-1 gap-2">
                  {ACTION_ITEMS.map((item) => (
                    <label key={item.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={rolePermissions.actions[item.key]}
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
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setRoleDialogOpen(false)} disabled={rolesLoading}>
                Cancel
              </Button>
              <Button variant="default" onClick={() => void saveRole()} disabled={rolesLoading}>
                {rolesLoading ? 'Saving...' : 'Save Role'}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>
    </div>
  )
}
