import { Folder } from 'lucide-react'

/**
 * The folder "card" preview used in the FILES browser root grid: a small folder-tab
 * shape framing a 3-tile mosaic of up to three preview thumbnails (lead tile spans
 * 2x2, two stacked side tiles). Falls back to a single preview, a video poster
 * (uploads only), or a folder icon. Shared so the sidebar UPLOADS entry renders
 * identically to the FILES browser.
 */
export function FolderPreviewMosaic({
  label,
  tiles,
  fallbackPreview = null,
  videoPoster = null,
  isUploads = false,
  onTileError,
}: {
  label: string
  tiles: string[]
  fallbackPreview?: string | null
  videoPoster?: string | null
  isUploads?: boolean
  onTileError?: () => void
}) {
  const leadPreview = tiles[0] || null
  const sidePreviewTop = tiles[1] || null
  const sidePreviewBottom = tiles[2] || null
  const showVideoFolderPreview = !leadPreview && Boolean(videoPoster) && isUploads

  return (
    <div className="relative pt-2">
      {/* Folder tab sized as a fraction of the card so it scales with the
          mosaic width (sidebar resize + FILES grid breakpoints) instead of a
          fixed width that overflows narrow folders. */}
      <div className="absolute left-[5%] top-0 h-2.5 w-[30%] rounded-t-md border border-b-0 border-primary/55 bg-primary/30" />
      <div className="relative rounded-lg rounded-tl-sm border border-primary/50 bg-primary/20 p-1.5 shadow-inner shadow-black/10">
        <div className="grid grid-cols-3 grid-rows-2 gap-1.5 aspect-[16/10] rounded-md overflow-hidden bg-primary/20">
          {leadPreview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={leadPreview}
                alt={label}
                className="col-span-2 row-span-2 h-full w-full object-contain bg-black"
                loading="lazy"
                onError={() => onTileError?.()}
              />

              {sidePreviewTop ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sidePreviewTop}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-contain bg-black"
                  loading="lazy"
                  onError={() => onTileError?.()}
                />
              ) : (
                <div className="h-full w-full bg-primary/35" aria-hidden="true" />
              )}

              {sidePreviewBottom ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sidePreviewBottom}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-contain bg-black"
                  loading="lazy"
                  onError={() => onTileError?.()}
                />
              ) : (
                <div className="h-full w-full bg-primary/30" aria-hidden="true" />
              )}
            </>
          ) : fallbackPreview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fallbackPreview}
                alt={label}
                className="col-span-2 row-span-2 h-full w-full object-contain bg-black"
                loading="lazy"
                onError={() => onTileError?.()}
              />
              <div className="h-full w-full bg-primary/35" aria-hidden="true" />
              <div className="h-full w-full bg-primary/30" aria-hidden="true" />
            </>
          ) : showVideoFolderPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={videoPoster || undefined}
              alt={label}
              className="col-span-3 row-span-2 h-full w-full object-contain bg-black"
              loading="lazy"
              onError={() => onTileError?.()}
            />
          ) : (
            <div className="col-span-3 row-span-2 h-full w-full flex items-center justify-center text-primary/70">
              <Folder className="w-9 h-9" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
