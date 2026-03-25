import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Edit2, X, Check, MapPin, Fingerprint, AlertTriangle } from 'lucide-react'
import { deviceService } from '@/services'
import { useUIStore } from '@/store'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import type { DeviceInfo } from '@/types'

interface DeviceRow extends DeviceInfo {
  _editing?: boolean
  _isNew?: boolean
}

const EMPTY_DEVICE = (): DeviceRow => ({
  device_id: '',
  model: '',
  location: { lat: null, lng: null, alt: null },
  _editing: true,
  _isNew: true,
})

export default function DevicePage() {
  const { addToast } = useUIStore()
  const qc = useQueryClient()
  const [rows, setRows] = useState<DeviceRow[]>([])
  const { isDirty, markDirty, markClean } = useDirtyGuard()

  const { data: deviceQueryData } = useQuery({
    queryKey: ['device-list'],
    queryFn: async () => {
      const ids = await deviceService.list()
      const details = await Promise.all(ids.map((id) => deviceService.get(id)))
      return details.map((d, i) => ({ ...d, device_id: d.device_id || ids[i] }))
    },
    // 30s stale time — reload on focus won't stomp on user's in-progress edits
    staleTime: 30_000,
  })

  // Sync rows from server ONLY when not in the middle of editing
  useEffect(() => {
    if (deviceQueryData && !isDirty) {
      setRows(deviceQueryData.map((d) => ({ ...d, _editing: false, _isNew: false })))
    }
  }, [deviceQueryData, isDirty])

  const { mutate: saveOne } = useMutation({
    mutationFn: (row: DeviceRow) => deviceService.set(row.device_id, row),
    onSuccess: (_data, row) => {
      addToast('success', `Device ${row.device_id} saved`)
      setRows((prev) => prev.map((r) =>
        r.device_id === row.device_id ? { ...r, _editing: false, _isNew: false } : r
      ))
      markClean()
      qc.invalidateQueries({ queryKey: ['device-list'] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const { mutate: deleteOne } = useMutation({
    mutationFn: (id: string) => deviceService.delete(id),
    onSuccess: (_data, id) => {
      addToast('success', `Device ${id} deleted`)
      setRows((prev) => prev.filter((r) => r.device_id !== id))
      qc.invalidateQueries({ queryKey: ['device-list'] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const addRow = () => {
    setRows((prev) => [...prev, EMPTY_DEVICE()])
    markDirty()
  }

  const startEdit = (id: string) => {
    setRows((prev) => prev.map((r) => r.device_id === id ? { ...r, _editing: true } : r))
    markDirty()
  }

  const cancelEdit = (row: DeviceRow) => {
    if (row._isNew) {
      setRows((prev) => prev.filter((r) => r !== row))
    } else {
      setRows((prev) => prev.map((r) => r.device_id === row.device_id ? { ...r, _editing: false } : r))
    }
    // Only mark clean if no other rows are being edited
    const still = rows.filter((r) => r !== row && r._editing)
    if (!still.length) markClean()
  }

  const updateRow = (idx: number, path: string, val: string) => {
    setRows((prev) => {
      const next = [...prev]
      const r = { ...next[idx] }
      if (path === 'device_id') r.device_id = val
      else if (path === 'model') r.model = val
      else if (path === 'lat') r.location = { ...r.location, lat: val === '' ? null : parseFloat(val) }
      else if (path === 'lng') r.location = { ...r.location, lng: val === '' ? null : parseFloat(val) }
      next[idx] = r
      return next
    })
  }

  // Count editing rows for the dirty banner
  const editingCount = rows.filter((r) => r._editing).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Devices</h1>
        <p className="text-sm text-gray-500 mt-1">
          Register device GPS coordinates here. The worker identifies devices using the
          <strong className="font-semibold"> Device ID Field</strong> configured per-source in the Visual Mapping page,
          then injects the matching fixed GPS coordinates into{' '}
          <code className="font-mono text-xs">params.latitude</code> /{' '}
          <code className="font-mono text-xs">params.longitude</code>.
        </p>
      </div>

      {/* Dirty banner */}
      {editingCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {editingCount} row{editingCount > 1 ? 's' : ''} with unsaved changes — click ✓ to save each row.
          Navigating away will lose unsaved edits.
        </div>
      )}

      <Card
        title="Device Registry"
        description="存储为 uw:device:{value}，其中 value 为 payload 中 Device ID Field 字段的实际内容"
        actions={
          <Button variant="secondary" size="sm" onClick={addRow}>
            <Plus className="w-3.5 h-3.5" /> Add Device
          </Button>
        }
      >
        <div className="grid grid-cols-[2fr_2fr_1.2fr_1.2fr_auto] gap-3 mb-2 px-1">
          {['Device ID 字段值 *', '备注 (Model)', 'Latitude', 'Longitude', ''].map((h) => (
            <span key={h} className="text-xs font-medium text-gray-500">{h}</span>
          ))}
        </div>

        <div className="space-y-2">
          {rows.length === 0 && (
            <div className="text-sm text-gray-400 py-6 text-center">
              No devices registered — click "Add Device" to start.
            </div>
          )}

          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[2fr_2fr_1.2fr_1.2fr_auto] gap-3 items-center">
              {row._editing ? (
                <>
                  <Input
                    placeholder="e.g. 192.168.1.1 / SN-20240001"
                    value={row.device_id}
                    onChange={(e) => updateRow(i, 'device_id', e.target.value)}
                    disabled={!row._isNew}
                  />
                  <Input
                    placeholder="备注（可选）"
                    value={row.model ?? ''}
                    onChange={(e) => updateRow(i, 'model', e.target.value)}
                  />
                  <Input
                    type="number"
                    placeholder="22.5431"
                    value={row.location?.lat ?? ''}
                    onChange={(e) => updateRow(i, 'lat', e.target.value)}
                  />
                  <Input
                    type="number"
                    placeholder="114.0579"
                    value={row.location?.lng ?? ''}
                    onChange={(e) => updateRow(i, 'lng', e.target.value)}
                  />
                  <div className="flex gap-1">
                    <button
                      onClick={() => saveOne(row)}
                      disabled={!row.device_id.trim()}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 transition-colors"
                      title="Save"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => cancelEdit(row)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 transition-colors"
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-sm font-mono text-gray-800 truncate">{row.device_id}</span>
                  <span className="text-sm text-gray-600 truncate">{row.model || '—'}</span>
                  <span className={`text-sm font-mono ${row.location?.lat != null ? 'text-emerald-700' : 'text-gray-300'}`}>
                    {row.location?.lat != null ? row.location.lat.toFixed(5) : '—'}
                  </span>
                  <span className={`text-sm font-mono ${row.location?.lng != null ? 'text-emerald-700' : 'text-gray-300'}`}>
                    {row.location?.lng != null ? row.location.lng.toFixed(5) : '—'}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => startEdit(row.device_id)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteOne(row.device_id)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card title="How GPS Enrichment Works">
        <div className="space-y-3 text-sm text-gray-600">
          <div className="flex items-start gap-3">
            <Fingerprint className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-gray-700 mb-1">Step 1 — Device ID Field (per source)</p>
              <p>In the Visual Mapping page, configure which flattened payload field holds the device identifier.
                e.g. if you set <code className="font-mono text-xs bg-gray-100 px-1 rounded">deviceSN</code>,
                the worker reads <code className="font-mono text-xs bg-gray-100 px-1 rounded">payload.deviceSN</code> to get the actual device ID value.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <MapPin className="w-4 h-4 text-teal-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-gray-700 mb-1">Step 2 — Registry Lookup (this page)</p>
              <p>The resolved device ID value is matched against the <strong>Device ID 字段值</strong> column above.
                If found, coordinates are injected into the FH2 body:</p>
              <pre className="text-xs font-mono bg-gray-900 text-emerald-400 p-2 rounded mt-2">{`params.latitude  = device.location.lat\nparams.longitude = device.location.lng`}</pre>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
