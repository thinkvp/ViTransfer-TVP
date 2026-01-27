import { prisma } from './db'
import { generateRandomHexDisplayColor, normalizeHexDisplayColor } from './display-color'
import { getSafeguardLimits } from './settings'

export interface Recipient {
  id?: string
  clientRecipientId?: string | null
  email: string | null
  name: string | null
  displayColor?: string | null
  isPrimary: boolean
  receiveNotifications: boolean
}

function normalizeEmail(email: unknown): string {
  return (typeof email === 'string' ? email : '').trim().toLowerCase()
}

/**
 * Get all recipients for a project
 */
export async function getProjectRecipients(projectId: string): Promise<Recipient[]> {
  const recipients = await prisma.projectRecipient.findMany({
    where: { projectId },
    orderBy: [
      { isPrimary: 'desc' },
      { createdAt: 'asc' }
    ]
  })

  return recipients.map(r => ({
    id: r.id,
    clientRecipientId: (r as any).clientRecipientId ?? null,
    email: r.email,
    name: r.name,
    displayColor: r.displayColor,
    isPrimary: r.isPrimary,
    receiveNotifications: r.receiveNotifications
  }))
}

/**
 * Get the primary recipient for a project
 * Optimized to fetch only the primary recipient instead of all recipients
 */
export async function getPrimaryRecipient(projectId: string): Promise<Recipient | null> {
  // Try to fetch primary recipient first (most common case)
  const primary = await prisma.projectRecipient.findFirst({
    where: { projectId, isPrimary: true }
  })

  if (primary) {
    return {
      id: primary.id,
      email: primary.email,
      name: primary.name,
      displayColor: primary.displayColor,
      isPrimary: primary.isPrimary,
      receiveNotifications: primary.receiveNotifications
    }
  }

  // Fallback: if no primary, get first recipient by creation date
  const fallback = await prisma.projectRecipient.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' }
  })

  if (!fallback) {
    return null
  }

  return {
    id: fallback.id,
    email: fallback.email,
    name: fallback.name,
    displayColor: fallback.displayColor,
    isPrimary: fallback.isPrimary,
    receiveNotifications: fallback.receiveNotifications
  }
}

/**
 * Add a recipient to a project
 */
export async function addRecipient(
  projectId: string,
  email: string | null = null,
  name: string | null = null,
  isPrimary: boolean = false,
  displayColor?: string | null,
  alsoAddToClient?: boolean,
  clientRecipientId?: string | null
): Promise<Recipient> {
  const { maxProjectRecipients } = await getSafeguardLimits()
  const currentCount = await prisma.projectRecipient.count({ where: { projectId } })
  if (currentCount >= maxProjectRecipients) {
    throw new Error(`Maximum recipients (${maxProjectRecipients}) reached for this project`)
  }

  // If setting as primary, unset other primary recipients
  if (isPrimary) {
    await prisma.projectRecipient.updateMany({
      where: { projectId, isPrimary: true },
      data: { isPrimary: false }
    })
  }

  const normalizedColor = displayColor === undefined
    ? null
    : (displayColor === null ? null : (normalizeHexDisplayColor(displayColor) || null))

  const recipient = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { clientId: true },
    })
    const clientId = project?.clientId ?? null

    let resolvedClientRecipientId: string | null = clientRecipientId ? String(clientRecipientId) : null
    if (resolvedClientRecipientId && !clientId) {
      // A project without a client can't link to a client recipient.
      resolvedClientRecipientId = null
    }

    // If this recipient should be linked to the client, resolve/create the client recipient.
    if (clientId && (alsoAddToClient || resolvedClientRecipientId)) {
      if (resolvedClientRecipientId) {
        // Ensure it's a valid recipient for this client.
        const ok = await tx.clientRecipient.findFirst({
          where: { id: resolvedClientRecipientId, clientId },
          select: { id: true },
        })
        if (!ok) resolvedClientRecipientId = null
      }

      if (!resolvedClientRecipientId) {
        const emailKey = normalizeEmail(email)
        if (emailKey) {
          const existing = await tx.clientRecipient.findFirst({
            where: { clientId, email: emailKey },
            select: { id: true },
          })
          if (existing?.id) {
            resolvedClientRecipientId = existing.id
          } else {
            const created = await tx.clientRecipient.create({
              data: {
                clientId,
                email: emailKey,
                name,
                displayColor: normalizedColor ?? generateRandomHexDisplayColor(),
                isPrimary: false,
                receiveNotifications: true,
                receiveSalesReminders: true,
              } as any,
              select: { id: true },
            } as any)
            resolvedClientRecipientId = created?.id ? String(created.id) : null
          }
        }
      }
    }

    const createdProjectRecipient = await tx.projectRecipient.create({
      data: {
        projectId,
        ...(resolvedClientRecipientId ? { clientRecipientId: resolvedClientRecipientId } : {}),
        email,
        name,
        isPrimary,
        displayColor: normalizedColor ?? generateRandomHexDisplayColor(),
      } as any,
    })

    // Keep client recipient fields in sync when linked.
    if (clientId && resolvedClientRecipientId) {
      try {
        await tx.clientRecipient.update({
          where: { id: resolvedClientRecipientId },
          data: {
            ...(email ? { email: normalizeEmail(email) } : {}),
            ...(name !== null && name !== undefined ? { name } : {}),
            ...(Object.prototype.hasOwnProperty.call(createdProjectRecipient, 'displayColor')
              ? { displayColor: (createdProjectRecipient as any).displayColor ?? null }
              : {}),
          } as any,
        })
      } catch {
        // ignore
      }
    }

    return createdProjectRecipient
  })

  return {
    id: recipient.id,
    clientRecipientId: (recipient as any).clientRecipientId ?? null,
    email: recipient.email,
    name: recipient.name,
    displayColor: recipient.displayColor,
    isPrimary: recipient.isPrimary,
    receiveNotifications: recipient.receiveNotifications
  }
}

