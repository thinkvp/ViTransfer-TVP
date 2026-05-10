'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Car, Plus, Pencil, Trash2, ChevronDown, ChevronRight, BookOpen,
  CheckCircle2, Clock, Loader2, BarChart2, X, ArrowLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'
import { cn, formatDate } from '@/lib/utils'
import { ExportMenu, downloadCsv, generateReportPdf } from '@/components/admin/accounting/ExportMenu'
import type { Vehicle, VehicleLogbook, VehicleTrip, VehicleYearlyOdometer, VehicleTripType } from '@/lib/accounting/types'
import { TRIP_PURPOSE_PRESETS } from '@/lib/accounting/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtKm(km: number) {
  return `${km.toLocaleString('en-AU', { minimumFractionDigits: km % 1 === 0 ? 0 : 1, maximumFractionDigits: 1 })} km`
}

function fmtPct(pct: number) {
  return `${pct.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function todayYmd() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function currentFY() {
  const now = new Date()
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()
  return `FY${year}`
}

const LOGBOOK_WEEKS_REQUIRED = 12

// ── Drag Number Input ────────────────────────────────────────────────────────
// Supports typing AND touch/mouse drag-up=increase, drag-down=decrease

function DragNumberInput({
  value, onChange, min = 0, placeholder, className,
}: {
  value: string
  onChange: (v: string) => void
  min?: number
  placeholder?: string
  className?: string
}) {
  const dragRef = useRef<{ active: boolean; startY: number; startVal: number }>(
    { active: false, startY: 0, startVal: 0 }
  )

  function handlePointerDown(e: React.PointerEvent<HTMLInputElement>) {
    const num = parseInt(value, 10)
    dragRef.current = { active: true, startY: e.clientY, startVal: isNaN(num) ? 0 : num }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLInputElement>) {
    if (!dragRef.current.active) return
    const deltaY = dragRef.current.startY - e.clientY // up = positive = increase
    if (Math.abs(deltaY) < 4) return
    const newVal = Math.max(min, Math.round(dragRef.current.startVal + deltaY / 4))
    onChange(newVal.toString())
  }

  function handlePointerUp() {
    dragRef.current.active = false
  }

  return (
    <Input
      type="number"
      inputMode="numeric"
      style={{ touchAction: 'none' }}
      className={cn('cursor-ns-resize', className)}
      value={value}
      onChange={e => onChange(e.target.value)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      placeholder={placeholder}
      min={min}
    />
  )
}

// ── Vehicle Card ─────────────────────────────────────────────────────────────

function VehicleCard({
  vehicle,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}: {
  vehicle: Vehicle
  isSelected: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const lb = vehicle.activeLogbook
  return (
    <button
      onClick={onSelect}
      className={cn(
        'text-left rounded-lg border px-4 py-3 hover:bg-accent/40 transition-colors w-full',
        isSelected ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border bg-card'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Car className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="font-medium text-sm truncate">
            {vehicle.year ? `${vehicle.year} ` : ''}{vehicle.make} {vehicle.model}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <span
            role="button" tabIndex={0}
            onClick={e => { e.stopPropagation(); onEdit() }}
            onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onEdit() } }}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Edit vehicle"
          ><Pencil className="w-3.5 h-3.5" /></span>
          <span
            role="button" tabIndex={0}
            onClick={e => { e.stopPropagation(); onDelete() }}
            onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onDelete() } }}
            className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            aria-label="Delete vehicle"
          ><Trash2 className="w-3.5 h-3.5" /></span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-1 pl-6">{vehicle.registrationNumber}</p>
      {vehicle.colour && <p className="text-xs text-muted-foreground pl-6">{vehicle.colour}</p>}
      {lb ? (
        <div className="mt-2 pl-6 flex items-center gap-2 flex-wrap">
          <span className={cn(
            'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full',
            lb.businessUsePercent >= 50 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
          )}>
            <BarChart2 className="w-3 h-3" />
            {fmtPct(lb.businessUsePercent)} business
          </span>
          <span className="text-xs text-muted-foreground">{lb.tripCount} trips</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground mt-1 pl-6 italic">No logbook yet</p>
      )}
    </button>
  )
}

// ── Vehicle Form Modal ────────────────────────────────────────────────────────

interface VehicleFormState {
  make: string; model: string; year: string; engineCapacityCc: string
  registrationNumber: string; colour: string; notes: string; isActive: boolean
}

const EMPTY_VEHICLE_FORM: VehicleFormState = {
  make: '', model: '', year: '', engineCapacityCc: '',
  registrationNumber: '', colour: '', notes: '', isActive: true,
}

function VehicleFormModal({
  open, onClose, onSaved, existing,
}: {
  open: boolean
  onClose: () => void
  onSaved: (v: Vehicle) => void
  existing: Vehicle | null
}) {
  const [form, setForm] = useState<VehicleFormState>(EMPTY_VEHICLE_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setError('')
      setForm(existing ? {
        make: existing.make,
        model: existing.model,
        year: existing.year?.toString() ?? '',
        engineCapacityCc: existing.engineCapacityCc?.toString() ?? '',
        registrationNumber: existing.registrationNumber,
        colour: existing.colour ?? '',
        notes: existing.notes ?? '',
        isActive: existing.isActive,
      } : EMPTY_VEHICLE_FORM)
    }
  }, [open, existing])

  async function handleSave() {
    setError('')
    if (!form.make.trim() || !form.model.trim() || !form.registrationNumber.trim()) {
      setError('Make, model and registration number are required.')
      return
    }
    setSaving(true)
    try {
      const body = {
        make: form.make.trim(),
        model: form.model.trim(),
        year: form.year ? parseInt(form.year, 10) : null,
        engineCapacityCc: form.engineCapacityCc ? parseInt(form.engineCapacityCc, 10) : null,
        registrationNumber: form.registrationNumber.trim().toUpperCase(),
        colour: form.colour.trim() || null,
        notes: form.notes.trim() || null,
        isActive: form.isActive,
      }
      const url = existing ? `/api/admin/accounting/vehicles/${existing.id}` : '/api/admin/accounting/vehicles'
      const method = existing ? 'PUT' : 'POST'
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to save')
        return
      }
      const d = await res.json()
      onSaved(d.vehicle)
    } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Vehicle' : 'Add Vehicle'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Make *</Label>
              <Input value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} placeholder="e.g. Toyota" />
            </div>
            <div className="space-y-1">
              <Label>Model *</Label>
              <Input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="e.g. HiLux" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Year</Label>
              <Input type="number" inputMode="numeric" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} placeholder="e.g. 2022" min={1900} max={2100} />
            </div>
            <div className="space-y-1">
              <Label>Engine (cc)</Label>
              <Input type="number" inputMode="numeric" value={form.engineCapacityCc} onChange={e => setForm(f => ({ ...f, engineCapacityCc: e.target.value }))} placeholder="e.g. 2800" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Registration *</Label>
              <Input value={form.registrationNumber} onChange={e => setForm(f => ({ ...f, registrationNumber: e.target.value.toUpperCase() }))} placeholder="e.g. ABC123" className="uppercase" />
            </div>
            <div className="space-y-1">
              <Label>Colour</Label>
              <Input value={form.colour} onChange={e => setForm(f => ({ ...f, colour: e.target.value }))} placeholder="e.g. White" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" />
          </div>
          {existing && (
            <div className="flex items-center gap-2">
              <input type="checkbox" id="v-active" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} className="rounded" />
              <Label htmlFor="v-active">Active</Label>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !form.make.trim() || !form.model.trim() || !form.registrationNumber.trim()}>
            {saving ? 'Saving…' : existing ? 'Save Changes' : 'Add Vehicle'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── New Logbook Modal ─────────────────────────────────────────────────────────

function NewLogbookModal({
  open, onClose, onCreated, vehicleId, vehicle,
}: {
  open: boolean
  onClose: () => void
  onCreated: (lb: VehicleLogbook) => void
  vehicleId: string
  vehicle: Vehicle
}) {
  const [form, setForm] = useState({ label: '', startDate: todayYmd(), odometerStart: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      const fy = currentFY()
      setForm({ label: `Logbook ${fy}`, startDate: todayYmd(), odometerStart: '', notes: '' })
      setError('')
    }
  }, [open])

  async function handleCreate() {
    setError('')
    if (!form.label.trim() || !form.startDate || !form.odometerStart) {
      setError('Label, start date and odometer start are required.')
      return
    }
    setSaving(true)
    try {
      const body = {
        label: form.label.trim(),
        startDate: form.startDate,
        odometerStart: parseInt(form.odometerStart, 10),
        notes: form.notes.trim() || null,
      }
      const res = await apiFetch(`/api/admin/accounting/vehicles/${vehicleId}/logbooks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to create logbook')
        return
      }
      const d = await res.json()
      onCreated(d.logbook)
    } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start New Logbook — {vehicle.make} {vehicle.model}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label>Logbook Label *</Label>
            <Input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Logbook FY2026" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Start Date *</Label>
              <Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Opening Odometer (km) *</Label>
              <Input type="number" inputMode="numeric" value={form.odometerStart} onChange={e => setForm(f => ({ ...f, odometerStart: e.target.value }))} placeholder="e.g. 45230" min={0} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving || !form.label.trim() || !form.startDate || !form.odometerStart}>
            {saving ? 'Creating…' : 'Start Logbook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Add / Edit Trip Modal ─────────────────────────────────────────────────────

interface TripFormState {
  date: string
  tripType: VehicleTripType
  purpose: string
  customPurpose: string
  useOdometer: boolean
  odometerStart: string
  odometerEnd: string
  distanceKm: string
  notes: string
}

const EMPTY_TRIP: TripFormState = {
  date: todayYmd(),
  tripType: 'BUSINESS',
  purpose: TRIP_PURPOSE_PRESETS[0],
  customPurpose: '',
  useOdometer: true,
  odometerStart: '',
  odometerEnd: '',
  distanceKm: '',
  notes: '',
}

function TripModal({
  open, onClose, onSaved, logbookId, vehicleId, existing, lastOdometerEnd,
}: {
  open: boolean
  onClose: () => void
  onSaved: (trip: VehicleTrip, isNew: boolean) => void
  logbookId: string
  vehicleId: string
  existing: VehicleTrip | null
  lastOdometerEnd?: number | null
}) {
  const [form, setForm] = useState<TripFormState>(EMPTY_TRIP)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setError('')
      if (existing) {
        const isPreset = TRIP_PURPOSE_PRESETS.includes(existing.purpose as typeof TRIP_PURPOSE_PRESETS[number])
        setForm({
          date: existing.date,
          tripType: existing.tripType,
          purpose: isPreset ? existing.purpose : 'Other',
          customPurpose: isPreset ? '' : existing.purpose,
          useOdometer: existing.odometerStart != null,
          odometerStart: existing.odometerStart?.toString() ?? '',
          odometerEnd: existing.odometerEnd?.toString() ?? '',
          distanceKm: existing.odometerStart == null ? existing.distanceKm.toString() : '',
          notes: existing.notes ?? '',
        })
      } else {
        const lastOdo = lastOdometerEnd?.toString() ?? ''
        setForm({ ...EMPTY_TRIP, date: todayYmd(), odometerStart: lastOdo, odometerEnd: lastOdo })
      }
    }
  }, [open, existing, lastOdometerEnd])

  const effectivePurpose = form.purpose === 'Other' ? form.customPurpose.trim() : form.purpose

  function computedDistance() {
    if (form.useOdometer && form.odometerStart && form.odometerEnd) {
      const d = parseInt(form.odometerEnd, 10) - parseInt(form.odometerStart, 10)
      return d > 0 ? d : null
    }
    if (!form.useOdometer && form.distanceKm) {
      const d = parseInt(form.distanceKm, 10)
      return d > 0 ? d : null
    }
    return null
  }

  function isValid() {
    if (!form.date) return false
    if (!effectivePurpose) return false
    if (form.tripType === 'BUSINESS' && !effectivePurpose) return false
    const dist = computedDistance()
    return dist !== null && dist > 0
  }

  async function handleSave() {
    setError('')
    const dist = computedDistance()
    if (!dist || dist <= 0) { setError('Enter a valid distance or odometer readings.'); return }
    if (!effectivePurpose) { setError('Please enter a purpose for this trip.'); return }
    setSaving(true)
    try {
      const body = {
        date: form.date,
        tripType: form.tripType,
        purpose: effectivePurpose,
        odometerStart: form.useOdometer && form.odometerStart ? parseInt(form.odometerStart, 10) : null,
        odometerEnd: form.useOdometer && form.odometerEnd ? parseInt(form.odometerEnd, 10) : null,
        distanceKm: form.useOdometer ? null : parseInt(form.distanceKm, 10),
        notes: form.notes.trim() || null,
      }
      let res: Response
      if (existing) {
        res = await apiFetch(
          `/api/admin/accounting/vehicles/${vehicleId}/logbooks/${logbookId}/trips/${existing.id}`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        )
      } else {
        res = await apiFetch(
          `/api/admin/accounting/vehicles/${vehicleId}/logbooks/${logbookId}/trips`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        )
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to save trip')
        return
      }
      const d = await res.json()
      onSaved(d.trip, !existing)
    } finally { setSaving(false) }
  }

  const dist = computedDistance()

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-md w-full">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Trip' : 'Add Trip'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Date */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Date</Label>
            <Input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="h-12 text-base" />
          </div>

          {/* Business / Private toggle */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Trip Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['BUSINESS', 'PRIVATE'] as VehicleTripType[]).map(t => (
                <button key={t} type="button"
                  onClick={() => setForm(f => ({ ...f, tripType: t, purpose: t === 'PRIVATE' ? 'Private' : TRIP_PURPOSE_PRESETS[0], customPurpose: '' }))}
                  className={cn(
                    'h-12 rounded-lg border-2 font-medium text-sm transition-colors',
                    form.tripType === t
                      ? t === 'BUSINESS' ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-600' : 'border-slate-400 bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      : 'border-border bg-background text-muted-foreground hover:bg-accent/50'
                  )}
                >{t === 'BUSINESS' ? 'Business' : 'Private'}</button>
              ))}
            </div>
          </div>

          {/* Purpose — only shown for business trips */}
          {form.tripType === 'BUSINESS' && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Purpose</Label>
              <div className="flex flex-wrap gap-2">
                {([...TRIP_PURPOSE_PRESETS, 'Other'] as string[]).map(p => (
                  <button key={p} type="button"
                    onClick={() => setForm(f => ({ ...f, purpose: p }))}
                    className={cn(
                      'px-3 py-1.5 rounded-full border text-sm font-medium transition-colors',
                      form.purpose === p ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent/60'
                    )}
                  >{p}</button>
                ))}
              </div>
              {form.purpose === 'Other' && (
                <Input
                  className="h-10 mt-1"
                  placeholder="Describe the business purpose…"
                  value={form.customPurpose}
                  onChange={e => setForm(f => ({ ...f, customPurpose: e.target.value }))}
                  autoFocus
                />
              )}
            </div>
          )}

          {/* Distance entry mode */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Distance</Label>
              <div className="flex rounded-md border overflow-hidden">
                {([{ v: true, label: 'Odometer' }, { v: false, label: 'km only' }] as const).map(({ v, label }) => (
                  <button key={label} type="button"
                    onClick={() => setForm(f => ({ ...f, useOdometer: v }))}
                    className={cn(
                      'px-3 py-1 text-xs font-medium transition-colors',
                      form.useOdometer === v ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent'
                    )}
                  >{label}</button>
                ))}
              </div>
            </div>
            {form.useOdometer ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Start (km)</Label>
                  <DragNumberInput
                    className="h-12 text-base"
                    placeholder="e.g. 45230"
                    value={form.odometerStart}
                    onChange={v => setForm(f => ({ ...f, odometerStart: v }))}
                    min={0}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">End (km)</Label>
                  <DragNumberInput
                    className="h-12 text-base"
                    placeholder="e.g. 45298"
                    value={form.odometerEnd}
                    onChange={v => setForm(f => ({ ...f, odometerEnd: v }))}
                    min={0}
                  />
                </div>
              </div>
            ) : (
              <Input
                type="number" inputMode="numeric" step="1"
                className="h-12 text-base"
                placeholder="Distance in km (e.g. 68)"
                value={form.distanceKm}
                onChange={e => setForm(f => ({ ...f, distanceKm: e.target.value }))}
                min={1}
              />
            )}
            {dist !== null && dist > 0 && (
              <p className="text-xs text-muted-foreground">Distance: {fmtKm(dist)}</p>
            )}
          </div>

          {/* Notes — optional */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-muted-foreground">Notes (optional)</Label>
            <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional details…" />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !isValid()} className="flex-1 sm:flex-none h-11">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {existing ? 'Save Changes' : 'Add Trip'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Logbook Summary Card ──────────────────────────────────────────────────────

function LogbookSummary({
  logbook, onFinalisе, onClose, onDelete,
}: {
  logbook: VehicleLogbook
  onFinalisе: () => void
  onClose: () => void
  onDelete: () => void
}) {
  const weeksElapsed = logbook.daysElapsed / 7
  const pct12Weeks = Math.min(100, (weeksElapsed / LOGBOOK_WEEKS_REQUIRED) * 100)
  const isComplete = logbook.daysElapsed >= LOGBOOK_WEEKS_REQUIRED * 7
  const isClosed = logbook.status === 'CLOSED'

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-sm">{logbook.label}</p>
          <p className="text-xs text-muted-foreground">
            Started {formatDate(logbook.startDate)}
            {logbook.endDate ? ` · Closed ${formatDate(logbook.endDate)}` : ''}
          </p>
        </div>
        {isClosed ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <CheckCircle2 className="w-3 h-3" /> Closed
          </span>
        ) : (
          <span className={cn(
            'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full',
            isComplete ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
          )}>
            {isComplete ? <CheckCircle2 className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
            {isComplete ? '12 weeks ✓' : `${Math.floor(weeksElapsed)} / ${LOGBOOK_WEEKS_REQUIRED} wks`}
          </span>
        )}
      </div>

      {/* 12-week progress bar */}
      {!isClosed && (
        <div>
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>ATO 12-week requirement</span>
            <span>{logbook.daysElapsed} days</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', isComplete ? 'bg-emerald-500' : 'bg-amber-400')}
              style={{ width: `${pct12Weeks}%` }}
            />
          </div>
        </div>
      )}

      {/* Business use stats */}
      <div className="grid grid-cols-3 gap-2 pt-1">
        <div className="rounded-md bg-muted/40 px-2 py-2 text-center">
          <p className="text-lg font-bold leading-tight">{fmtPct(logbook.businessUsePercent)}</p>
          <p className="text-xs text-muted-foreground">Business usage</p>
        </div>
        <div className="rounded-md bg-muted/40 px-2 py-2 text-center">
          <p className="text-lg font-bold leading-tight">{fmtKm(logbook.businessKm)}</p>
          <p className="text-xs text-muted-foreground">Business km</p>
        </div>
        <div className="rounded-md bg-muted/40 px-2 py-2 text-center">
          <p className="text-lg font-bold leading-tight">{fmtKm(logbook.totalKm)}</p>
          <p className="text-xs text-muted-foreground">Total km</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {!isClosed && isComplete && (
          <Button size="sm" variant="outline" onClick={onFinalisе}>
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />Finalise Logbook
          </Button>
        )}
        {!isClosed && (
          <Button size="sm" variant="ghost" onClick={onClose} className="text-muted-foreground">
            <X className="w-3.5 h-3.5 mr-1.5" />Close Logbook
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDelete} className="text-muted-foreground hover:text-destructive ml-auto">
          <Trash2 className="w-3.5 h-3.5 mr-1.5" />Delete Logbook
        </Button>
      </div>

      {logbook.businessUsePercentOverride !== null && (
        <p className="text-xs text-muted-foreground italic">
          * Business use % is manually overridden to {fmtPct(logbook.businessUsePercentOverride)}
        </p>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function VehiclesPage() {
  const searchParams = useSearchParams()
  const addTripDeepLink = searchParams?.get('addTrip') === '1'
  const deepLinkHandled = useRef(false)

  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)

  // Logbook state
  const [selectedLogbookId, setSelectedLogbookId] = useState<string | null>(null)
  const [logbooks, setLogbooks] = useState<VehicleLogbook[]>([])
  const [loadingLogbooks, setLoadingLogbooks] = useState(false)

  // Trips
  const [trips, setTrips] = useState<VehicleTrip[]>([])
  const [tripsTotal, setTripsTotal] = useState(0)
  const [tripsPage, setTripsPage] = useState(1)
  const [loadingTrips, setLoadingTrips] = useState(false)
  const TRIPS_PAGE_SIZE = 50

  // Yearly odometers
  const [yearlyOdometers, setYearlyOdometers] = useState<VehicleYearlyOdometer[]>([])
  const [showOdometers, setShowOdometers] = useState(false)

  // Modals
  const [vehicleModalOpen, setVehicleModalOpen] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  const [newLogbookOpen, setNewLogbookOpen] = useState(false)
  const [tripModalOpen, setTripModalOpen] = useState(false)
  const [editingTrip, setEditingTrip] = useState<VehicleTrip | null>(null)
  const [exportLoading, setExportLoading] = useState(false)

  const selectedVehicle = vehicles.find(v => v.id === selectedVehicleId) ?? null
  const selectedLogbook = logbooks.find(l => l.id === selectedLogbookId) ?? null

  // Load vehicles — auto-select first on initial load
  const loadVehicles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/accounting/vehicles')
      if (res.ok) {
        const d = await res.json()
        const vList: Vehicle[] = d.vehicles ?? []
        setVehicles(vList)
        // Auto-select first vehicle on initial load (like Bank Accounts)
        setSelectedVehicleId(prev => prev ?? vList[0]?.id ?? null)
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadVehicles() }, [loadVehicles])

  // Load logbooks when vehicle selected
  const loadLogbooks = useCallback(async (vehicleId: string) => {
    setLoadingLogbooks(true)
    setLogbooks([])
    setSelectedLogbookId(null)
    try {
      const res = await apiFetch(`/api/admin/accounting/vehicles/${vehicleId}/logbooks`)
      if (res.ok) {
        const d = await res.json()
        const lbs: VehicleLogbook[] = d.logbooks ?? []
        setLogbooks(lbs)
        // Auto-select the active logbook (or most recent)
        const active = lbs.find(l => l.status === 'ACTIVE') ?? lbs[0] ?? null
        setSelectedLogbookId(active?.id ?? null)
      }
    } finally { setLoadingLogbooks(false) }
  }, [])

  useEffect(() => {
    if (selectedVehicleId) void loadLogbooks(selectedVehicleId)
  }, [selectedVehicleId, loadLogbooks])

  // Load trips when logbook selected
  const loadTrips = useCallback(async (vehicleId: string, logbookId: string, page = 1) => {
    setLoadingTrips(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/vehicles/${vehicleId}/logbooks/${logbookId}/trips?page=${page}&pageSize=${TRIPS_PAGE_SIZE}`)
      if (res.ok) {
        const d = await res.json()
        setTrips(d.trips ?? [])
        setTripsTotal(d.total ?? 0)
        setTripsPage(page)
      }
    } finally { setLoadingTrips(false) }
  }, [])

  useEffect(() => {
    if (selectedVehicleId && selectedLogbookId) {
      void loadTrips(selectedVehicleId, selectedLogbookId, 1)
    } else {
      setTrips([])
      setTripsTotal(0)
    }
  }, [selectedVehicleId, selectedLogbookId, loadTrips])

  // Load yearly odometers when vehicle selected
  const loadYearlyOdometers = useCallback(async (vehicleId: string) => {
    const res = await apiFetch(`/api/admin/accounting/vehicles/${vehicleId}/odometer`)
    if (res.ok) {
      const d = await res.json()
      setYearlyOdometers(d.yearlyOdometers ?? [])
    }
  }, [])

  useEffect(() => {
    if (selectedVehicleId) void loadYearlyOdometers(selectedVehicleId)
  }, [selectedVehicleId, loadYearlyOdometers])

  // Deep-link: ?addTrip=1 — open Add Trip modal once vehicle + active logbook are ready
  useEffect(() => {
    if (!addTripDeepLink || deepLinkHandled.current) return
    if (!selectedLogbookId) return
    const logbook = logbooks.find(l => l.id === selectedLogbookId)
    if (!logbook || logbook.status !== 'ACTIVE') return
    deepLinkHandled.current = true
    setEditingTrip(null)
    setTripModalOpen(true)
  }, [addTripDeepLink, selectedLogbookId, logbooks])

  function handleSelectVehicle(v: Vehicle) {
    setSelectedVehicleId(prev => prev === v.id ? null : v.id)
    setTrips([])
    setYearlyOdometers([])
  }

  async function handleDeleteVehicle(v: Vehicle) {
    if (!confirm(`Delete vehicle "${v.year ? v.year + ' ' : ''}${v.make} ${v.model}" and all logbook data? This cannot be undone.`)) return
    const res = await apiFetch(`/api/admin/accounting/vehicles/${v.id}`, { method: 'DELETE' })
    if (res.ok) {
      setVehicles(prev => prev.filter(x => x.id !== v.id))
      if (selectedVehicleId === v.id) {
        setSelectedVehicleId(null)
        setLogbooks([])
        setTrips([])
      }
    }
  }

  async function handleFinaliseLogbook(logbook: VehicleLogbook) {
    if (!confirm(`Finalise logbook "${logbook.label}"? This will close it and lock the business-use percentage.`)) return
    if (!selectedVehicleId) return
    const today = todayYmd()
    const res = await apiFetch(`/api/admin/accounting/vehicles/${selectedVehicleId}/logbooks/${logbook.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CLOSED', endDate: today }),
    })
    if (res.ok) {
      const d = await res.json()
      setLogbooks(prev => prev.map(l => l.id === logbook.id ? d.logbook : l))
      // Refresh the vehicle list so the card updates
      void loadVehicles()
    }
  }

  async function handleDeleteLogbook(logbook: VehicleLogbook) {
    if (!confirm(`Delete logbook "${logbook.label}" and ALL its trips? This cannot be undone.`)) return
    if (!selectedVehicleId) return
    const res = await apiFetch(`/api/admin/accounting/vehicles/${selectedVehicleId}/logbooks/${logbook.id}`, { method: 'DELETE' })
    if (res.ok) {
      const remaining = logbooks.filter(l => l.id !== logbook.id)
      setLogbooks(remaining)
      if (selectedLogbookId === logbook.id) {
        const next = remaining.find(l => l.status === 'ACTIVE') ?? remaining[0] ?? null
        setSelectedLogbookId(next?.id ?? null)
      }
      void loadVehicles()
    }
  }

  async function handleCloseLogbook(logbook: VehicleLogbook) {
    if (!confirm(`Close logbook "${logbook.label}"? The logbook period is shorter than 12 weeks.`)) return
    if (!selectedVehicleId) return
    const res = await apiFetch(`/api/admin/accounting/vehicles/${selectedVehicleId}/logbooks/${logbook.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CLOSED', endDate: todayYmd() }),
    })
    if (res.ok) {
      const d = await res.json()
      setLogbooks(prev => prev.map(l => l.id === logbook.id ? d.logbook : l))
    }
  }

  async function handleDeleteTrip(trip: VehicleTrip) {
    if (!confirm('Delete this trip?')) return
    if (!selectedVehicleId || !selectedLogbookId) return
    const res = await apiFetch(
      `/api/admin/accounting/vehicles/${selectedVehicleId}/logbooks/${selectedLogbookId}/trips/${trip.id}`,
      { method: 'DELETE' }
    )
    if (res.ok) {
      setTrips(prev => prev.filter(t => t.id !== trip.id))
      setTripsTotal(prev => Math.max(0, prev - 1))
      // Refresh logbook stats
      void loadLogbooks(selectedVehicleId)
    }
  }

  // Export all trips for the selected logbook as CSV
  async function handleExportCsv() {
    if (!selectedVehicleId || !selectedLogbookId || !selectedLogbook) return
    setExportLoading(true)
    try {
      // Fetch all trips (no pagination)
      const res = await apiFetch(`/api/admin/accounting/vehicles/${selectedVehicleId}/logbooks/${selectedLogbookId}/trips?page=1&pageSize=10000`)
      if (!res.ok) return
      const d = await res.json()
      const allTrips: VehicleTrip[] = d.trips ?? []
      downloadCsv(
        `${selectedVehicle?.registrationNumber ?? 'vehicle'}-logbook.csv`,
        ['Date', 'Type', 'Purpose', 'Odo Start (km)', 'Odo End (km)', 'Distance (km)', 'Notes'],
        allTrips.map(t => [
          t.date,
          t.tripType,
          t.purpose,
          t.odometerStart?.toString() ?? '',
          t.odometerEnd?.toString() ?? '',
          t.distanceKm.toFixed(1),
          t.notes ?? '',
        ])
      )
    } finally { setExportLoading(false) }
  }

  // Export logbook as PDF
  async function handleExportPdf() {
    if (!selectedVehicleId || !selectedLogbookId || !selectedLogbook || !selectedVehicle) return
    setExportLoading(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/vehicles/${selectedVehicleId}/logbooks/${selectedLogbookId}/trips?page=1&pageSize=10000`)
      if (!res.ok) return
      const d = await res.json()
      const allTrips: VehicleTrip[] = d.trips ?? []
      generateReportPdf({
        title: `Vehicle Logbook — ${selectedVehicle.year ? selectedVehicle.year + ' ' : ''}${selectedVehicle.make} ${selectedVehicle.model}`,
        subtitle: `${selectedVehicle.registrationNumber}${selectedVehicle.engineCapacityCc ? ' · ' + selectedVehicle.engineCapacityCc + 'cc' : ''} | ${selectedLogbook.label} | Business use: ${fmtPct(selectedLogbook.businessUsePercent)}`,
        sections: [
          {
            columns: [
              { header: 'Date', nowrap: true },
              { header: 'Type', nowrap: true },
              { header: 'Purpose' },
              { header: 'Odo Start', align: 'right' as const, nowrap: true },
              { header: 'Odo End', align: 'right' as const, nowrap: true },
              { header: 'Distance (km)', align: 'right' as const, nowrap: true },
              { header: 'Notes' },
            ],
            rows: [
              ...allTrips.map(t => ({
                cells: [
                  t.date,
                  t.tripType,
                  t.purpose,
                  t.odometerStart != null ? t.odometerStart.toLocaleString() : '—',
                  t.odometerEnd != null ? t.odometerEnd.toLocaleString() : '—',
                  t.distanceKm.toFixed(1),
                  t.notes ?? '',
                ],
              })),
              {
                cells: [
                  '', '', 'TOTALS',
                  '', '',
                  fmtKm(selectedLogbook.totalKm),
                  `Business: ${fmtKm(selectedLogbook.businessKm)} (${fmtPct(selectedLogbook.businessUsePercent)})`,
                ],
                bold: true,
                separator: true,
              },
            ],
          },
        ],
      })
    } finally { setExportLoading(false) }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Vehicle Cards */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold">Vehicles</h2>
            <p className="text-sm text-muted-foreground">Select a vehicle to manage its ATO logbook.</p>
          </div>
          <div className="flex w-full justify-end sm:w-auto">
            <Button size="sm" onClick={() => { setEditingVehicle(null); setVehicleModalOpen(true) }}>
              <Plus className="w-4 h-4 mr-1.5" />Add Vehicle
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />Loading…
          </div>
        ) : vehicles.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">No vehicles yet. Add one to get started.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {vehicles.map(v => (
              <VehicleCard
                key={v.id}
                vehicle={v}
                isSelected={selectedVehicleId === v.id}
                onSelect={() => handleSelectVehicle(v)}
                onEdit={() => { setEditingVehicle(v); setVehicleModalOpen(true) }}
                onDelete={() => handleDeleteVehicle(v)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Logbook Panel */}
      {selectedVehicle && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-xl font-semibold">
              {selectedVehicle.year ? `${selectedVehicle.year} ` : ''}{selectedVehicle.make} {selectedVehicle.model}
              <span className="text-muted-foreground font-normal text-base ml-2">{selectedVehicle.registrationNumber}</span>
            </h2>
            <div className="flex w-full justify-end gap-2 sm:w-auto">
              <ExportMenu
                onExportCsv={handleExportCsv}
                onExportPdf={handleExportPdf}
                disabled={!selectedLogbook || trips.length === 0 || exportLoading}
              />
              <Button size="sm" onClick={() => setNewLogbookOpen(true)}>
                <BookOpen className="w-4 h-4 mr-1.5" />Start New Logbook
              </Button>
            </div>
          </div>

          {loadingLogbooks ? (
            <div className="py-6 text-center text-muted-foreground text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading logbooks…</div>
          ) : logbooks.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">No logbooks yet. Start one to begin recording trips.</CardContent></Card>
          ) : (
            <div className="space-y-3">
              {/* Logbook selector — tabs when multiple */}
              {logbooks.length > 1 && (
                <div className="flex gap-0 border-b border-border">
                  {logbooks.map(lb => (
                    <button key={lb.id} onClick={() => setSelectedLogbookId(lb.id)}
                      className={cn(
                        'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap',
                        selectedLogbookId === lb.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {lb.label}
                      {lb.status === 'CLOSED' && <span className="ml-1.5 text-xs text-muted-foreground">(closed)</span>}
                    </button>
                  ))}
                </div>
              )}

              {selectedLogbook && (
                <>
                  <LogbookSummary
                    logbook={selectedLogbook}
                    onFinalisе={() => handleFinaliseLogbook(selectedLogbook)}
                    onClose={() => handleCloseLogbook(selectedLogbook)}
                    onDelete={() => handleDeleteLogbook(selectedLogbook)}
                  />

                  {/* Trip Entry */}
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-base">Trips <span className="text-muted-foreground font-normal text-sm">({tripsTotal})</span></h3>
                    {selectedLogbook.status === 'ACTIVE' && (
                      <Button
                        size="sm"
                        onClick={() => { setEditingTrip(null); setTripModalOpen(true) }}
                        className="h-10 px-4"
                      >
                        <Plus className="w-4 h-4 mr-1.5" />Add Trip
                      </Button>
                    )}
                  </div>

                  {/* Trip List */}
                  {loadingTrips ? (
                    <div className="py-6 text-center text-muted-foreground text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading trips…</div>
                  ) : trips.length === 0 ? (
                    <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">
                      {selectedLogbook.status === 'ACTIVE' ? 'No trips yet. Tap "Add Trip" to record your first journey.' : 'No trips recorded in this logbook.'}
                    </CardContent></Card>
                  ) : (
                    <Card>
                      <CardContent className="p-0">
                        {/* Desktop header */}
                        <div className="hidden sm:grid grid-cols-[90px_90px_1fr_80px_80px_80px_80px] gap-2 px-3 py-2 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
                          <span>Date</span>
                          <span>Type</span>
                          <span>Purpose</span>
                          <span className="text-right">Odo Start</span>
                          <span className="text-right">Odo End</span>
                          <span className="text-right">Distance</span>
                          <span className="text-right">Actions</span>
                        </div>
                        <div className="divide-y divide-border">
                          {trips.map(trip => (
                            <div key={trip.id} className="px-3 py-2.5">
                              {/* Mobile layout */}
                              <div className="sm:hidden space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <span className={cn(
                                      'inline-block text-xs font-medium px-1.5 py-0.5 rounded mr-2',
                                      trip.tripType === 'BUSINESS' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                    )}>{trip.tripType === 'BUSINESS' ? 'Biz' : 'Priv'}</span>
                                    <span className="text-sm">{trip.purpose}</span>
                                  </div>
                                  <div className="flex items-center gap-0.5 shrink-0">
                                    {selectedLogbook.status === 'ACTIVE' && (
                                      <button onClick={() => { setEditingTrip(trip); setTripModalOpen(true) }} className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                                    )}
                                    <button onClick={() => handleDeleteTrip(trip)} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground pl-0.5">
                                  <span>{formatDate(trip.date)}</span>
                                  <span className="font-medium text-foreground">{fmtKm(trip.distanceKm)}</span>
                                  {trip.odometerStart != null && <span>{trip.odometerStart.toLocaleString()} → {trip.odometerEnd?.toLocaleString() ?? '?'}</span>}
                                </div>
                                {trip.notes && <p className="text-xs text-muted-foreground italic pl-0.5">{trip.notes}</p>}
                              </div>
                              {/* Desktop layout */}
                              <div className="hidden sm:grid grid-cols-[90px_90px_1fr_80px_80px_80px_80px] gap-2 items-center text-sm">
                                <span className="whitespace-nowrap text-muted-foreground">{formatDate(trip.date)}</span>
                                <span>
                                  <span className={cn(
                                    'inline-block text-xs font-medium px-1.5 py-0.5 rounded',
                                    trip.tripType === 'BUSINESS' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                  )}>{trip.tripType === 'BUSINESS' ? 'Business' : 'Private'}</span>
                                </span>
                                <span className="truncate">{trip.purpose}{trip.notes ? <span className="text-muted-foreground ml-1 text-xs">· {trip.notes}</span> : ''}</span>
                                <span className="text-right text-muted-foreground text-xs">{trip.odometerStart?.toLocaleString() ?? '—'}</span>
                                <span className="text-right text-muted-foreground text-xs">{trip.odometerEnd?.toLocaleString() ?? '—'}</span>
                                <span className="text-right font-medium">{fmtKm(trip.distanceKm)}</span>
                                <div className="flex items-center justify-end gap-0.5">
                                  {selectedLogbook.status === 'ACTIVE' && (
                                    <button onClick={() => { setEditingTrip(trip); setTripModalOpen(true) }} className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" aria-label="Edit trip"><Pencil className="w-3.5 h-3.5" /></button>
                                  )}
                                  <button onClick={() => handleDeleteTrip(trip)} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" aria-label="Delete trip"><Trash2 className="w-3.5 h-3.5" /></button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                        {/* Pagination */}
                        {tripsTotal > TRIPS_PAGE_SIZE && (
                          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border text-sm text-muted-foreground">
                            <span>{((tripsPage - 1) * TRIPS_PAGE_SIZE) + 1}–{Math.min(tripsPage * TRIPS_PAGE_SIZE, tripsTotal)} of {tripsTotal}</span>
                            <div className="flex gap-1">
                              <Button size="sm" variant="outline" disabled={tripsPage <= 1} onClick={() => { if (selectedVehicleId && selectedLogbookId) void loadTrips(selectedVehicleId, selectedLogbookId, tripsPage - 1) }}>Prev</Button>
                              <Button size="sm" variant="outline" disabled={tripsPage * TRIPS_PAGE_SIZE >= tripsTotal} onClick={() => { if (selectedVehicleId && selectedLogbookId) void loadTrips(selectedVehicleId, selectedLogbookId, tripsPage + 1) }}>Next</Button>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </>
              )}
            </div>
          )}

          {/* Annual Odometer Readings */}
          <div className="space-y-2">
            <button
              onClick={() => setShowOdometers(v => !v)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {showOdometers ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              Annual Odometer Readings
              <span className="text-xs font-normal">(required by ATO for each year logbook is relied on)</span>
            </button>
            {showOdometers && (
              <AnnualOdometerSection
                vehicleId={selectedVehicle.id}
                records={yearlyOdometers}
                onSaved={r => {
                  setYearlyOdometers(prev => {
                    const idx = prev.findIndex(x => x.id === r.id)
                    return idx >= 0 ? prev.map(x => x.id === r.id ? r : x) : [r, ...prev]
                  })
                }}
                onDeleted={id => setYearlyOdometers(prev => prev.filter(x => x.id !== id))}
              />
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      <VehicleFormModal
        open={vehicleModalOpen}
        onClose={() => setVehicleModalOpen(false)}
        existing={editingVehicle}
        onSaved={v => {
          setVehicles(prev => {
            const idx = prev.findIndex(x => x.id === v.id)
            return idx >= 0 ? prev.map(x => x.id === v.id ? v : x) : [...prev, v]
          })
          setVehicleModalOpen(false)
        }}
      />

      {selectedVehicle && (
        <NewLogbookModal
          open={newLogbookOpen}
          onClose={() => setNewLogbookOpen(false)}
          vehicleId={selectedVehicle.id}
          vehicle={selectedVehicle}
          onCreated={lb => {
            setLogbooks(prev => [lb, ...prev])
            setSelectedLogbookId(lb.id)
            setNewLogbookOpen(false)
            void loadVehicles()
          }}
        />
      )}

      {selectedVehicle && selectedLogbook && (
        <TripModal
          open={tripModalOpen}
          onClose={() => { setTripModalOpen(false); setEditingTrip(null) }}
          logbookId={selectedLogbook.id}
          vehicleId={selectedVehicle.id}
          existing={editingTrip}
          lastOdometerEnd={editingTrip == null ? (trips[0]?.odometerEnd ?? null) : null}
          onSaved={(trip, isNew) => {
            if (isNew) {
              setTrips(prev => [trip, ...prev])
              setTripsTotal(prev => prev + 1)
            } else {
              setTrips(prev => prev.map(t => t.id === trip.id ? trip : t))
            }
            setTripModalOpen(false)
            setEditingTrip(null)
            // Reload logbook to refresh computed stats
            if (selectedVehicleId) void loadLogbooks(selectedVehicleId)
          }}
        />
      )}
    </div>
  )
}

// ── Annual Odometer Section ───────────────────────────────────────────────────

function AnnualOdometerSection({
  vehicleId,
  records,
  onSaved,
  onDeleted,
}: {
  vehicleId: string
  records: VehicleYearlyOdometer[]
  onSaved: (r: VehicleYearlyOdometer) => void
  onDeleted: (id: string) => void
}) {
  const [editingFY, setEditingFY] = useState<string | null>(null)
  const [form, setForm] = useState({ financialYear: currentFY(), odometerStart: '', odometerEnd: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState('')

  function startEdit(r?: VehicleYearlyOdometer) {
    if (r) {
      setForm({ financialYear: r.financialYear, odometerStart: r.odometerStart.toString(), odometerEnd: r.odometerEnd?.toString() ?? '', notes: r.notes ?? '' })
    } else {
      setForm({ financialYear: currentFY(), odometerStart: '', odometerEnd: '', notes: '' })
    }
    setEditingFY(r ? r.financialYear : '__new__')
    setError('')
  }

  async function handleSave() {
    setError('')
    if (!form.financialYear || !form.odometerStart) { setError('Financial year and start odometer are required.'); return }
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/vehicles/${vehicleId}/odometer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          financialYear: form.financialYear,
          odometerStart: parseInt(form.odometerStart, 10),
          odometerEnd: form.odometerEnd ? parseInt(form.odometerEnd, 10) : null,
          notes: form.notes.trim() || null,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to save')
        return
      }
      const d = await res.json()
      onSaved(d.yearlyOdometer)
      setEditingFY(null)
    } finally { setSaving(false) }
  }

  async function handleDelete(r: VehicleYearlyOdometer) {
    if (!confirm(`Delete odometer record for ${r.financialYear}?`)) return
    setDeleting(r.id)
    try {
      const res = await apiFetch(`/api/admin/accounting/vehicles/${vehicleId}/odometer/${r.id}`, { method: 'DELETE' })
      if (res.ok) onDeleted(r.id)
    } finally { setDeleting(null) }
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        {records.length === 0 && editingFY === null && (
          <p className="text-sm text-muted-foreground">No annual odometer readings recorded yet.</p>
        )}
        {records.map(r => (
          <div key={r.id}>
            {editingFY === r.financialYear ? (
              <OdometerForm form={form} setForm={setForm} onSave={handleSave} onCancel={() => setEditingFY(null)} saving={saving} error={error} />
            ) : (
              <div className="flex items-center justify-between gap-2 text-sm">
                <div>
                  <span className="font-medium">{r.financialYear}</span>
                  <span className="text-muted-foreground ml-3">Start: {r.odometerStart.toLocaleString()} km</span>
                  {r.odometerEnd != null && <span className="text-muted-foreground ml-3">End: {r.odometerEnd.toLocaleString()} km</span>}
                  {r.odometerEnd != null && <span className="text-muted-foreground ml-3">({(r.odometerEnd - r.odometerStart).toLocaleString()} km travelled)</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => startEdit(r)} className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => handleDelete(r)} disabled={deleting === r.id} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-50"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        ))}
        {editingFY === '__new__' ? (
          <OdometerForm form={form} setForm={setForm} onSave={handleSave} onCancel={() => setEditingFY(null)} saving={saving} error={error} isNew />
        ) : (
          <Button size="sm" variant="outline" onClick={() => startEdit()}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />Add Year
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function OdometerForm({
  form, setForm, onSave, onCancel, saving, error, isNew,
}: {
  form: { financialYear: string; odometerStart: string; odometerEnd: string; notes: string }
  setForm: (fn: (f: typeof form) => typeof form) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  error: string
  isNew?: boolean
}) {
  return (
    <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {isNew && (
          <div className="space-y-1">
            <Label className="text-xs">Financial Year</Label>
            <Input value={form.financialYear} onChange={e => setForm(f => ({ ...f, financialYear: e.target.value }))} placeholder="FY2026" className="h-9" />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Start (km) *</Label>
          <Input type="number" inputMode="numeric" value={form.odometerStart} onChange={e => setForm(f => ({ ...f, odometerStart: e.target.value }))} placeholder="e.g. 45000" className="h-9" min={0} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">End (km)</Label>
          <Input type="number" inputMode="numeric" value={form.odometerEnd} onChange={e => setForm(f => ({ ...f, odometerEnd: e.target.value }))} placeholder="e.g. 62000" className="h-9" min={0} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Notes</Label>
          <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" className="h-9" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  )
}
