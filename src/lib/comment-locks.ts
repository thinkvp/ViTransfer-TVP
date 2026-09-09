import { prisma } from '@/lib/db'

/**
 * Freeze the client-visible feedback on a video that has just been signed off.
 *
 * Approving a video no longer closes feedback — it locks what has already been said
 * (exactly like the client's "Request Next Version" flow) while leaving the comment box
 * open for anything that comes up afterwards. Locked comments can no longer be
 * edited/deleted/reacted to by share sessions; admins are unaffected.
 *
 * Locking covers every version of the video's name group, not just the approved one:
 * approval signs off the video as a whole, so the notes left on earlier cuts are
 * historical too (and the share page only offers the approved version once it exists).
 */
export async function lockCommentsForApprovedVideo(params: {
  projectId: string
  videoName: string
  at?: Date
}): Promise<number> {
  const { projectId, videoName, at = new Date() } = params

  const result = await prisma.comment.updateMany({
    where: {
      projectId,
      isInternal: false,
      lockedAt: null,
      video: { name: videoName },
    },
    data: { lockedAt: at },
  })

  return result.count
}

/**
 * Freeze the client-visible feedback across a whole project that has just been signed off.
 *
 * Used when a project's status becomes APPROVED. The auto-approve path already locks each
 * video's feedback as it is approved; this covers the admin flipping the project's status
 * directly, which the share page presents to the client as sign-off just the same.
 */
export async function lockCommentsForApprovedProject(params: {
  projectId: string
  at?: Date
}): Promise<number> {
  const { projectId, at = new Date() } = params

  const result = await prisma.comment.updateMany({
    where: { projectId, isInternal: false, lockedAt: null },
    data: { lockedAt: at },
  })

  return result.count
}
