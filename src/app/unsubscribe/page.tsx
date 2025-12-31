import { prisma } from '@/lib/db'
import { generateShareUrl } from '@/lib/url'
import { verifyUnsubscribe } from '@/lib/unsubscribe'
import { redirect } from 'next/navigation'

export const runtime = 'nodejs'

type SearchParams = {
  projectId?: string
  recipientId?: string
  sig?: string
}

async function setRecipientNotifications(params: {
  projectId: string
  recipientId: string
  receiveNotifications: boolean
}) {
  const recipient = await prisma.projectRecipient.findFirst({
    where: { id: params.recipientId, projectId: params.projectId },
    select: { id: true },
  })

  if (!recipient) {
    return false
  }

  await prisma.projectRecipient.update({
    where: { id: recipient.id },
    data: { receiveNotifications: params.receiveNotifications },
  })

  return true
}

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const projectId = sp.projectId || ''
  const recipientId = sp.recipientId || ''
  const sig = sp.sig || ''

  const isValid = verifyUnsubscribe(projectId, recipientId, sig)

  if (!isValid) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold text-foreground">Invalid link</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This unsubscribe link is invalid or has expired.
          </p>
        </div>
      </div>
    )
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, slug: true },
  })

  if (!project) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold text-foreground">Project not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This project no longer exists.
          </p>
        </div>
      </div>
    )
  }

  const recipient = await prisma.projectRecipient.findFirst({
    where: { id: recipientId, projectId },
    select: { id: true, receiveNotifications: true },
  })

  if (!recipient) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold text-foreground">Recipient not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This recipient is no longer associated with the project.
          </p>
        </div>
      </div>
    )
  }

  const shareUrl = await generateShareUrl(project.slug)

  async function unsubscribeAction() {
    'use server'
    const ok = await setRecipientNotifications({
      projectId,
      recipientId,
      receiveNotifications: false,
    })
    redirect(`/unsubscribe?projectId=${encodeURIComponent(projectId)}&recipientId=${encodeURIComponent(recipientId)}&sig=${encodeURIComponent(sig)}${ok ? '' : ''}`)
  }

  async function resubscribeAction() {
    'use server'
    const ok = await setRecipientNotifications({
      projectId,
      recipientId,
      receiveNotifications: true,
    })
    redirect(`/unsubscribe?projectId=${encodeURIComponent(projectId)}&recipientId=${encodeURIComponent(recipientId)}&sig=${encodeURIComponent(sig)}${ok ? '' : ''}`)
  }

  const isSubscribed = recipient.receiveNotifications === true

  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
        {isSubscribed ? (
          <>
            <h1 className="text-xl font-semibold text-foreground">Unsubscribe from updates</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You’re currently subscribed to updates for <span className="font-medium text-foreground">{project.title}</span>.
            </p>

            <p className="mt-3 text-sm text-muted-foreground">
              If you unsubscribe, you will stop receiving “Updates on {project.title}” emails for this project.
            </p>

            <div className="mt-5 flex flex-col gap-2">
              <form action={unsubscribeAction}>
                <button
                  type="submit"
                  className="w-full h-10 rounded-lg btn-destructive text-white font-medium"
                >
                  Unsubscribe
                </button>
              </form>

              <a
                href={shareUrl}
                className="w-full h-10 rounded-lg border border-border bg-card hover:bg-accent hover:text-accent-foreground hover:border-primary/50 shadow-elevation-sm hover:shadow-elevation inline-flex items-center justify-center text-sm font-medium"
              >
                Keep me subscribed
              </a>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              Tip: Some email providers pre-scan links for security. This page requires confirmation to help prevent accidental unsubscribes.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-foreground">You’ve been unsubscribed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You will no longer receive update emails for <span className="font-medium text-foreground">{project.title}</span>.
            </p>

            <div className="mt-5 flex flex-col gap-2">
              <form action={resubscribeAction}>
                <button
                  type="submit"
                  className="w-full h-10 rounded-lg btn-primary text-white font-medium"
                >
                  Undo (keep receiving updates)
                </button>
              </form>

              <a
                href={shareUrl}
                className="w-full h-10 rounded-lg border border-border bg-card hover:bg-accent hover:text-accent-foreground hover:border-primary/50 shadow-elevation-sm hover:shadow-elevation inline-flex items-center justify-center text-sm font-medium"
              >
                View project
              </a>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              If you clicked unsubscribe by mistake, use Undo to re-enable updates.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
