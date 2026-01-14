import { prisma } from '@/lib/db'

export async function getLatestShareTokenForSalesDoc(
  docType: 'QUOTE' | 'INVOICE',
  docId: string
) {
  const share = await prisma.salesDocumentShare.findFirst({
    where: {
      type: docType,
      docId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { token: true },
  })

  return share?.token || null
}
