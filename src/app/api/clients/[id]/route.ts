import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteDirectory, moveDirectory } from '@/lib/storage'
import { deleteDropboxPath, isDropboxStorageConfigured, moveDropboxPath } from '@/lib/storage-provider-dropbox'
import {
  buildClientStorageRoot,
  replaceStoredStoragePathPrefix,
  replaceStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const recipientSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(320).email().nullable().optional(),
  displayColor: z.string().trim().max(7).nullable().optional(),
  isPrimary: z.boolean().optional(),
  receiveNotifications: z.boolean().optional(),
  receiveSalesReminders: z.boolean().optional(),
})

function normalizeEmail(email: unknown): string | null {
  const value = (typeof email === 'string' ? email : '').trim().toLowerCase()
  return value ? value : null
}

const updateClientSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  active: z.boolean().optional(),
  recipients: z.array(recipientSchema).optional(),
})

// GET /api/clients/[id] - get client details
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-client-get'
  )
  if (rateLimitResult) return rateLimitResult

  const client = await prisma.client.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      active: true,
      address: true,
      phone: true,
      website: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      recipients: {
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          email: true,
          displayColor: true,
          isPrimary: true,
          receiveNotifications: true,
          // NOTE: new column; keep types happy if prisma client isn't regenerated yet.
          receiveSalesReminders: true,
          createdAt: true,
        } as any,
      },
      files: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          fileType: true,
          category: true,
          createdAt: true,
          uploadedByName: true,
        },
      },
    },
  } as any)

  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 })
  }

  // BigInt serialization
  const serialized = {
    ...client,
    files: (client as any).files.map((f: any) => ({
      ...f,
      fileSize: f.fileSize.toString(),
    })),
  }

  return NextResponse.json({ client: serialized })
}

