import fs from 'fs/promises'
import path from 'path'
import assert from 'assert'
import { buildProjectUploadFileStoragePath, buildProjectUploadFolderStoragePath, buildProjectUploadsRoot, normalizeProjectUploadRelativePath } from '@/lib/project-storage-paths'
import { checkProjectUploadQuota, getProjectUploadUsageBytes } from '@/lib/project-upload-quota'

const root = process.cwd()

async function read(relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8')
}

async function main() {
  assert.equal(normalizeProjectUploadRelativePath(' /../Client Notes//Q1\\Drafts '), 'Client Notes/Q1/Drafts')
  assert.equal(buildProjectUploadsRoot('clients/Acme/projects/Review'), 'clients/Acme/projects/Review/uploads')
  assert.equal(buildProjectUploadFolderStoragePath('clients/Acme/projects/Review', '../Approved Files'), 'clients/Acme/projects/Review/uploads/Approved Files')
  assert.equal(
    buildProjectUploadFileStoragePath('clients/Acme/projects/Review', 'Client Notes', 'quote.pdf'),
    'clients/Acme/projects/Review/uploads/Client Notes/quote.pdf'
  )

  const mockPrisma = {
    commentFile: {
      aggregate: async () => ({ _sum: { fileSize: BigInt(12 * 1024 * 1024) } }),
    },
    shareUploadFile: {
      aggregate: async () => ({ _sum: { fileSize: BigInt(3 * 1024 * 1024) } }),
    },
  } as any

  const usage = await getProjectUploadUsageBytes('project-1', mockPrisma)
  assert.equal(usage.commentBytes, BigInt(12 * 1024 * 1024))
  assert.equal(usage.uploadsBytes, BigInt(3 * 1024 * 1024))
  assert.equal(usage.totalBytes, BigInt(15 * 1024 * 1024))

  const allowed = await checkProjectUploadQuota('project-1', 16, BigInt(1 * 1024 * 1024), mockPrisma)
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.totalUsedBytes, BigInt(15 * 1024 * 1024))
  assert.equal(allowed.remainingBytes, BigInt(1 * 1024 * 1024))

  const denied = await checkProjectUploadQuota('project-1', 15, BigInt(2 * 1024 * 1024), mockPrisma)
  assert.equal(denied.allowed, false)

  const uploadsRoute = await read('src/app/api/share/[token]/uploads/route.ts')
  assert(uploadsRoute.includes('if (!access.canUpload)'), 'uploads route should deny non-uploaders')
  assert(uploadsRoute.includes('if (!access.canDelete)'), 'uploads route should deny non-deleters')
  assert(uploadsRoute.includes('resolveShareUploadAccess'), 'uploads route should resolve share upload access')

  const uploadFilesRoute = await read('src/app/api/share/[token]/uploads/files/route.ts')
  assert(uploadFilesRoute.includes('checkProjectUploadQuota'), 'upload files route should enforce combined quota')
  assert(uploadFilesRoute.includes('if (!access.canUpload)'), 'upload files route should deny non-uploaders')
  assert(uploadFilesRoute.includes('shareUploadFile.create'), 'upload files route should persist upload file metadata')

  const commentFilesRoute = await read('src/app/api/comments/[id]/files/route.ts')
  assert(commentFilesRoute.includes('checkProjectUploadQuota'), 'comment file uploads should use combined quota')

  const commentS3Route = await read('src/app/api/comments/[id]/files/s3/presign/route.ts')
  assert(commentS3Route.includes('checkProjectUploadQuota'), 'comment S3 uploads should use combined quota')

  const shareUploadAccess = await read('src/lib/share-uploads.ts')
  assert(shareUploadAccess.includes('canUpload = access.isAdmin || (!isGuest && project.allowClientUploadFiles)'), 'share upload access should permit enabled clients')
  assert(shareUploadAccess.includes('canDelete = access.isAdmin'), 'share upload access should restrict delete to admins')

  console.log('share uploads API checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
