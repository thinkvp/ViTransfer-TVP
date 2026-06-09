import { prisma } from '../src/lib/db';
async function main() {
  // Get a video with v2 that has a different filename than v1
  const video = await prisma.video.findFirst({
    where: { version: 2, status: 'READY' },
    select: { id: true, name: true, versionLabel: true },
  });
  console.log('Video:', video?.name, video?.versionLabel, video?.id);
  
  const orig = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType: 'VIDEO', entityId: video!.id, fileRole: 'ORIGINAL' } },
    select: { fileName: true, storagePath: true },
  });
  console.log('StoredFile ORIGINAL:', orig?.fileName, orig?.storagePath);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
