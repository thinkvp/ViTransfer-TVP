/**
 * Diagnostic: Compare StoredFile paths against Video.storageFolderName
 * to detect stale paths after a failed rename.
 *
 * Run: npx ts-node --skip-project scripts/check-storedfile-paths.ts
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

async function main() {
  const videos = await p.video.findMany({
    where: { status: 'READY' },
    select: { id: true, name: true, storageFolderName: true, versionLabel: true, projectId: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })

  let mismatches = 0

  for (const v of videos) {
    const sf = await p.storedFile.findFirst({
      where: { entityType: 'VIDEO', entityId: v.id, fileRole: 'ORIGINAL' },
      select: { storagePath: true },
    })

    if (!sf) {
      console.log(`⚠️  ${v.name}: No ORIGINAL StoredFile record`)
      continue
    }

    const expectedFolder = v.storageFolderName || v.name
    const pathParts = sf.storagePath.split('/')
    // Path: .../videos/{folderName}/{versionLabel}/{filename}
    // The videos folder is at index -3 (filename at -1, versionLabel at -2, folder at -3)
    const actualFolder = pathParts[pathParts.length - 3]

    const status = actualFolder !== expectedFolder ? '❌ MISMATCH' : '✅'
    if (actualFolder !== expectedFolder) mismatches++

    console.log(`${status} | DB: "${expectedFolder}" | StoredFile: "${actualFolder}" | ${v.name}`)
    console.log(`       StoredFile path: ${sf.storagePath}`)
  }

  console.log(`\nTotal mismatches: ${mismatches}`)
  if (mismatches > 0) {
    console.log('\nRun the following to fix:')
    console.log('  1. Rename the mismatched video to any other name (triggers a new folder rename job)')
    console.log('  2. The worker will now use the correct StoredFile prefix and update paths')
  }

  await p.$disconnect()
}

main().catch(e => { console.error(e); p.$disconnect() })
