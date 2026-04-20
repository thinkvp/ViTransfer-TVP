'use client'

import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GripVertical, Loader2, Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import { TaxRateSelect } from '@/components/sales/TaxRateSelect'
import { SearchableLabelSelect } from '@/components/admin/sales/SearchableLabelSelect'
import { dollarsToCents } from '@/lib/sales/money'
import {
  createSalesItem,
  deleteSalesItem,
  deleteSalesPreset,
  listSalesItems,
  listSalesLabels,
  listSalesPresets,
  reorderSalesItems,
  saveSalesPreset,
  updateSalesItem,
} from '@/lib/sales/admin-api'
import type { SalesItem, SalesLabel, SalesPreset } from '@/lib/sales/admin-api'
import type { SalesLineItem, SalesTaxRate } from '@/lib/sales/types'

// Types

type AddForm = {
  description: string
  details: string
  quantity: string
  unitPrice: string
  taxRatePercent: number
  taxRateName?: string
  labelId?: string
}

const NO_LABEL_VALUE = '__NO_LABEL__'

// Helpers

function itemToLineItem(it: SalesItem): SalesLineItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `li-${Date.now()}-${Math.random()}`,
    description: it.description,
    details: it.details || undefined,
    quantity: it.quantity,
    unitPriceCents: it.unitPriceCents,
    taxRatePercent: it.taxRatePercent,
    taxRateName: it.taxRateName ?? undefined,
    labelId: it.labelId ?? null,
    labelName: it.labelName ?? null,
    labelColor: it.labelColor ?? null,
  }
}

