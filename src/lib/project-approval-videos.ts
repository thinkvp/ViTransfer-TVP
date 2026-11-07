import { prisma } from '@/lib/db'

/**
 * What marking a project APPROVED does to its videos.
 *
 * An admin flipping a project's status to Approved signs off every video in it, so each
 * video that has no approved version yet gets its latest version approved — as long as
 * that version is approvable (the same rules the share page uses: approval allowed on
 * the version, processing finished, and the client hasn't asked for a next version).
 * Approval is what unlocks the download for the client; without it the share page would
 * show a signed-off project whose videos can't be downloaded or approved by anyone.
 *
 * Videos whose latest version isn't approvable are left alone and reported back so the
 * status picker can warn the admin before the change is made.
 */

export type ProjectApprovalSkipReason = 'APPROVAL_DISABLED' | 'NEXT_VERSION_REQUESTED' | 'NOT_READY'

export interface ProjectApprovalVideoPlan {
  /** Latest versions that will be approved, one per video name. */
  toApprove: Array<{ id: string; name: string; versionLabel: string }>
  /** Videos with no approved version whose latest version can't be approved. */
  notApprovable: Array<{ id: string; name: string; versionLabel: string; reason: ProjectApprovalSkipReason }>
  /** Number of videos (name groups) that already have an approved version. */
  alreadyApprovedCount: number
}

export async function planProjectApprovalVideos(projectId: string): Promise<ProjectApprovalVideoPlan> {
  const videos = await prisma.video.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      version: true,
      versionLabel: true,
      status: true,
      approved: true,
      allowApproval: true,
      revisionRequestedAt: true,
    },
  })

  const byName = new Map<string, typeof videos>()
  for (const video of videos) {
    const group = byName.get(video.name)
    if (group) group.push(video)
    else byName.set(video.name, [video])
  }

  const plan: ProjectApprovalVideoPlan = { toApprove: [], notApprovable: [], alreadyApprovedCount: 0 }

  for (const [name, versions] of byName) {
    if (versions.some((v) => v.approved)) {
      plan.alreadyApprovedCount += 1
      continue
    }
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a))
    const entry = { id: latest.id, name, versionLabel: latest.versionLabel }
    if (latest.status !== 'READY') {
      plan.notApprovable.push({ ...entry, reason: 'NOT_READY' })
    } else if (!latest.allowApproval) {
      plan.notApprovable.push({ ...entry, reason: 'APPROVAL_DISABLED' })
    } else if (latest.revisionRequestedAt) {
      plan.notApprovable.push({ ...entry, reason: 'NEXT_VERSION_REQUESTED' })
    } else {
      plan.toApprove.push(entry)
    }
  }

  const byNameAsc = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  plan.toApprove.sort(byNameAsc)
  plan.notApprovable.sort(byNameAsc)
  return plan
}

/**
 * Approve the planned versions, attributed to the admin who approved the project.
 * Returns the ids actually approved. Comment locking is left to the caller, which
 * locks the whole project's feedback on approval anyway.
 */
export async function approveVideosForProjectApproval(params: {
  projectId: string
  plan: ProjectApprovalVideoPlan
  admin: { id: string; name?: string | null; email?: string | null }
  at?: Date
}): Promise<string[]> {
  const { projectId, plan, admin, at = new Date() } = params
  const approvedIds: string[] = []

  for (const video of plan.toApprove) {
    // Only approve if the group still has no approved version — a client or another
    // admin may have approved a version between planning and now.
    const siblingApproved = await prisma.video.count({
      where: { projectId, name: video.name, approved: true },
    })
    if (siblingApproved > 0) continue

    const result = await prisma.video.updateMany({
      where: { id: video.id, approved: false },
      data: {
        approved: true,
        approvedAt: at,
        approvedById: admin.id,
        approvedByRecipientId: null,
        approvedByName: admin.name || admin.email || 'Admin',
      },
    })
    if (result.count > 0) approvedIds.push(video.id)
  }

  return approvedIds
}
