import { GuestAlbumViewer } from './GuestAlbumViewer'

export const dynamic = 'force-dynamic'

export default async function GuestAlbumLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <GuestAlbumViewer token={token} />
}
