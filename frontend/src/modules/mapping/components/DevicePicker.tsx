/**
 * DevicePicker.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Compact device picker embedded in MappingBoard.
 * Allows registering/editing a device's GPS coordinates so the autofill
 * pipeline can inject lat/lng even when no coordinate fields exist in the
 * incoming webhook payload.
 *
 * Behavior:
 * - Lists all registered devices (POST /admin/device/list)
 * - Allows selecting one to "pin" as the fallback device for this source
 * - Inline quick-edit for lat/lng/alt
 * - "Add Device" in-place form
 *
 * Does NOT replace DevicePage — that remains the full management view.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MapPin, Plus, Check, X, Edit2, ChevronDown, ChevronRight } from 'lucide-react'
import { deviceService } from '@/services'
import { useUIStore } from '@/store'
import type { DeviceInfo } from '@/types'

interface DevicePickerProps {
  /** Currently active source — shown as context label */
  sourceId: string
}

const EMPTY: DeviceInfo = {
  device_id: '',
  model: '',
  site: '',
  location: { lat: null, lng: null, alt: null },
}

export function DevicePicker({ sourceId }: DevicePickerProps) {
  const { addToast } = useUIStore()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<DeviceInfo>(EMPTY)
  const [addMode, setAddMode] = useState(false)
  const [newDraft, setNewDraft] = useState<DeviceInfo>({ ...EMPTY })

  // Load device list + details
  const { data: devices = [] } = useQuery({
    queryKey: ['device-list'],
    queryFn: async (): Promise<DeviceInfo[]> => {
      const ids = await deviceService.list()
      if (!ids.length) return []
      return Promise.all(ids.map((id) => deviceService.get(id)))
    },
  })

  // Save device
  const { mutate: save } = useMutation({
    mutationFn: (d: DeviceInfo) => deviceService.set(d.device_id, d),
    onSuccess: (_data, d) => {
      addToast('success', `Device ${d.device_id} saved`)
      setEditingId(null)
      setAddMode(false)
      setNewDraft({ ...EMPTY })
      qc.invalidateQueries({ queryKey: ['device-list'] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // Delete device
  const { mutate: del } = useMutation({
    mutationFn: (id: string) => deviceService.delete(id),
    onSuccess: (_data, id) => {
      addToast('success', `Device ${id} deleted`)
      qc.invalidateQueries({ queryKey: ['device-list'] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const startEdit = (d: DeviceInfo) => {
    setEditingId(d.device_id)
    setEditDraft({ ...d, location: { ...d.location } })
    setAddMode(false)
  }

  const patchDraft = (
    draft: DeviceInfo,
    setDraft: (d: DeviceInfo) => void,
    field: string,
    val: string,
  ) => {
    if (field === 'model' || field === 'site') {
      setDraft({ ...draft, [field]: val })
    } else if (field === 'lat' || field === 'lng' || field === 'alt') {
      setDraft({
        ...draft,
        location: { ...draft.location, [field]: val === '' ? null : parseFloat(val) },
      })
    } else if (field === 'device_id') {
      setDraft({ ...draft, device_id: val })
    }
  }

  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
      {/* Header toggle */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          {open
            ? <ChevronDown className="w-4 h-4 text-gray-400" />
            : <ChevronRight className="w-4 h-4 text-gray-400" />}
          <MapPin className="w-4 h-4 text-brand-500" />
          <span className="text-sm font-semibold text-gray-700">Device GPS Fallback</span>
          {devices.length > 0 && (
            <span className="text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5">
              {devices.length}
            </span>
          )}
        </div>
        <span className="text-xs text-gray-400">
          Inject GPS when payload has no coordinates · source: {sourceId}
        </span>
      </button>

      {open && (
        <div className="p-4 space-y-3">
          {/* Explanation */}
          <p className="text-xs text-gray-500">
            If the incoming webhook has no <code className="font-mono bg-gray-100 px-1 rounded">lat</code>/
            <code className="font-mono bg-gray-100 px-1 rounded">lng</code> fields,
            the autofill step will look up the device by <code className="font-mono bg-gray-100 px-1 rounded">device_id</code> and
            inject its registered GPS coordinates into <code className="font-mono bg-gray-100 px-1 rounded">params.latitude</code> /
            <code className="font-mono bg-gray-100 px-1 rounded">params.longitude</code>.
          </p>

          {/* Device table */}
          {devices.length > 0 && (
            <div className="space-y-1.5">
              {/* Table header */}
              <div className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.7fr_auto] gap-2 px-2 text-xs font-medium text-gray-400">
                {['Device ID', 'Model', 'Site', 'Lat', 'Lng', 'Alt', ''].map((h) => (
                  <span key={h}>{h}</span>
                ))}
              </div>

              {devices.map((d) =>
                editingId === d.device_id ? (
                  /* ── Edit row ── */
                  <div key={d.device_id}
                    className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.7fr_auto] gap-2 items-center bg-blue-50 border border-blue-200 rounded-lg px-2 py-1.5"
                  >
                    <span className="text-xs font-mono text-gray-600 truncate">{d.device_id}</span>
                    {(['model', 'site'] as const).map((f) => (
                      <input
                        key={f}
                        className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                        value={(editDraft[f as keyof DeviceInfo] as string) ?? ''}
                        onChange={(e) => patchDraft(editDraft, setEditDraft, f, e.target.value)}
                        placeholder={f}
                      />
                    ))}
                    {(['lat', 'lng', 'alt'] as const).map((f) => (
                      <input
                        key={f}
                        type="number"
                        step="any"
                        className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                        value={editDraft.location?.[f] ?? ''}
                        onChange={(e) => patchDraft(editDraft, setEditDraft, f, e.target.value)}
                        placeholder={f}
                      />
                    ))}
                    <div className="flex gap-1">
                      <button
                        onClick={() => save(editDraft)}
                        className="w-6 h-6 flex items-center justify-center rounded text-emerald-600 hover:bg-emerald-100"
                        title="Save"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100"
                        title="Cancel"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── View row ── */
                  <div key={d.device_id}
                    className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.7fr_auto] gap-2 items-center px-2 py-1.5 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-100 transition-colors"
                  >
                    <span className="text-xs font-mono text-gray-800 truncate">{d.device_id}</span>
                    <span className="text-xs text-gray-500 truncate">{d.model || '—'}</span>
                    <span className="text-xs text-gray-500">{d.site || '—'}</span>
                    <span className={`text-xs font-mono ${d.location?.lat != null ? 'text-emerald-600' : 'text-gray-300'}`}>
                      {d.location?.lat != null ? d.location.lat.toFixed(4) : '—'}
                    </span>
                    <span className={`text-xs font-mono ${d.location?.lng != null ? 'text-emerald-600' : 'text-gray-300'}`}>
                      {d.location?.lng != null ? d.location.lng.toFixed(4) : '—'}
                    </span>
                    <span className="text-xs font-mono text-gray-500">
                      {d.location?.alt != null ? d.location.alt : '—'}
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => startEdit(d)}
                        className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:text-brand-500 hover:bg-brand-50 transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => del(d.device_id)}
                        className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {/* Add new device row */}
          {addMode ? (
            <div className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.7fr_auto] gap-2 items-center bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5">
              <input
                className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400 font-mono"
                placeholder="device-id *"
                value={newDraft.device_id}
                onChange={(e) => patchDraft(newDraft, setNewDraft, 'device_id', e.target.value)}
              />
              {(['model', 'site'] as const).map((f) => (
                <input
                  key={f}
                  className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                  value={(newDraft[f as keyof DeviceInfo] as string) ?? ''}
                  onChange={(e) => patchDraft(newDraft, setNewDraft, f, e.target.value)}
                  placeholder={f}
                />
              ))}
              {(['lat', 'lng', 'alt'] as const).map((f) => (
                <input
                  key={f}
                  type="number"
                  step="any"
                  className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                  value={newDraft.location?.[f] ?? ''}
                  onChange={(e) => patchDraft(newDraft, setNewDraft, f, e.target.value)}
                  placeholder={f}
                />
              ))}
              <div className="flex gap-1">
                <button
                  onClick={() => newDraft.device_id.trim() && save(newDraft)}
                  disabled={!newDraft.device_id.trim()}
                  className="w-6 h-6 flex items-center justify-center rounded text-emerald-600 hover:bg-emerald-100 disabled:opacity-40"
                  title="Save"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => { setAddMode(false); setNewDraft({ ...EMPTY }) }}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setAddMode(true); setEditingId(null) }}
              className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Register Device
            </button>
          )}
        </div>
      )}
    </div>
  )
}
