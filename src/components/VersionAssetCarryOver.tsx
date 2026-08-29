'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { formatFileSize } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'

export interface CarryOverAsset {
  id: string
  fileName: string
  fileSize: string
  category: string | null
}

export interface CarryOverVersion {
  id: string
  name: string
  version: number
  versionLabel: string
  assets: CarryOverAsset[]
}

/**
 * Per-source selection the upload hands back: which assets to copy from which version.
 * Ordered newest version first — the copy runs in that order so that when the same
 * filename exists in two versions the newest one wins (the copy API skips a filename
 * already present on the target).
 */
export interface CarryOverSelection {
  sourceVideoId: string
  versionLabel: string
  assetIds: string[]
}

interface VersionAssetCarryOverProps {
  projectId: string
  /** Sibling version ids of the video being added to, newest first. */
  siblingVideoIds: string[]
  disabled?: boolean
  onChange: (selection: CarryOverSelection[]) => void
}

/**
 * Opt-in "copy assets from earlier versions" block for the new-version upload panel.
 *
 * Nothing is ticked by default: the collapsed row carries the counts so the offer is
 * discoverable, and the list only opens when the box is ticked. A filename that exists
 * in more than one selected version is counted (and copied) once, from the newest.
 */
export function VersionAssetCarryOver({
  projectId,
  siblingVideoIds,
  disabled = false,
  onChange,
}: VersionAssetCarryOverProps) {
  const [versions, setVersions] = useState<CarryOverVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  // videoId → set of chosen asset ids. A version with an empty set is not selected.
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null)

  const siblingKey = siblingVideoIds.join(',')

  useEffect(() => {
    let cancelled = false
    if (siblingVideoIds.length === 0) {
      setVersions([])
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        setLoading(true)
        const response = await apiFetch(`/api/projects/${projectId}/version-assets`)
        if (!response.ok) throw new Error('Failed to load version assets')
        const data = await response.json()
        if (cancelled) return
        const wanted = new Set(siblingVideoIds)
        const rows: CarryOverVersion[] = (data.videos || [])
          .filter((v: CarryOverVersion) => wanted.has(v.id))
          .sort((a: CarryOverVersion, b: CarryOverVersion) => b.version - a.version)
        setVersions(rows)
      } catch {
        if (!cancelled) setVersions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
    // siblingKey stands in for the array identity, which changes on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, siblingKey])

  const versionsWithAssets = useMemo(() => versions.filter((v) => v.assets.length > 0), [versions])
  const totalAvailable = useMemo(
    () => versionsWithAssets.reduce((sum, v) => sum + v.assets.length, 0),
    [versionsWithAssets]
  )

  /**
   * Filenames already claimed by a newer version in the list, mapped to that version's
   * label. Drives both the "also in vN" hint and the de-duplicated totals.
   */
  const claimedByNewer = useMemo(() => {
    const out = new Map<string, Map<string, string>>()
    const seen = new Map<string, string>()
    for (const version of versionsWithAssets) {
      const forThisVersion = new Map<string, string>()
      for (const asset of version.assets) {
        const key = asset.fileName.trim().toLowerCase()
        const claimant = seen.get(key)
        if (claimant) forThisVersion.set(asset.id, claimant)
      }
      out.set(version.id, forThisVersion)
      for (const asset of version.assets) {
        const key = asset.fileName.trim().toLowerCase()
        if (!seen.has(key)) seen.set(key, version.versionLabel)
      }
    }
    return out
  }, [versionsWithAssets])

  const isVersionSelected = useCallback(
    (videoId: string) => (chosen[videoId]?.length ?? 0) > 0,
    [chosen]
  )

  /** What will actually be copied: selected assets minus names a newer selected version already covers. */
  const effective = useMemo(() => {
    const out: CarryOverSelection[] = []
    const takenNames = new Set<string>()
    for (const version of versionsWithAssets) {
      const picked = chosen[version.id]
      if (!picked?.length) continue
      const assetIds: string[] = []
      for (const asset of version.assets) {
        if (!picked.includes(asset.id)) continue
        const key = asset.fileName.trim().toLowerCase()
        if (takenNames.has(key)) continue
        takenNames.add(key)
        assetIds.push(asset.id)
      }
      if (assetIds.length > 0) {
        out.push({ sourceVideoId: version.id, versionLabel: version.versionLabel, assetIds })
      }
    }
    return out
  }, [versionsWithAssets, chosen])

  const effectiveTotals = useMemo(() => {
    const byId = new Map<string, CarryOverAsset>()
    for (const version of versionsWithAssets) {
      for (const asset of version.assets) byId.set(asset.id, asset)
    }
    const ids = effective.flatMap((s) => s.assetIds)
    return {
      count: ids.length,
      bytes: ids.reduce((sum, id) => sum + Number(byId.get(id)?.fileSize || 0), 0),
    }
  }, [effective, versionsWithAssets])

  useEffect(() => {
    onChange(enabled ? effective : [])
    // onChange identity is owned by the parent; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, effective])

  const toggleEnabled = (next: boolean) => {
    setEnabled(next)
    if (!next) {
      setChosen({})
      setExpandedVersionId(null)
    }
  }

  const toggleVersion = (version: CarryOverVersion) => {
    setChosen((prev) => {
      const next = { ...prev }
      if ((next[version.id]?.length ?? 0) > 0) {
        delete next[version.id]
      } else {
        next[version.id] = version.assets.map((a) => a.id)
      }
      return next
    })
  }

  const toggleAsset = (version: CarryOverVersion, assetId: string) => {
    setChosen((prev) => {
      const current = prev[version.id] ?? []
      const next = current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId]
      const out = { ...prev }
      if (next.length === 0) delete out[version.id]
      else out[version.id] = next
      return out
    })
  }

  if (loading) {
    return (
      <div className="border-t pt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking earlier versions…
      </div>
    )
  }

  if (versions.length === 0) return null

  if (versionsWithAssets.length === 0) {
    return (
      <div className="border-t pt-3 flex items-center gap-2">
        <Checkbox checked={false} disabled aria-label="Copy assets from earlier versions" />
        <span className="text-sm text-muted-foreground">
          Copy assets from earlier versions — no assets on any version
        </span>
      </div>
    )
  }

  return (
    <div className="border-t pt-3 space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => toggleEnabled(Boolean(v))}
          disabled={disabled}
          aria-label="Copy assets from earlier versions"
        />
        <span className="text-sm font-medium">Copy assets from earlier versions</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {enabled
            ? effectiveTotals.count > 0
              ? `${effectiveTotals.count} ${effectiveTotals.count === 1 ? 'file' : 'files'} · ${formatFileSize(effectiveTotals.bytes)}`
              : 'Pick a version'
            : `${versionsWithAssets.length} ${versionsWithAssets.length === 1 ? 'version' : 'versions'} · ${totalAvailable} ${totalAvailable === 1 ? 'file' : 'files'} available`}
        </span>
      </div>

      {enabled && (
        <div className="rounded-md border divide-y">
          {versionsWithAssets.map((version) => {
            const picked = chosen[version.id] ?? []
            const selected = isVersionSelected(version.id)
            const duplicates = claimedByNewer.get(version.id) ?? new Map<string, string>()
            const duplicateLabels = new Set(duplicates.values())
            const isExpanded = expandedVersionId === version.id
            const bytes = version.assets.reduce((sum, a) => sum + Number(a.fileSize || 0), 0)

            return (
              <div key={version.id}>
                <div className="flex items-center gap-2 p-2">
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => toggleVersion(version)}
                    disabled={disabled}
                    aria-label={`Copy assets from ${version.versionLabel}`}
                  />
                  <span className="text-sm font-medium">{version.versionLabel}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {selected && picked.length !== version.assets.length
                      ? `${picked.length} of ${version.assets.length} files`
                      : `${version.assets.length} ${version.assets.length === 1 ? 'file' : 'files'}`}
                    {' · '}
                    {formatFileSize(bytes)}
                    {duplicates.size > 0 && (
                      duplicateLabels.size === 1
                        ? ` · ${duplicates.size} also in ${[...duplicateLabels][0]}`
                        : ` · ${duplicates.size} also in newer versions`
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto shrink-0 text-xs"
                    onClick={() => setExpandedVersionId(isExpanded ? null : version.id)}
                  >
                    {isExpanded ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
                    Choose files
                  </Button>
                </div>

                {isExpanded && (
                  <div className="pl-8 pr-2 pb-2 space-y-1">
                    {version.assets.map((asset) => {
                      const claimant = duplicates.get(asset.id)
                      return (
                        <label key={asset.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <Checkbox
                            checked={picked.includes(asset.id)}
                            onCheckedChange={() => toggleAsset(version, asset.id)}
                            disabled={disabled}
                            aria-label={asset.fileName}
                          />
                          <span className="truncate">{asset.fileName}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {formatFileSize(Number(asset.fileSize || 0))}
                            {claimant ? ` · also in ${claimant}` : ''}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {enabled && (
        <p className="text-xs text-muted-foreground">
          A filename in two versions copies once, from the newest.
        </p>
      )}
    </div>
  )
}
