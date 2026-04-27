/**
 * DevicePicker.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Compact panel embedded in MappingBoard.
 *
 *  A. Device ID Field Config
 *     Configures which flattened payload field is used as the device lookup key.
 *     Stored in uw:deviceidfield:{source}
 *
 *  B. Device GPS Fallback
 *     Reads from the shared device-list (same data as the Devices page).
 *     Provides an inline Add interface to register new devices without leaving
 *     the mapping page.  Only device_id / model / lat / lng are shown.
 */
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MapPin, Plus, Check, X, ChevronDown, ChevronRight,
  Save, Fingerprint, ExternalLink,
} from 'lucide-react'
import { deviceService, deviceIdFieldService } from '@/services'
import { useUIStore } from '@/store'
import type { DeviceInfo } from '@/types'

interface DevicePickerProps {
  sourceId: string
  onDeviceIdFieldChange?: (field: string) => void
}

const EMPTY_NEW: DeviceInfo = {
  device_id: '',
  model: '',
  location: { lat: null, lng: null, alt: null },
}

export function DevicePicker({ sourceId, onDeviceIdFieldChange }: DevicePickerProps) {
  const { addToast } = useUIStore()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  // ── A: Device ID Field ────────────────────────────────────────────────────
  const [deviceIdField, setDeviceIdField] = useState('')
  const [fieldDirty, setFieldDirty] = useState(false)

  const { data: deviceIdFieldData } = useQuery({
    queryKey: ['device-id-field', sourceId],
    queryFn: () => deviceIdFieldService.get(sourceId),
    enabled: !!sourceId,
    staleTime: 0,
  })

  useEffect(() => {
    if (deviceIdFieldData !== undefined) {
      setDeviceIdField(deviceIdFieldData)
      onDeviceIdFieldChange?.(deviceIdFieldData)
      setFieldDirty(false)
    }
  }, [deviceIdFieldData]) // eslint-disable-line react-hooks/exhaustive-deps

  const { mutate: saveField, isPending: savingField } = useMutation({
    mutationFn: () => deviceIdFieldService.set(sourceId, deviceIdField),
    onSuccess: () => {
      addToast('success', 'Device ID field saved')
      setFieldDirty(false)
      onDeviceIdFieldChange?.(deviceIdField)
      qc.invalidateQueries({ queryKey: ['device-id-field', sourceId] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // ── B: Shared device list (same as Devices page) ──────────────────────────
  const { data: devices = [] } = useQuery({
    queryKey: ['device-list'],
    queryFn: async (): Promise<DeviceInfo[]> => {
      const ids = await deviceService.list()
      if (!ids.length) return []
      return Promise.all(ids.map((id) => deviceService.get(id)))
    },
    staleTime: 0,
  })

  // Add new device inline
  const [addMode, setAddMode] = useState(false)
  const [newDraft, setNewDraft] = useState<DeviceInfo>({ ...EMPTY_NEW })

  const { mutate: saveDevice, isPending: savingDevice } = useMutation({
    mutationFn: (d: DeviceInfo) => deviceService.set(d.device_id, d),
    onSuccess: (_data, d) => {
      addToast('success', `Device "${d.device_id}" registered`)
      setAddMode(false)
      setNewDraft({ ...EMPTY_NEW })
      qc.invalidateQueries({ queryKey: ['device-list'] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const { mutate: delDevice } = useMutation({
    mutationFn: (id: string) => deviceService.delete(id),
    onSuccess: (_data, id) => {
      addToast('success', `Device "${id}" removed`)
      qc.invalidateQueries({ queryKey: ['device-list'] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const patchNew = (field: string, val: string) => {
    if (field === 'device_id' || field === 'model') {
      setNewDraft((d) => ({ ...d, [field]: val }))
    } else if (field === 'lat' || field === 'lng') {
      setNewDraft((d) => ({
        ...d,
        location: { ...d.location, [field]: val === '' ? null : parseFloat(val) },
      }))
    }
  }

  const hasDeviceGps = devices.some(
    (d) => d.location?.lat != null && d.location?.lng != null,
  )

  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
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

          {deviceIdField && (
            <span className="text-xs bg-indigo-100 text-indigo-700 rounded-full px-2 py-0.5 font-mono">
              id-field: {deviceIdField}
            </span>
          )}
          {hasDeviceGps && (
            <span className="text-xs bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5">
              {devices.filter(d => d.location?.lat != null).length} GPS
            </span>
          )}
          {devices.length > 0 && (
            <span className="text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5">
              {devices.length} device{devices.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span className="text-xs text-gray-400">{sourceId}</span>
      </button>

      {open && (
        <div className="p-4 space-y-5">

          {/* ── How it works ────────────────────────────────────────────────── */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 text-xs text-blue-800">
            <p className="font-semibold mb-1.5">How it works: 3-step GPS injection</p>
            <ol className="space-y-1.5 list-none">
              <li className="flex items-start gap-2">
                <span className="shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-[10px]">1</span>
                <span>
                  <strong>Device ID Field</strong> (configured below) — enter the flattened payload field that identifies the device.
                  At runtime the worker reads the <strong>value</strong> of that field (e.g. if you set <code className="bg-blue-100 px-1 rounded font-mono">ipAddress</code>,
                  it reads <code className="bg-blue-100 px-1 rounded font-mono">payload.ipAddress</code>, e.g. <code className="bg-blue-100 px-1 rounded font-mono">192.168.1.1</code>).
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-[10px]">2</span>
                <span>
                  <strong>Device Registry</strong> (table below) — map each real field value to fixed coordinates.
                  The <strong>"Field Value" column holds the actual content of that field in the payload</strong> (e.g. <code className="bg-blue-100 px-1 rounded font-mono">192.168.1.1</code>).
                  The worker looks it up and retrieves lat / lng.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-[10px]">3</span>
                <span>
                  <strong>Auto-inject</strong> — on match, the resolved lat / lng are written to
                  <code className="bg-blue-100 px-1 rounded font-mono ml-1">params.latitude</code> /
                  <code className="bg-blue-100 px-1 rounded font-mono ml-1">params.longitude</code> (only when those fields are not already filled by field mapping).
                </span>
              </li>
            </ol>
          </div>

          {/* ── A. Device ID Field ────────────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Fingerprint className="w-3.5 h-3.5 text-indigo-500" />
              <span className="text-xs font-semibold text-gray-700">Step 1: Device ID Field</span>
              <span className="text-xs text-gray-400">— which payload field identifies the device</span>
            </div>
            <p className="text-xs text-gray-400 mb-2">
              Enter the field name from the flattened payload. Leave blank to default to
              <code className="font-mono bg-gray-100 px-1 mx-0.5 rounded">device_id</code>.
            </p>
            <div className="flex items-center gap-2">
              <input
                className={[
                  'flex-1 text-xs font-mono border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors',
                  deviceIdField ? 'border-indigo-300 bg-indigo-50' : 'border-gray-300',
                ].join(' ')}
                placeholder="e.g. deviceSN  /  camera.sn  /  Event.DeviceId"
                value={deviceIdField}
                onChange={(e) => {
                  setDeviceIdField(e.target.value)
                  setFieldDirty(true)
                  onDeviceIdFieldChange?.(e.target.value)
                }}
              />
              {fieldDirty && (
                <button
                  type="button"
                  onClick={() => saveField()}
                  disabled={savingField}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingField ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            {deviceIdField && (
              <p className="text-xs text-indigo-600 mt-1.5">
                ✓ Worker reads the <strong>value</strong> of payload field <code className="font-mono bg-indigo-50 px-1 rounded">{deviceIdField}</code> and looks up matching coordinates in the table below
              </p>
            )}
          </div>

          {/* divider */}
          <div className="border-t border-gray-100" />

          {/* ── B. Device Registry ───────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-teal-500" />
                <span className="text-xs font-semibold text-gray-700">Step 2: Device Registry</span>
                <span className="text-xs text-gray-400">— Device ID value → fixed coordinates</span>
              </div>
              {/* Link to Devices page */}
              <a
                href="/devices"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-600 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
                Devices Page
              </a>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Data is shared with the Devices page. You can quickly add devices here; for full management go to the Devices page.
            </p>

            {/* Table */}
            {devices.length > 0 && (
              <div className="space-y-1 mb-3">
                {/* Header — emphasise that the "Field Value" column holds the actual payload value */}
                <div className="grid grid-cols-[1.4fr_1fr_0.9fr_0.9fr_auto] gap-2 px-2 text-xs font-medium text-gray-400">
                  {[
                    deviceIdField ? `${deviceIdField} value` : 'Field Value (Device ID)',
                    'Note',
                    'Lat',
                    'Lng',
                    '',
                  ].map((h) => (
                    <span key={h}>{h}</span>
                  ))}
                </div>

                {devices.map((d) => (
                  <div
                    key={d.device_id}
                    className="grid grid-cols-[1.4fr_1fr_0.9fr_0.9fr_auto] gap-2 items-center px-2 py-1.5 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-100 transition-colors"
                  >
                    <span className="text-xs font-mono text-gray-800 truncate">{d.device_id}</span>
                    <span className="text-xs text-gray-500 truncate">{d.model || '—'}</span>
                    <span className={`text-xs font-mono ${d.location?.lat != null ? 'text-emerald-600' : 'text-gray-300'}`}>
                      {d.location?.lat != null ? d.location.lat.toFixed(4) : '—'}
                    </span>
                    <span className={`text-xs font-mono ${d.location?.lng != null ? 'text-emerald-600' : 'text-gray-300'}`}>
                      {d.location?.lng != null ? d.location.lng.toFixed(4) : '—'}
                    </span>
                    <button
                      onClick={() => delDevice(d.device_id)}
                      className="w-5 h-5 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title="Remove device"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new device inline */}
            {addMode ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-emerald-700">Register new device</p>
                <div className="grid grid-cols-[1.4fr_1fr_0.9fr_0.9fr] gap-2">
                  <div>
                    <label className="text-xs text-gray-500 mb-0.5 block">
                      {deviceIdField
                        ? <><code className="font-mono bg-gray-100 px-1 rounded">{deviceIdField}</code> value <span className="text-red-400">*</span></>
                        : <>Field Value (Device ID)<span className="text-red-400">*</span></>}
                    </label>
                    <input
                      className="w-full text-xs font-mono border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      placeholder={deviceIdField ? `actual value of payload.${deviceIdField}` : 'e.g. 192.168.1.1'}
                      value={newDraft.device_id}
                      onChange={(e) => patchNew('device_id', e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-0.5 block">Note (optional)</label>
                    <input
                      className="w-full text-xs border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      placeholder="M300 RTK"
                      value={newDraft.model ?? ''}
                      onChange={(e) => patchNew('model', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-0.5 block">Latitude</label>
                    <input
                      type="number"
                      step="any"
                      className="w-full text-xs font-mono border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      placeholder="22.5431"
                      value={newDraft.location?.lat ?? ''}
                      onChange={(e) => patchNew('lat', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-0.5 block">Longitude</label>
                    <input
                      type="number"
                      step="any"
                      className="w-full text-xs font-mono border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      placeholder="114.0579"
                      value={newDraft.location?.lng ?? ''}
                      onChange={(e) => patchNew('lng', e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => newDraft.device_id.trim() && saveDevice(newDraft)}
                    disabled={!newDraft.device_id.trim() || savingDevice}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {savingDevice ? 'Saving…' : 'Save Device'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAddMode(false); setNewDraft({ ...EMPTY_NEW }) }}
                    className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setAddMode(true) }}
                className="flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-700 font-medium transition-colors py-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Register Device
              </button>
            )}
          </div>

          {/* Hints */}
          {!hasDeviceGps && !deviceIdField && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠ GPS injection not configured. Fill in the Device ID Field in Step 1 first, then register device coordinates in Step 2.
            </p>
          )}
          {hasDeviceGps && !deviceIdField && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ℹ Device GPS registered, but Device ID Field is not set — the worker cannot match automatically. Please fill in the field name in Step 1.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
