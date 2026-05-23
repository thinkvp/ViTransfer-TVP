import fs from 'fs/promises'
import path from 'path'
import assert from 'assert'

const root = process.cwd()

async function read(relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8')
}

async function main() {
  const browser = await read('src/components/ShareFilesBrowser.tsx')
  assert(browser.includes("group.groupType === 'uploads'"), 'ShareFilesBrowser should render uploads groups')
  assert(browser.includes('aria-label="Add upload file"'), 'ShareFilesBrowser should expose upload file action')
  assert(browser.includes('aria-label="Add upload folder"'), 'ShareFilesBrowser should expose upload folder action')
  assert(browser.includes('<File className="w-4 h-4" />'), 'ShareFilesBrowser should show file icon action')
  assert(browser.includes('<Folder className="w-4 h-4" />'), 'ShareFilesBrowser should show folder icon action')
  assert(browser.includes('deleteSelectedUploadFiles'), 'ShareFilesBrowser should expose bulk upload delete action')
  assert(browser.includes('onRenameUploadFolder'), 'ShareFilesBrowser should expose upload folder rename action')
  assert(browser.includes("onDragOver={(event) => {"), 'ShareFilesBrowser should support drag-over upload targeting')
  assert(browser.includes("onDrop={(event) => {"), 'ShareFilesBrowser should support drop upload targeting')
  assert(browser.includes('uploadProgressPercent'), 'ShareFilesBrowser should show inline upload progress')
  assert(browser.includes('Trash2'), 'ShareFilesBrowser should support upload delete action')
  assert(browser.includes('transferItems = []'), 'ShareFilesBrowser should accept transfer rows for upload progress')

  const page = await read('src/app/share/[token]/page.tsx')
  assert(page.includes('transferItems={transferItemsCombined}'), 'share page should pass combined transfer rows into files browser')
  assert(page.includes('handleCreateUploadFolder'), 'share page should wire folder creation')
  assert(page.includes('handleUploadFiles'), 'share page should wire file upload')
  assert(page.includes('handleDeleteUploadFile'), 'share page should wire file delete')
  assert(page.includes('handleDeleteUploadFolder'), 'share page should wire folder delete')
  assert(page.includes('handleRenameUploadFolder'), 'share page should wire folder rename')
  assert(page.includes('canUploadToProjects') && page.includes('project?.allowClientUploadFiles') && page.includes('isAdminSession'), 'share page should gate uploads by role')

  const sidebar = await read('src/components/VideoSidebar.tsx')
  assert(sidebar.includes('autoClearUploadsTimeoutRef'), 'VideoSidebar should auto-clear completed upload transfers')
  assert(sidebar.includes("transfer.direction === 'upload'"), 'VideoSidebar should render upload transfer rows')

  const publicComments = await read('src/app/api/share/[token]/comments/route.ts')
  assert(publicComments.includes('verifyProjectAccess'), 'share comments route regression guard')

  console.log('share uploads UI checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
