import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import {
	isClearablePinnedNotificationDetails,
} from '@/lib/pinned-system-notifications'

export const runtime = 'nodejs'

const noStoreHeaders = {
	'Cache-Control': 'no-store',
	Pragma: 'no-cache',
} as const

// Notification types that any authenticated user can clear if they are the target.
const USER_CLEARABLE_TYPES = ['TASK_USER_ASSIGNED', 'PROJECT_USER_ASSIGNED']

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> }
) {
	const authResult = await requireApiUser(request)
	if (authResult instanceof Response) {
		return authResult
	}

	const isSystemAdmin = authResult.appRoleIsSystemAdmin === true

	try {
		const { id } = await params

		const notification = await prisma.pushNotificationLog.findFirst({
			where: {
				id,
			},
			select: {
				id: true,
				type: true,
				details: true,
			},
		})

		if (!notification) {
			return NextResponse.json({ error: 'Notification not found' }, { status: 404, headers: noStoreHeaders })
		}

		if (!isClearablePinnedNotificationDetails(notification.details)) {
			return NextResponse.json(
				{ error: 'Notification cannot be cleared manually' },
				{ status: 400, headers: noStoreHeaders }
			)
		}

		// System admins can clear any clearable pinned notification.
		// Non-admins can only clear their own user-targeted assignment notifications.
		if (!isSystemAdmin) {
			const isUserClearable = USER_CLEARABLE_TYPES.includes(notification.type ?? '')
			const targetUserId = (notification.details as any)?.__meta?.targetUserId
			if (!isUserClearable || targetUserId !== authResult.id) {
				return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders })
			}
		}

		await prisma.pushNotificationLog.delete({
			where: { id: notification.id },
		})

		return NextResponse.json({ success: true }, { headers: noStoreHeaders })
	} catch (error) {
		console.error('Error clearing notification:', error)
		return NextResponse.json({ error: 'Failed to clear notification' }, { status: 500, headers: noStoreHeaders })
	}
}
