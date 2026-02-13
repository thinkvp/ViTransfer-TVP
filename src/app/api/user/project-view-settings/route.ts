import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

type SectionVisibility = {
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

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireApiAuth(request)
    if (authResult instanceof Response) return authResult
    const user = authResult

    const url = new URL(request.url)
    const projectId = url.searchParams.get('projectId')

    // Try to get project-specific settings first
    if (projectId) {
      const projectSettings = await prisma.userProjectViewSettings.findUnique({
        where: {
          userId_projectId: {
            userId: user.id,
            projectId,
          },
        },
      })

      if (projectSettings) {
        return NextResponse.json({
          visibleSections: projectSettings.visibleSections as SectionVisibility,
          isDefault: false,
        })
      }
    }

    // Fall back to default settings
    const defaultSettings = await prisma.userProjectViewSettings.findFirst({
      where: {
        userId: user.id,
        projectId: null,
      },
    })

    return NextResponse.json({
      visibleSections: (defaultSettings?.visibleSections as SectionVisibility) || DEFAULT_VISIBILITY,
      isDefault: true,
    })
  } catch (error) {
    console.error('Error fetching project view settings:', error)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireApiAuth(request)
    if (authResult instanceof Response) return authResult
    const user = authResult

    const body = await request.json()
    const { projectId, visibleSections, setAsDefault } = body

    if (!visibleSections || typeof visibleSections !== 'object') {
      return NextResponse.json({ error: 'Invalid visibleSections' }, { status: 400 })
    }

    // Validate the structure
    const requiredKeys = ['sales', 'keyDates', 'externalCommunication', 'users', 'projectFiles', 'projectData']
    for (const key of requiredKeys) {
      if (typeof visibleSections[key] !== 'boolean') {
        return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 })
      }
    }

    if (setAsDefault) {
      // Save as default (projectId = null)
      // For nullable unique constraints, we need to use findFirst + update/create pattern
      const existing = await prisma.userProjectViewSettings.findFirst({
        where: {
          userId: user.id,
          projectId: null,
        },
      })

      if (existing) {
        await prisma.userProjectViewSettings.update({
          where: { id: existing.id },
          data: { visibleSections },
        })
      } else {
        await prisma.userProjectViewSettings.create({
          data: {
            userId: user.id,
            projectId: null,
            visibleSections,
          },
        })
      }

      return NextResponse.json({ success: true, message: 'Default settings saved' })
    } else {
      // Save for specific project
      if (!projectId) {
        return NextResponse.json({ error: 'projectId is required when not setting default' }, { status: 400 })
      }

      await prisma.userProjectViewSettings.upsert({
        where: {
          userId_projectId: {
            userId: user.id,
            projectId,
          },
        },
        update: {
          visibleSections,
        },
        create: {
          userId: user.id,
          projectId,
          visibleSections,
        },
      })

      return NextResponse.json({ success: true, message: 'Project settings saved' })
    }
  } catch (error) {
    console.error('Error saving project view settings:', error)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }
}
