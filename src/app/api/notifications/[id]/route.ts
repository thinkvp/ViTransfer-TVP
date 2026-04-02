import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import {
	isClearablePinnedNotificationDetails,
} from '@/lib/pinned-system-notifications'

export const runtime = 'nodejs'

const noStoreHeaders = {
	'Cache-Control': 'no-store',
	Pragma: 'no-cache',
} as const

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> }
) {
	const authResult = await requireApiAdmin(request)
	if (authResult instanceof Response) {
		return authResult
	}

	if (authResult.appRoleIsSystemAdmin !== true) {
		return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders })
	}

	try {
		const { id } = await params

		const notification = await prisma.pushNotificationLog.findFirst({
			where: {
				id,
			},
			select: {
				id: true,
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

		await prisma.pushNotificationLog.delete({
			where: { id: notification.id },
		})

		return NextResponse.json({ success: true }, { headers: noStoreHeaders })
	} catch (error) {
		console.error('Error clearing notification:', error)
		return NextResponse.json({ error: 'Failed to clear notification' }, { status: 500, headers: noStoreHeaders })
	}
}
