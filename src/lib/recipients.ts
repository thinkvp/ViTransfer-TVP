import { prisma } from './db'
import { generateRandomHexDisplayColor, normalizeHexDisplayColor } from './display-color'
import { getSafeguardLimits } from './settings'

export interface Recipient {
  id?: string
  email: string | null
  name: string | null
  displayColor?: string | null
  isPrimary: boolean
  receiveNotifications: boolean
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
  alsoAddToClient?: boolean
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

  const recipient = await prisma.projectRecipient.create({
    data: {
      projectId,
      email,
      name,
      isPrimary,
      displayColor: normalizedColor ?? generateRandomHexDisplayColor(),
    }
  })

  // Keep client recipient colour in sync (best-effort) when a project belongs to a client.
  // If alsoAddToClient is true, ensure the recipient exists on the client as well.
  if (recipient.email) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { clientId: true },
      })
      const clientId = project?.clientId
      if (clientId) {
        if (alsoAddToClient) {
          const existing = await prisma.clientRecipient.findFirst({
            where: { clientId, email: recipient.email },
            select: { id: true },
          })

          if (existing) {
            await prisma.clientRecipient.update({
              where: { id: existing.id },
              data: {
                displayColor: recipient.displayColor,
                ...(recipient.name ? { name: recipient.name } : {}),
              },
            })
          } else {
            await prisma.clientRecipient.create({
              data: {
                clientId,
                email: recipient.email,
                name: recipient.name,
                displayColor: recipient.displayColor,
                isPrimary: false,
                receiveNotifications: true,
              },
            })
          }
        } else {
          await prisma.clientRecipient.updateMany({
            where: { clientId, email: recipient.email },
            data: { displayColor: recipient.displayColor },
          })
        }
      }
    } catch {
      // Ignore sync failures; project recipient was created successfully.
    }
  }

  return {
    id: recipient.id,
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
  data: { name?: string | null; email?: string | null; displayColor?: string | null; isPrimary?: boolean; receiveNotifications?: boolean }
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

  // Keep client recipient colour in sync (best-effort) when a project belongs to a client.
  if (Object.prototype.hasOwnProperty.call(updateData, 'displayColor') && recipient.email) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: recipient.projectId },
        select: { clientId: true },
      })
      const clientId = project?.clientId
      if (clientId) {
        await prisma.clientRecipient.updateMany({
          where: { clientId, email: recipient.email },
          data: { displayColor: recipient.displayColor },
        })
      }
    } catch {
      // Ignore sync failures; recipient update succeeded.
    }
  }

  return {
    id: recipient.id,
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