/**
 * Update a recipient
 */
export async function updateRecipient(
  recipientId: string,
  data: { name?: string | null; email?: string | null; displayColor?: string | null; isPrimary?: boolean; receiveNotifications?: boolean; clientRecipientId?: string | null }
): Promise<Recipient> {
  // If setting as primary, get projectId and unset other primaries
  if (data.isPrimary) {
    const existing = await prisma.projectRecipient.findUnique({
      where: { id: recipientId },
      select: { projectId: true }
    })

    if (existing) {
      await prisma.projectRecipient.updateMany({
        where: {
          projectId: existing.projectId,
          isPrimary: true,
          id: { not: recipientId }
        },
        data: { isPrimary: false }
      })
    }
  }

  const updateData: any = { ...data }
  if (Object.prototype.hasOwnProperty.call(data, 'displayColor')) {
    if (data.displayColor === null || data.displayColor === '') {
      updateData.displayColor = null
    } else {
      const normalized = normalizeHexDisplayColor(data.displayColor)
      if (!normalized) {
        throw new Error('Invalid display colour. Use a hex value like #RRGGBB.')
      }
      updateData.displayColor = normalized
    }
  }

  const recipient = await prisma.projectRecipient.update({
    where: { id: recipientId },
    data: updateData
  })

  // Keep linked client recipient in sync (strong linkage via clientRecipientId).
  try {
    const project = await prisma.project.findUnique({
      where: { id: (recipient as any).projectId },
      select: { clientId: true },
    })
    const clientId = project?.clientId ?? null
    if (clientId) {
      let linkedId: string | null = (recipient as any).clientRecipientId ?? null

      // Allow explicitly setting/clearing linkage.
      if (Object.prototype.hasOwnProperty.call(updateData, 'clientRecipientId')) {
        linkedId = updateData.clientRecipientId ? String(updateData.clientRecipientId) : null

        if (linkedId) {
          const ok = await prisma.clientRecipient.findFirst({
            where: { id: linkedId, clientId },
            select: { id: true },
          })
          if (!ok) linkedId = null
        }

        await prisma.projectRecipient.update({
          where: { id: recipientId },
          data: { clientRecipientId: linkedId } as any,
        })
      }

      // If not linked but email exists, auto-link to a matching client recipient.
      if (!linkedId) {
        const emailKey = normalizeEmail((recipient as any).email)
        if (emailKey) {
          const existing = await prisma.clientRecipient.findFirst({
            where: { clientId, email: emailKey },
            select: { id: true },
          })
          if (existing?.id) {
            linkedId = existing.id
            await prisma.projectRecipient.update({
              where: { id: recipientId },
              data: { clientRecipientId: linkedId } as any,
            })
          }
        }
      }

      if (linkedId) {
        const nextEmail = Object.prototype.hasOwnProperty.call(updateData, 'email')
          ? (updateData.email ? normalizeEmail(updateData.email) : null)
          : normalizeEmail((recipient as any).email)

        const nextName = Object.prototype.hasOwnProperty.call(updateData, 'name')
          ? (updateData.name ?? null)
          : ((recipient as any).name ?? null)

        const nextColor = Object.prototype.hasOwnProperty.call(updateData, 'displayColor')
          ? ((recipient as any).displayColor ?? null)
          : undefined

        await prisma.clientRecipient.update({
          where: { id: linkedId },
          data: {
            ...(Object.prototype.hasOwnProperty.call(updateData, 'email') ? { email: nextEmail } : {}),
            ...(Object.prototype.hasOwnProperty.call(updateData, 'name') ? { name: nextName } : {}),
            ...(Object.prototype.hasOwnProperty.call(updateData, 'displayColor') ? { displayColor: nextColor } : {}),
          } as any,
        }).catch(() => null)

        // Update all project recipients that link to the same client recipient.
        await prisma.projectRecipient.updateMany({
          where: { clientRecipientId: linkedId },
          data: {
            ...(Object.prototype.hasOwnProperty.call(updateData, 'email') ? { email: nextEmail } : {}),
            ...(Object.prototype.hasOwnProperty.call(updateData, 'name') ? { name: nextName } : {}),
            ...(Object.prototype.hasOwnProperty.call(updateData, 'displayColor') ? { displayColor: nextColor } : {}),
          } as any,
        }).catch(() => null)
      }
    }
  } catch {
    // Ignore sync failures; recipient update succeeded.
  }

  return {
    id: recipient.id,
    clientRecipientId: (recipient as any).clientRecipientId ?? null,
    email: recipient.email,
    name: recipient.name,
    displayColor: recipient.displayColor,
    isPrimary: recipient.isPrimary,
    receiveNotifications: recipient.receiveNotifications
  }
}

/**
 * Delete a recipient
 */
export async function deleteRecipient(recipientId: string): Promise<void> {
  // Fetch recipient with isPrimary status BEFORE deleting
  const recipient = await prisma.projectRecipient.findUnique({
    where: { id: recipientId },
    select: { projectId: true, isPrimary: true }
  })

  if (!recipient) {
    throw new Error('Recipient not found')
  }

  // Delete the recipient
  await prisma.projectRecipient.delete({
    where: { id: recipientId }
  })

  // If deleted recipient WAS primary, promote another recipient to primary
  if (recipient.isPrimary) {
    const remaining = await prisma.projectRecipient.findFirst({
      where: { projectId: recipient.projectId },
      orderBy: { createdAt: 'asc' }
    })

    if (remaining) {
      await prisma.projectRecipient.update({
        where: { id: remaining.id },
        data: { isPrimary: true }
      })
    }
  }
}
