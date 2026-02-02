import { GuestVideoViewer } from './GuestVideoViewer'

export const dynamic = 'force-dynamic'

export default async function GuestVideoLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <GuestVideoViewer token={token} />
}
