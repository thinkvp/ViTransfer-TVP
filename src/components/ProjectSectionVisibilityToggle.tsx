'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LayoutList, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { apiJson, apiPost } from '@/lib/api-client'

export type SectionVisibility = {
  sales: boolean
  keyDates: boolean
  externalCommunication: boolean
  users: boolean
  projectFiles: boolean
  projectData: boolean
}

const DEFAULT_VISIBILITY: SectionVisibility = {
  sales: true,
  keyDates: true,
  externalCommunication: true,
  users: true,
  projectFiles: true,
  projectData: true,
}

interface ProjectSectionVisibilityToggleProps {
  projectId: string
  value: SectionVisibility
  onChange: (visibility: SectionVisibility) => void
}

export function ProjectSectionVisibilityToggle({
  projectId,
  value,
  onChange,
}: ProjectSectionVisibilityToggleProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [tempValue, setTempValue] = useState<SectionVisibility>(value)

  // Sync temp value when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setTempValue(value)
    }
  }, [isOpen, value])

  const handleToggle = (key: keyof SectionVisibility) => {
    setTempValue((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }

  const handleSave = async (setAsDefault: boolean) => {
    setIsSaving(true)
    try {
      await apiPost('/api/user/project-view-settings', {
        projectId: setAsDefault ? undefined : projectId,
        visibleSections: tempValue,
        setAsDefault,
      })

      onChange(tempValue)
      setIsOpen(false)

      // Don't show alert on success - silent save is better UX
    } catch (error: any) {
      console.error('Error saving section visibility:', error)
      alert(error?.message || 'Failed to save section visibility')
    } finally {
      setIsSaving(false)
    }
  }

  const sections = [
    { key: 'sales' as const, label: 'Sales (Quotes & Invoices)' },
    { key: 'keyDates' as const, label: 'Key Dates' },
    { key: 'externalCommunication' as const, label: 'External Communication' },
    { key: 'users' as const, label: 'Users' },
    { key: 'projectFiles' as const, label: 'Project Files' },
    { key: 'projectData' as const, label: 'Project Data' },
  ]

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Show/hide sections"
          title="Show/hide sections"
        >
          <LayoutList className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Show/Hide Sections</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sections.map((section) => (
          <DropdownMenuCheckboxItem
            key={section.key}
            checked={tempValue[section.key]}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => handleToggle(section.key)}
            disabled={isSaving}
          >
            {section.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <div className="p-2 space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void handleSave(true)}
            disabled={isSaving}
          >
            <Check className="w-4 h-4 mr-2" />
            Set as Default
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="w-full"
            onClick={() => void handleSave(false)}
            disabled={isSaving}
          >
            <Check className="w-4 h-4 mr-2" />
            {isSaving ? 'Saving...' : 'Save for This Project'}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Hook to fetch and manage section visibility
export function useProjectSectionVisibility(projectId: string) {
  const [visibility, setVisibility] = useState<SectionVisibility>(DEFAULT_VISIBILITY)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchVisibility = async () => {
      try {
        const response = await apiJson<{
          visibleSections: SectionVisibility
          isDefault: boolean
        }>(`/api/user/project-view-settings?projectId=${projectId}`)

        if (response?.visibleSections) {
          setVisibility(response.visibleSections)
        }
      } catch (error) {
        console.error('Error fetching section visibility:', error)
        // Use default visibility on error
      } finally {
        setIsLoading(false)
      }
    }

    void fetchVisibility()
  }, [projectId])

  return { visibility, setVisibility, isLoading }
}
