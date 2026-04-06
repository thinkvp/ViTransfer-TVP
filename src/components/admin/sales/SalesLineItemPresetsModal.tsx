'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { TaxRateSelect } from '@/components/sales/TaxRateSelect'
import { dollarsToCents } from '@/lib/sales/money'
import {
  createSalesItem,
  deleteSalesItem,
  deleteSalesPreset,
  listSalesItems,
  listSalesPresets,
  saveSalesPreset,
} from '@/lib/sales/admin-api'
import type { SalesItem, SalesPreset } from '@/lib/sales/admin-api'
import type { SalesLineItem, SalesTaxRate } from '@/lib/sales/types'

// Types

type AddForm = {
  description: string
  details: string
  quantity: string
  unitPrice: string
  taxRatePercent: number
  taxRateName?: string
}

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
  // Library & presets
  const [items, setItems] = useState<SalesItem[]>([])
  const [presets, setPresets] = useState<SalesPreset[]>([])
  const [loading, setLoading] = useState(false)

  // Selection
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')

  // Add item form
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState<AddForm>({
    description: '',
    details: '',
    quantity: '1',
    unitPrice: '',
    taxRatePercent: defaultTaxRatePercent,
    taxRateName: taxRates.find((r) => r.isDefault)?.name,
  })
  const [addingItem, setAddingItem] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

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
    Promise.all([listSalesItems(), listSalesPresets()])
      .then(([itemList, presetList]) => {
        if (!cancelled) {
          setItems(itemList)
          setPresets(presetList)
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
      setShowAddForm(false)
      setShowSaveName(false)
      setSaveName('')
      setSaveError(null)
      setAddError(null)
    }
  }, [open])

  // Sync default tax rate to add form when taxRates load
  useEffect(() => {
    const def = taxRates.find((r) => r.isDefault)
    setAddForm((prev) => ({
      ...prev,
      taxRatePercent: defaultTaxRatePercent,
      taxRateName: def?.name,
    }))
  }, [taxRates, defaultTaxRatePercent])

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

  // Add item form helpers
  function resetAddForm() {
    const def = taxRates.find((r) => r.isDefault)
    setAddForm({
      description: '',
      details: '',
      quantity: '1',
      unitPrice: '',
      taxRatePercent: defaultTaxRatePercent,
      taxRateName: def?.name,
    })
    setAddError(null)
  }

  async function handleAddItem() {
    const description = addForm.description.trim()
    if (!description) return
    const qty = parseFloat(addForm.quantity)
    const quantity = Number.isFinite(qty) && qty >= 0 ? qty : 1
    const unitPriceCents = dollarsToCents(addForm.unitPrice)

    setAddingItem(true)
    setAddError(null)
    try {
      const created = await createSalesItem({
        description,
        details: addForm.details,
        quantity,
        unitPriceCents,
        taxRatePercent: addForm.taxRatePercent,
        taxRateName: addForm.taxRateName ?? null,
      })
      setItems((prev) => [...prev, created])
      setCheckedIds((prev) => {
        const next = new Set(prev)
        next.add(created.id)
        return next
      })
      resetAddForm()
      setShowAddForm(false)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to create item.')
    } finally {
      setAddingItem(false)
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
                setShowAddForm(false)
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
            {!showAddForm && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setShowAddForm(true); setShowSaveName(false) }}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add item to library
              </Button>
            )}

            {showAddForm && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Item name <span className="text-destructive">*</span></Label>
                    <Input
                      value={addForm.description}
                      onChange={(e) => setAddForm((prev) => ({ ...prev, description: e.target.value }))}
                      placeholder="e.g. Video Editing (Day Rate)"
                      className="h-9"
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleAddItem() }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Default Qty</Label>
                    <Input
                      type="number"
                      min={0}
                      value={addForm.quantity}
                      onChange={(e) => setAddForm((prev) => ({ ...prev, quantity: e.target.value }))}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit price ({currencySymbol})</Label>
                    <Input
                      value={addForm.unitPrice}
                      onChange={(e) => setAddForm((prev) => ({ ...prev, unitPrice: e.target.value }))}
                      placeholder="0.00"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tax</Label>
                    <TaxRateSelect
                      value={addForm.taxRatePercent}
                      onChange={(rate, name) => setAddForm((prev) => ({ ...prev, taxRatePercent: rate, taxRateName: name }))}
                      taxRates={taxRates}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Description (optional)</Label>
                    <Textarea
                      value={addForm.details}
                      onChange={(e) => setAddForm((prev) => ({ ...prev, details: e.target.value }))}
                      placeholder="Optional paragraph description..."
                      className="min-h-[70px] text-sm"
                    />
                  </div>
                </div>
                {addError && <p className="text-xs text-destructive">{addError}</p>}
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void handleAddItem()} disabled={addingItem || !addForm.description.trim()}>
                    {addingItem ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Add to library
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowAddForm(false); resetAddForm() }}>
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

                    const mainRow = (
                      <tr
                        key={it.id}
                        className={[
                          'transition-colors group',
                          it.details ? '' : 'border-b border-border',
                          isChecked ? 'bg-primary/5' : 'hover:bg-muted/30',
                        ].filter(Boolean).join(' ')}
                      >
                        <td className="px-2 py-2.5 align-middle text-center">
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={() => toggleCheck(it.id)}
                            aria-label={`Select ${it.description}`}
                          />
                        </td>
                        <td className="px-3 py-2.5 align-middle font-medium max-w-[220px] truncate">
                          {it.description}
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
                          <button
                            type="button"
                            onClick={() => void handleDeleteItem(it.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-destructive/10"
                            aria-label="Remove item from library"
                            title="Delete from library"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        </td>
                      </tr>
                    )

                    if (!it.details) return [mainRow]

                    const detailRow = (
                      <tr key={`${it.id}-details`} className="border-b border-border">
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
