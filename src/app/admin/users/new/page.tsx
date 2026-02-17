
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, UserPlus, RefreshCw, Copy, Check, Eye, EyeOff } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordRequirements } from '@/components/PasswordRequirements'
import { apiFetch, apiPost } from '@/lib/api-client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { generateRandomHexDisplayColor } from '@/lib/display-color'

interface Role {
  id: string
  name: string
  isSystemAdmin: boolean
}

export default function NewUserPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [roles, setRoles] = useState<Role[]>([])
  const [rolesLoading, setRolesLoading] = useState(true)
  const [copiedPassword, setCopiedPassword] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [formData, setFormData] = useState(() => ({
    email: '',
    username: '',
    password: '',
    confirmPassword: '',
    name: '',
    displayColor: generateRandomHexDisplayColor(),
    appRoleId: 'role_admin',
  }))

  useEffect(() => {
    const loadRoles = async () => {
      try {
        const res = await apiFetch('/api/roles')
        if (!res.ok) throw new Error('Failed to fetch roles')
        const data = await res.json()
        const nextRoles = (data.roles || []) as Role[]
        setRoles(nextRoles)

        const admin = nextRoles.find((r) => r.id === 'role_admin')
        const fallback = admin?.id || nextRoles[0]?.id || 'role_admin'
        setFormData((prev) => ({ ...prev, appRoleId: prev.appRoleId || fallback }))
      } catch (err) {
        // If roles cannot be loaded, keep the default.
      } finally {
        setRolesLoading(false)
      }
    }

    void loadRoles()
  }, [])

  const generateRandomPassword = () => {
    // Generate a random password with at least 16 characters
    const length = 16
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const lowercase = 'abcdefghijklmnopqrstuvwxyz'
    const numbers = '0123456789'
    const special = '!@#$%^&*'
    const all = uppercase + lowercase + numbers + special

    // Helper function for cryptographically secure random int
    const getRandomInt = (max: number) => {
      const array = new Uint32Array(1)
      crypto.getRandomValues(array)
      return array[0] % max
    }

    // Ensure at least one of each type
    let password = ''
    password += uppercase[getRandomInt(uppercase.length)]
    password += lowercase[getRandomInt(lowercase.length)]
    password += numbers[getRandomInt(numbers.length)]
    password += special[getRandomInt(special.length)]

    // Fill the rest randomly
    for (let i = password.length; i < length; i++) {
      password += all[getRandomInt(all.length)]
    }

    // Shuffle the password using Fisher-Yates
    const chars = password.split('')
    for (let i = chars.length - 1; i > 0; i--) {
      const j = getRandomInt(i + 1)
      ;[chars[i], chars[j]] = [chars[j], chars[i]]
    }
    password = chars.join('')

    setFormData({
      ...formData,
      password,
      confirmPassword: password,
    })

    // Automatically show password when generated so user can see/copy it
    setShowPassword(true)
    setShowConfirmPassword(true)
  }

  const copyPassword = async () => {
    if (formData.password) {
      await navigator.clipboard.writeText(formData.password)
      setCopiedPassword(true)
      setTimeout(() => setCopiedPassword(false), 2000)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Validation
    if (!formData.email || !formData.password) {
      setError('Email and password are required')
      return
    }

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match')
      return
    }

    // Password validation will be done by the API using the passwordSchema
    // which requires 12+ chars, uppercase, lowercase, number, and special char

    setLoading(true)

    try {
      await apiPost('/api/users', {
        email: formData.email,
        username: formData.username || null,
        password: formData.password,
        name: formData.name || null,
        displayColor: formData.displayColor || null,
        appRoleId: formData.appRoleId,
      })

      router.push('/admin/users')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">Add New User</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">Create a new internal user account</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>User Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit}>
            {error && (
              <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              {/* Row 1: Email | Full Name */}
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Full Name</Label>
                <Input
                  id="name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Optional"
                />
              </div>

              {/* Row 2: Username | Display Colour */}
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  placeholder="Optional"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="displayColor">Display Colour</Label>
                <div className="flex items-center gap-3">
                  <input
                    id="displayColor"
                    type="color"
                    value={formData.displayColor}
                    onChange={(e) => setFormData({ ...formData, displayColor: e.target.value })}
                    className="h-10 w-14 rounded-md border border-input bg-background p-1"
                    aria-label="Display colour"
                  />
                  <Input
                    type="text"
                    value={formData.displayColor}
                    onChange={(e) => setFormData({ ...formData, displayColor: e.target.value })}
                    placeholder="#RRGGBB"
                    className="max-w-[140px]"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Used for this admin&apos;s comment highlight and timeline markers.
                </p>
              </div>

              {/* Row 3: Role (single column) */}
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  key={rolesLoading ? 'roles-loading' : 'roles-loaded'}
                  value={formData.appRoleId}
                  onValueChange={(value) => setFormData({ ...formData, appRoleId: value })}
                  disabled={rolesLoading}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rolesLoading ? 'Loading roles…' : 'Select a role'} />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Controls which admin areas and actions this user can access.</p>
              </div>

              {/* Empty cell to maintain grid alignment */}
              <div className="hidden md:block" />

              {/* Row 4: Password | Confirm Password */}
              <div className="space-y-2">
                <Label htmlFor="password">Password *</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      required
                      className="pr-10 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={generateRandomPassword}
                    title="Generate new password"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copyPassword}
                    title="Copy password"
                  >
                    {copiedPassword ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                {formData.password && (
                  <PasswordRequirements password={formData.password} className="mt-3" />
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password *</Label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? "text" : "password"}
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    required
                    className="pr-10"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="h-7 w-7 p-0"
                      title={showConfirmPassword ? "Hide password" : "Show password"}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
                {formData.confirmPassword && formData.password !== formData.confirmPassword && (
                  <p className="text-sm text-destructive flex items-center gap-1">
                    <X className="w-4 h-4" /> Passwords do not match
                  </p>
                )}
                {formData.confirmPassword && formData.password === formData.confirmPassword && formData.password.length > 0 && (
                  <p className="text-sm text-success flex items-center gap-1">
                    <Check className="w-4 h-4" /> Passwords match
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-3 pt-6 justify-end">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => router.push('/admin/users')}
                disabled={loading}
              >
                <X className="w-4 h-4 mr-2" />
                <span>Cancel</span>
              </Button>
              <Button type="submit" variant="default" size="lg" disabled={loading}>
                <UserPlus className="w-4 h-4 mr-2" />
                <span>{loading ? 'Creating...' : 'Create User'}</span>
              </Button>
            </div>
          </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