function formatUnitPrice(cents: number, currencySymbol: string): string {
  const abs = Math.abs(cents)
  const dollars = (abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${cents < 0 ? '-' : ''}${currencySymbol}${dollars}`
}

// Component

interface SalesLineItemPresetsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  taxRates: SalesTaxRate[]
  defaultTaxRatePercent: number
  currencySymbol: string
  onImport: (items: SalesLineItem[]) => void
}

export function SalesLineItemPresetsModal({
  open,
  onOpenChange,
  taxRates,
  defaultTaxRatePercent,
  currencySymbol,
  onImport,
}: SalesLineItemPresetsModalProps) {
  function buildDefaultItemForm(): AddForm {
    const def = taxRates.find((r) => r.isDefault)
    return {
      description: '',
      details: '',
      quantity: '1',
      unitPrice: '',
      taxRatePercent: defaultTaxRatePercent,
      taxRateName: def?.name,
      labelId: '',
    }
  }

  // Library & presets
  const [items, setItems] = useState<SalesItem[]>([])
  const [presets, setPresets] = useState<SalesPreset[]>([])
  const [labels, setLabels] = useState<SalesLabel[]>([])
  const [loading, setLoading] = useState(false)

  // Selection
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')

  // Item form
  const [showItemForm, setShowItemForm] = useState(false)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [itemForm, setItemForm] = useState<AddForm>(buildDefaultItemForm)
  const [submittingItem, setSubmittingItem] = useState(false)
  const [itemError, setItemError] = useState<string | null>(null)
  const [reorderingItems, setReorderingItems] = useState(false)
  const dragEnabledRef = useRef(false)
  const dragIndexRef = useRef<number | null>(null)
  const dragOverIndexRef = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // Save preset
  const [showSaveName, setShowSaveName] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Delete preset / item
  const [deleting, setDeleting] = useState(false)

  // Load library + presets on open
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    Promise.all([listSalesItems(), listSalesPresets(), listSalesLabels()])
      .then(([itemList, presetList, labelList]) => {
        if (!cancelled) {
          setItems(itemList)
          setPresets(presetList)
          setLabels(labelList)
        }
      })
      .catch(() => {/* errors handled silently; lists stay empty */})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  // Reset selection state on close (keep items/presets cached)
  useEffect(() => {
    if (!open) {
      setCheckedIds(new Set())
      setSelectedPresetId('')
      setShowItemForm(false)
      setEditingItemId(null)
      setShowSaveName(false)
      setSaveName('')
      setSaveError(null)
      setItemError(null)
      dragEnabledRef.current = false
      dragIndexRef.current = null
      dragOverIndexRef.current = null
      setDragOverIndex(null)
    }
  }, [open])

  // Sync default tax rate to item form when the form is not active
  useEffect(() => {
    if (showItemForm) return
    const def = taxRates.find((r) => r.isDefault)
    setItemForm((prev) => ({
      ...prev,
      taxRatePercent: defaultTaxRatePercent,
      taxRateName: def?.name,
    }))
  }, [taxRates, defaultTaxRatePercent, showItemForm])

  // Select preset -> tick its items
  function handleSelectPreset(id: string) {
    setSelectedPresetId(id)
    if (!id) {
      setCheckedIds(new Set())
      return
    }
    const preset = presets.find((p) => p.id === id)
    if (preset) {
      setCheckedIds(new Set(preset.itemIds))
    }
  }

  // Toggle individual checkbox
  function toggleCheck(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleCheckAll() {
    if (checkedIds.size === items.length && items.length > 0) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(items.map((it) => it.id)))
    }
  }

  // Item form helpers
  function resetItemForm() {
    setItemForm(buildDefaultItemForm())
    setItemError(null)
    setEditingItemId(null)
  }

  function handleStartAddItem() {
    resetItemForm()
    setShowItemForm(true)
    setShowSaveName(false)
  }

  function handleStartEditItem(item: SalesItem) {
    setEditingItemId(item.id)
    setItemForm({
      description: item.description,
      details: item.details || '',
      quantity: String(item.quantity),
      unitPrice: (item.unitPriceCents / 100).toFixed(2),
      taxRatePercent: item.taxRatePercent,
      taxRateName: item.taxRateName ?? undefined,
      labelId: item.labelId ?? '',
    })
    setItemError(null)
    setShowItemForm(true)
    setShowSaveName(false)
  }

  function handleCancelItemForm() {
    setShowItemForm(false)
    resetItemForm()
  }

  async function handleSubmitItem() {
    const description = itemForm.description.trim()
    if (!description) return
    const qty = parseFloat(itemForm.quantity)
    const quantity = Number.isFinite(qty) && qty >= 0 ? qty : 1
    const unitPriceCents = dollarsToCents(itemForm.unitPrice)

    setSubmittingItem(true)
    setItemError(null)
    try {
      if (editingItemId) {
        const updated = await updateSalesItem(editingItemId, {
          description,
          details: itemForm.details,
          quantity,
          unitPriceCents,
          taxRatePercent: itemForm.taxRatePercent,
          taxRateName: itemForm.taxRateName ?? null,
          labelId: itemForm.labelId || null,
        })
        setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      } else {
        const created = await createSalesItem({
          description,
          details: itemForm.details,
          quantity,
          unitPriceCents,
          taxRatePercent: itemForm.taxRatePercent,
          taxRateName: itemForm.taxRateName ?? null,
          labelId: itemForm.labelId || null,
        })
        setItems((prev) => [...prev, created])
        setCheckedIds((prev) => {
          const next = new Set(prev)
          next.add(created.id)
          return next
        })
      }
      handleCancelItemForm()
    } catch (e) {
      setItemError(e instanceof Error ? e.message : editingItemId ? 'Failed to update item.' : 'Failed to create item.')
    } finally {
      setSubmittingItem(false)
    }
  }

  async function persistItemOrder(nextItems: SalesItem[], previousItems: SalesItem[]) {
    setReorderingItems(true)
    try {
      const reorderedItems = await reorderSalesItems(nextItems.map((item) => item.id))
      setItems(reorderedItems)
    } catch {
      setItems(previousItems)
      alert('Failed to save item order.')
    } finally {
      setReorderingItems(false)
    }
  }

  // Delete library item permanently
  async function handleDeleteItem(id: string) {
    const item = items.find((it) => it.id === id)
    if (!item) return
    if (!confirm(`Delete "${item.description}" from the library? This cannot be undone.`)) return
    try {
      await deleteSalesItem(id)
      setItems((prev) => prev.filter((it) => it.id !== id))
      setCheckedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (editingItemId === id) handleCancelItemForm()
    } catch {
      alert('Failed to delete item.')
    }
  }

  // Save preset
  async function handleSavePreset() {
    const name = saveName.trim()
    if (!name) {
      setSaveError('Enter a preset name.')
      return
    }
    if (checkedIds.size === 0) {
      setSaveError('Tick at least one item to include in the preset.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      // Preserve display order
      const itemIds = items.filter((it) => checkedIds.has(it.id)).map((it) => it.id)
      const saved = await saveSalesPreset({ name, itemIds })
      const list = await listSalesPresets()
      setPresets(list)
      setSelectedPresetId(saved.id)
      setShowSaveName(false)
      setSaveName('')
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save preset.')
    } finally {
      setSaving(false)
    }
  }

  // Delete preset (items remain in library)
  async function handleDeletePreset() {
    if (!selectedPresetId) return
    const preset = presets.find((p) => p.id === selectedPresetId)
    if (!preset) return
    if (!confirm(`Delete preset "${preset.name}"? Items in your library will not be affected.`)) return
    setDeleting(true)
    try {
      await deleteSalesPreset(selectedPresetId)
      const list = await listSalesPresets()
      setPresets(list)
      setSelectedPresetId('')
    } catch {
      alert('Failed to delete preset.')
    } finally {
      setDeleting(false)
    }
  }

  // Import
  function handleImport() {
    const toImport = items
      .filter((it) => checkedIds.has(it.id))
      .map(itemToLineItem)
    if (toImport.length === 0) return
    onImport(toImport)
    onOpenChange(false)
  }

  // Derived
  const allChecked = items.length > 0 && checkedIds.size === items.length
  const selectedPreset = presets.find((p) => p.id === selectedPresetId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-full max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>Line Item Library</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

          {/* Preset selector row */}
          <div className="flex items-center gap-3 flex-wrap">
            <Label className="shrink-0 text-sm font-medium">Preset:</Label>
            <div className="flex-1 min-w-[180px] max-w-xs">
              <Select value={selectedPresetId} onValueChange={handleSelectPreset} disabled={loading}>
                <SelectTrigger className="h-9">
                  {loading ? (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                    </span>
                  ) : (
                    <SelectValue placeholder="Select a preset..." />
                  )}
                </SelectTrigger>
                <SelectContent>
                  {presets.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">No presets saved yet.</div>
                  )}
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowSaveName((v) => !v)
                setShowItemForm(false)
                setEditingItemId(null)
                setSaveError(null)
                if (!showSaveName) setSaveName(selectedPreset?.name ?? '')
              }}
              disabled={checkedIds.size === 0}
            >
              Save as preset
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDeletePreset}
              disabled={!selectedPresetId || deleting}
              className="text-destructive hover:text-destructive"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Delete preset
            </Button>
          </div>

          {/* Save preset name form */}
          {showSaveName && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Preset name</Label>
                <Input
                  value={saveName}
                  onChange={(e) => { setSaveName(e.target.value); setSaveError(null) }}
                  placeholder="e.g. Standard Package"
                  className="h-9 max-w-xs"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSavePreset() }}
                />
              </div>
              {saveError && <p className="text-xs text-destructive">{saveError}</p>}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void handleSavePreset()} disabled={saving || !saveName.trim()}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowSaveName(false); setSaveError(null) }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Add item button + form */}
          <div>
            {!showItemForm && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleStartAddItem}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add item to library
              </Button>
            )}

            {showItemForm && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">
                      Item name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      value={itemForm.description}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, description: e.target.value }))}
                      placeholder="e.g. Video Editing (Day Rate)"
                      className="h-9"
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmitItem() }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Default Qty</Label>
                    <Input
                      type="number"
                      min={0}
                      value={itemForm.quantity}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, quantity: e.target.value }))}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit price ({currencySymbol})</Label>
                    <Input
                      value={itemForm.unitPrice}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, unitPrice: e.target.value }))}
                      placeholder="0.00"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex h-4 items-center">
                      <Label className="text-xs">Tax</Label>
                    </div>
                    <TaxRateSelect
                      value={itemForm.taxRatePercent}
                      onChange={(rate, name) => setItemForm((prev) => ({ ...prev, taxRatePercent: rate, taxRateName: name }))}
                      taxRates={taxRates}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex h-4 items-center">
                      <Label className="flex items-center gap-1 text-xs">
                        <Tag className="w-3 h-3" /> Label
                      </Label>
                    </div>
                    <SearchableLabelSelect
                      value={itemForm.labelId || null}
                      labels={labels}
                      onChange={(labelId) => setItemForm((prev) => ({ ...prev, labelId: labelId ?? '' }))}
                      triggerClassName="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Description (optional)</Label>
                    <Textarea
                      value={itemForm.details}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, details: e.target.value }))}
                      placeholder="Optional paragraph description..."
                      className="min-h-[70px] text-sm"
                    />
                  </div>
                </div>
                {itemError && <p className="text-xs text-destructive">{itemError}</p>}
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void handleSubmitItem()} disabled={submittingItem || !itemForm.description.trim()}>
                    {submittingItem ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    {editingItemId ? 'Save changes' : 'Add to library'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleCancelItemForm}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Items table */}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading library...
            </div>
          ) : items.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[600px] text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="w-9 px-2 py-2" aria-hidden />
                    <th className="w-9 px-2 py-2 text-center">
                      <Checkbox
                        checked={allChecked}
                        onCheckedChange={toggleCheckAll}
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Item</th>
                    <th className="w-20 px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">Default Qty</th>
                    <th className="w-28 px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">Unit ({currencySymbol})</th>
                    <th className="w-24 px-3 py-2 text-right font-medium text-muted-foreground">Tax</th>
                    <th className="w-8 px-2 py-2" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {items.flatMap((it) => {
                    const isChecked = checkedIds.has(it.id)
                    const index = items.findIndex((item) => item.id === it.id)

                    const mainRow = (
                      <tr
                        key={it.id}
                        draggable={!reorderingItems}
                        onDragStart={(e) => {
                          if (!dragEnabledRef.current || reorderingItems) {
                            e.preventDefault()
                            return
                          }
                          dragIndexRef.current = index
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          dragEnabledRef.current = false
                          dragIndexRef.current = null
                          dragOverIndexRef.current = null
                          setDragOverIndex(null)
                        }}
                        onDragOver={(e) => {
                          e.preventDefault()
                          if (reorderingItems) return
                          dragOverIndexRef.current = index
                          setDragOverIndex(index)
                        }}
                        onDragLeave={() => {
                          if (dragOverIndexRef.current === index) setDragOverIndex(null)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (reorderingItems) return
                          const from = dragIndexRef.current
                          const to = dragOverIndexRef.current
                          dragEnabledRef.current = false
                          dragIndexRef.current = null
                          dragOverIndexRef.current = null
                          setDragOverIndex(null)
                          if (from === null || to === null || from === to) return
                          const previousItems = [...items]
                          const nextItems = [...items]
                          const [moved] = nextItems.splice(from, 1)
                          nextItems.splice(to, 0, moved)
                          setItems(nextItems)
                          void persistItemOrder(nextItems, previousItems)
                        }}
                        className={[
                          'transition-colors group',
                          it.details ? '' : 'border-b border-border',
                          dragOverIndex === index && dragIndexRef.current !== index ? 'bg-primary/10' : '',
                          isChecked ? 'bg-primary/5' : 'hover:bg-muted/30',
                        ].filter(Boolean).join(' ')}
                      >
                        <td className="px-2 py-2.5 align-middle text-center">
                          <div
                            className={[
                              'inline-flex items-center justify-center rounded p-1 text-muted-foreground transition-colors',
                              reorderingItems ? 'cursor-not-allowed opacity-50' : 'cursor-grab active:cursor-grabbing hover:text-foreground',
                            ].join(' ')}
                            onMouseDown={() => { if (!reorderingItems) dragEnabledRef.current = true }}
                            onMouseUp={() => { dragEnabledRef.current = false }}
                            title={reorderingItems ? 'Saving order...' : 'Drag to reorder'}
                          >
                            <GripVertical className="w-4 h-4" />
                          </div>
                        </td>
                        <td className="px-2 py-2.5 align-middle text-center">
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={() => toggleCheck(it.id)}
                            aria-label={`Select ${it.description}`}
                          />
                        </td>
                        <td className="px-3 py-2.5 align-middle font-medium max-w-[220px]">
                          <span className="flex items-center gap-1.5 truncate">
                            {it.labelColor && (
                              <span className="inline-block w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: it.labelColor }} />
                            )}
                            <span className="truncate">{it.description}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 align-middle text-right tabular-nums">
                          {it.quantity}
                        </td>
                        <td className="px-3 py-2.5 align-middle text-right tabular-nums">
                          {formatUnitPrice(it.unitPriceCents, currencySymbol)}
                        </td>
                        <td className="px-3 py-2.5 align-middle text-right tabular-nums text-muted-foreground whitespace-nowrap">
                          {it.taxRateName ? `${it.taxRateName} (${it.taxRatePercent}%)` : `${it.taxRatePercent}%`}
                        </td>
                        <td className="px-2 py-2.5 align-middle text-center">
                          <div className="flex items-center justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => handleStartEditItem(it)}
                              className="rounded p-0.5 hover:bg-muted"
                              aria-label={`Edit ${it.description}`}
                              title="Edit item"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteItem(it.id)}
                              className="rounded p-0.5 hover:bg-destructive/10"
                              aria-label="Remove item from library"
                              title="Delete from library"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )

                    if (!it.details) return [mainRow]

                    const detailRow = (
                      <tr key={`${it.id}-details`} className="border-b border-border">
                        <td className="bg-muted/40 px-2 py-1.5" />
                        <td className="bg-muted/40 px-2 py-1.5" />
                        <td colSpan={5} className="bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground italic leading-relaxed">
                          {it.details}
                        </td>
                      </tr>
                    )

                    return [mainRow, detailRow]
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 py-10 text-center text-sm text-muted-foreground">
              Your library is empty. Click Add item to library to create your first reusable item.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-6 py-4 flex items-center justify-between gap-3 shrink-0 bg-background">
          <p className="text-sm text-muted-foreground">
            {checkedIds.size > 0
              ? `${checkedIds.size} item${checkedIds.size === 1 ? '' : 's'} selected`
              : 'Tick items to import them.'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={checkedIds.size === 0}>
              Import{checkedIds.size > 0 ? ` (${checkedIds.size})` : ''}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