// PATCH /api/clients/[id] - update client
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClients')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-client-update'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const parsed = updateClientSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const existing = await prisma.client.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } })
    if (!existing) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const { name, address, phone, website, notes } = parsed.data
    const active = parsed.data.active
    const trimmedName = typeof name === 'string' ? name.trim() : ''
    const oldClientStorageRoot = buildClientStorageRoot(existing.name)
    const newClientStorageRoot = trimmedName ? buildClientStorageRoot(trimmedName) : oldClientStorageRoot
    const clientRenamePlanned = Boolean(trimmedName) && trimmedName !== String(existing.name || '').trim()

    let movedClientStorage = false
    if (clientRenamePlanned) {
      await moveDirectory(oldClientStorageRoot, newClientStorageRoot)
      movedClientStorage = true
    }

    const recipientsInput = parsed.data.recipients
      ? parsed.data.recipients.map((r) => ({
          id: r.id ? String(r.id) : undefined,
          name: r.name ?? null,
          email: normalizeEmail(r.email),
          displayColor: r.displayColor ?? null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: r.receiveNotifications !== false,
          receiveSalesReminders: r.receiveSalesReminders !== false,
        }))
      : undefined

    let client
    try {
      client = await prisma.$transaction(async (tx) => {
        const updated = await tx.client.update({
          where: { id },
          data: {
            ...(typeof name === 'string' ? { name } : {}),
            ...(address !== undefined ? { address: address ?? null } : {}),
            ...(phone !== undefined ? { phone: phone ?? null } : {}),
            ...(website !== undefined ? { website: website ?? null } : {}),
            ...(notes !== undefined ? { notes: notes ?? null } : {}),
            ...(typeof active === 'boolean' ? { active } : {}),
          },
          select: { id: true, name: true },
        })

        // Keep project display names in sync for linked projects.
        // Many parts of the app currently use Project.companyName as the client-facing name.
        if (clientRenamePlanned) {
          const projects = await tx.project.findMany({
            where: { clientId: id },
            select: { id: true, storagePath: true },
          })

          for (const project of projects) {
            await tx.project.update({
              where: { id: project.id },
              data: {
                companyName: updated.name,
                storagePath: replaceStoragePathPrefix(project.storagePath, oldClientStorageRoot, newClientStorageRoot),
              },
            })
          }

          const clientFiles = await tx.clientFile.findMany({
            where: { clientId: id },
            select: { id: true, storagePath: true },
          })
          for (const file of clientFiles) {
            await tx.clientFile.update({
              where: { id: file.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(file.storagePath, oldClientStorageRoot, newClientStorageRoot)!,
              },
            })
          }

          const videos = await tx.video.findMany({
            where: { project: { clientId: id } },
            select: {
              id: true,
              originalStoragePath: true,
              preview480Path: true,
              preview720Path: true,
              preview1080Path: true,
              thumbnailPath: true,
              timelinePreviewVttPath: true,
              timelinePreviewSpritesPath: true,
              dropboxPath: true,
            },
          })
          for (const video of videos) {
            await tx.video.update({
              where: { id: video.id },
              data: {
                originalStoragePath: replaceStoredStoragePathPrefix(video.originalStoragePath, oldClientStorageRoot, newClientStorageRoot)!,
                preview480Path: replaceStoredStoragePathPrefix(video.preview480Path, oldClientStorageRoot, newClientStorageRoot),
                preview720Path: replaceStoredStoragePathPrefix(video.preview720Path, oldClientStorageRoot, newClientStorageRoot),
                preview1080Path: replaceStoredStoragePathPrefix(video.preview1080Path, oldClientStorageRoot, newClientStorageRoot),
                thumbnailPath: replaceStoredStoragePathPrefix(video.thumbnailPath, oldClientStorageRoot, newClientStorageRoot),
                timelinePreviewVttPath: replaceStoredStoragePathPrefix(video.timelinePreviewVttPath, oldClientStorageRoot, newClientStorageRoot),
                timelinePreviewSpritesPath: replaceStoredStoragePathPrefix(video.timelinePreviewSpritesPath, oldClientStorageRoot, newClientStorageRoot),
                dropboxPath: replaceStoragePathPrefix(video.dropboxPath, oldClientStorageRoot, newClientStorageRoot),
              },
            })
          }

          const assets = await tx.videoAsset.findMany({
            where: { video: { project: { clientId: id } } },
            select: { id: true, storagePath: true, dropboxPath: true },
          })
          for (const asset of assets) {
            await tx.videoAsset.update({
              where: { id: asset.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(asset.storagePath, oldClientStorageRoot, newClientStorageRoot)!,
                dropboxPath: replaceStoragePathPrefix(asset.dropboxPath, oldClientStorageRoot, newClientStorageRoot),
              },
            })
          }

          const albumPhotos = await tx.albumPhoto.findMany({
            where: { album: { project: { clientId: id } } },
            select: { id: true, storagePath: true, socialStoragePath: true },
          })
          for (const photo of albumPhotos) {
            await tx.albumPhoto.update({
              where: { id: photo.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(photo.storagePath, oldClientStorageRoot, newClientStorageRoot)!,
                socialStoragePath: replaceStoredStoragePathPrefix(photo.socialStoragePath, oldClientStorageRoot, newClientStorageRoot),
              },
            })
          }

          const albums = await tx.album.findMany({
            where: { project: { clientId: id } },
            select: { id: true, fullZipDropboxPath: true, socialZipDropboxPath: true },
          })
          for (const album of albums) {
            await tx.album.update({
              where: { id: album.id },
              data: {
                fullZipDropboxPath: replaceStoragePathPrefix(album.fullZipDropboxPath, oldClientStorageRoot, newClientStorageRoot),
                socialZipDropboxPath: replaceStoragePathPrefix(album.socialZipDropboxPath, oldClientStorageRoot, newClientStorageRoot),
              },
            })
          }

          const projectFiles = await tx.projectFile.findMany({
            where: { project: { clientId: id } },
            select: { id: true, storagePath: true },
          })
          for (const file of projectFiles) {
            await tx.projectFile.update({
              where: { id: file.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(file.storagePath, oldClientStorageRoot, newClientStorageRoot)!,
              },
            })
          }

          const projectEmails = await tx.projectEmail.findMany({
            where: { project: { clientId: id } },
            select: { id: true, rawStoragePath: true },
          })
          for (const email of projectEmails) {
            await tx.projectEmail.update({
              where: { id: email.id },
              data: {
                rawStoragePath: replaceStoredStoragePathPrefix(email.rawStoragePath, oldClientStorageRoot, newClientStorageRoot)!,
              },
            })
          }

          const attachments = await tx.projectEmailAttachment.findMany({
            where: { projectEmail: { project: { clientId: id } } },
            select: { id: true, storagePath: true },
          })
          for (const attachment of attachments) {
            await tx.projectEmailAttachment.update({
              where: { id: attachment.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(attachment.storagePath, oldClientStorageRoot, newClientStorageRoot)!,
              },
            })
          }

          const commentFiles = await tx.commentFile.findMany({
            where: { project: { clientId: id } },
            select: { id: true, storagePath: true },
          })
          for (const commentFile of commentFiles) {
            await tx.commentFile.update({
              where: { id: commentFile.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(commentFile.storagePath, oldClientStorageRoot, newClientStorageRoot)!,
              },
            })
          }
        }

        if (recipientsInput) {
        const normalized = recipientsInput.filter((r) => r.email || r.name)

        // Ensure at most one primary; default first
        const primaryCount = normalized.filter((r) => r.isPrimary).length
        if (normalized.length > 0) {
          if (primaryCount === 0) normalized[0].isPrimary = true
          else if (primaryCount > 1) {
            let seen = false
            for (const r of normalized) {
              if (r.isPrimary) {
                if (!seen) seen = true
                else r.isPrimary = false
              }
            }
          }
        }

        const existingRecipients = await tx.clientRecipient.findMany({
          where: { clientId: id },
          select: { id: true, email: true },
        })

        const existingById = new Map(existingRecipients.map((r: any) => [String(r.id), r]))
        const existingByEmail = new Map(
          existingRecipients
            .filter((r: any) => normalizeEmail(r.email))
            .map((r: any) => [normalizeEmail(r.email) as string, String(r.id)])
        )

        const keepIds = new Set<string>()
        const toCreate: Array<any> = []

        for (const r of normalized) {
          // Prefer explicit ID; otherwise try to preserve by matching email.
          let targetId: string | null = r.id && existingById.has(r.id) ? r.id : null
          if (!targetId && r.email) {
            const byEmail = existingByEmail.get(r.email)
            if (byEmail) targetId = byEmail
          }

          if (targetId) {
            keepIds.add(targetId)
            await tx.clientRecipient.update({
              where: { id: targetId },
              data: {
                name: r.name ?? null,
                email: r.email ?? null,
                displayColor: r.displayColor ?? null,
                isPrimary: Boolean(r.isPrimary),
                receiveNotifications: r.receiveNotifications !== false,
                receiveSalesReminders: r.receiveSalesReminders !== false,
              } as any,
            } as any)
          } else {
            toCreate.push({
              clientId: id,
              name: r.name ?? null,
              email: r.email ?? null,
              displayColor: r.displayColor ?? null,
              isPrimary: Boolean(r.isPrimary),
              receiveNotifications: r.receiveNotifications !== false,
              receiveSalesReminders: r.receiveSalesReminders !== false,
            })
          }
        }

        // Delete removed recipients
        if (keepIds.size > 0) {
          await tx.clientRecipient.deleteMany({
            where: {
              clientId: id,
              id: { notIn: Array.from(keepIds) },
            },
          })
        } else {
          await tx.clientRecipient.deleteMany({ where: { clientId: id } })
        }

        // Create new recipients (need IDs back, so do individual creates)
        const createdRecipients: Array<{ id: string; email: string | null; name: string | null; displayColor: string | null }> = []
        for (const r of toCreate) {
          const created = await tx.clientRecipient.create({
            data: r,
            select: { id: true, email: true, name: true, displayColor: true },
          } as any)
          createdRecipients.push({
            id: String((created as any).id),
            email: normalizeEmail((created as any).email),
            name: (created as any).name ?? null,
            displayColor: (created as any).displayColor ?? null,
          })
          keepIds.add(String((created as any).id))
        }

        // Keep project recipients in sync for this client.
        // Prefer stable linkage by clientRecipientId; best-effort fallback by email.
        const updatedRecipients = await tx.clientRecipient.findMany({
          where: { clientId: id },
          select: { id: true, email: true, name: true, displayColor: true },
        })

        for (const r of updatedRecipients as any[]) {
          const clientRecipientId = String(r.id)
          const email = normalizeEmail(r.email)
          const name = r.name ?? null
          const displayColor = r.displayColor ?? null

          await tx.projectRecipient.updateMany({
            where: { clientRecipientId },
            data: { email, name, displayColor } as any,
          } as any).catch(() => null)

          if (email) {
            await tx.projectRecipient.updateMany({
              where: {
                project: { clientId: id },
                clientRecipientId: null,
                email,
              } as any,
              data: { clientRecipientId, name, displayColor } as any,
            } as any).catch(() => null)
          }
        }
      }

        return updated
      })
    } catch (error) {
      if (movedClientStorage) {
        await moveDirectory(newClientStorageRoot, oldClientStorageRoot).catch(() => {})
      }
      throw error
    }

    if (clientRenamePlanned) {
      void moveDropboxPath(oldClientStorageRoot, newClientStorageRoot).catch(() => {})
    }

    return NextResponse.json({ client })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'Client name already exists' }, { status: 409 })
    }
    console.error('Error updating client:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

// DELETE /api/clients/[id] - soft delete client
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClients')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'admin-client-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const client = await prisma.client.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          projects: true,
        },
      },
    },
  })
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  if (client._count.projects > 0) {
    return NextResponse.json(
      { error: 'Delete this client\'s projects first before deleting the client.' },
      { status: 409 }
    )
  }

  await prisma.client.update({ where: { id }, data: { deletedAt: new Date() } })

  const clientStorageRoot = buildClientStorageRoot(client.name)

  try {
    await deleteDirectory(clientStorageRoot)
  } catch (error) {
    console.error(`Failed to delete local client directory for ${id}:`, error)
  }

  if (isDropboxStorageConfigured()) {
    try {
      await deleteDropboxPath('', clientStorageRoot, { pruneEmptyParents: false })
    } catch (error) {
      console.error(`Failed to delete Dropbox client directory for ${id}:`, error)
    }
  }

  return NextResponse.json({ ok: true })
}
