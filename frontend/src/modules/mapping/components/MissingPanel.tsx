/**
 * MissingPanel.tsx  —  Below preview
 * Shows required FH2 body paths that are unmapped/unfilled.
 * Also explains autofill fallback logic.
 *
 * Coverage logic (layered, mirrors backend priority):
 *  1. mapped via visual mapping          → ✓ mapped
 *  2. workflow_uuid set in FH2Config     → ✓ covered (config)
 *  3. lat/lng covered by device GPS      → ~ covered (device)
 *  4. has hardcoded default              → ~ default
 *  5. still missing from debug run       → ⚠ missing
 */
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { useMappingStore } from '@/store'
import { FH2_TARGET_FIELDS } from './MappingRow'

/** Fields that have a hardcoded safe default in autofill.py */
const HAS_DEFAULT = new Set(['params.level', 'params.creator', 'trigger_type', 'params.desc'])

const AUTOFILL_NOTES: Record<string, string> = {
  'params.latitude':  'Will use device GPS if device record is found',
  'params.longitude': 'Will use device GPS if device record is found',
  'params.level':     'Default = 3 (warning)',
  'params.creator':   'Default = "system"',
  'workflow_uuid':    'Set workflow_uuid in FH2 Credentials above',
  'trigger_type':     'Default = 0',
}

interface MissingPanelProps {
  missing?: string[]
  /** workflow_uuid currently typed in FH2ConfigPanel (live) */
  workflowUuid?: string
  /** device_id_field configured in DevicePicker (used for GPS lookup) */
  deviceIdField?: string
  /** whether any device with GPS is registered */
  hasDeviceGps?: boolean
}

export function MissingPanel({
  missing: externalMissing,
  workflowUuid = '',
  deviceIdField = '',
  hasDeviceGps = false,
}: MissingPanelProps) {
  const { missing: storeMissing, mapping } = useMappingStore()
  // Use external missing list from debug run if available, else store
  const missingFromDebug = externalMissing ?? storeMissing

  const required = FH2_TARGET_FIELDS.filter((f) => f.required)
  const mappedTargets = new Set(Object.values(mapping))

  // GPS is considered covered if:
  //  - any device has GPS AND (device_id is mapped OR deviceIdField is configured)
  const deviceIdMapped = mappedTargets.has('params.device_id') ||
    Object.keys(mapping).some(k => k === 'device_id')
  const gpsViableViaDevice = hasDeviceGps && (deviceIdMapped || deviceIdField.trim() !== '')

  // Compute effective coverage for each field
  const getCoverage = (path: string): 'mapped' | 'config' | 'device' | 'default' | 'missing' => {
    if (mappedTargets.has(path)) return 'mapped'
    if (path === 'workflow_uuid' && workflowUuid.trim()) return 'config'
    if ((path === 'params.latitude' || path === 'params.longitude') && gpsViableViaDevice) return 'device'
    if (HAS_DEFAULT.has(path)) return 'default'
    if (missingFromDebug.includes(path)) return 'missing'
    return 'default'
  }

  const coverageList = required.map((f) => ({ ...f, coverage: getCoverage(f.path) }))
  const reallyMissing = coverageList.filter((f) => f.coverage === 'missing').length

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-1.5">
        {reallyMissing === 0 ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-amber-500" />
        )}
        <span className="text-sm font-semibold text-gray-700">
          {reallyMissing === 0
            ? 'All required fields covered'
            : `${reallyMissing} field${reallyMissing !== 1 ? 's' : ''} may be missing`}
        </span>
        {deviceIdField && (
          <span className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5 font-mono ml-auto">
            id-field: {deviceIdField}
          </span>
        )}
      </div>

      {/* Required field checklist */}
      <div className="space-y-1.5">
        {coverageList.map((f) => {
          const { coverage } = f
          const note = AUTOFILL_NOTES[f.path]

          const bgClass =
            coverage === 'missing' ? 'bg-amber-50 border-amber-200' :
            coverage === 'mapped'  ? 'bg-emerald-50 border-emerald-200' :
            coverage === 'config'  ? 'bg-blue-50 border-blue-200' :
            coverage === 'device'  ? 'bg-teal-50 border-teal-200' :
                                     'bg-gray-50 border-gray-200'

          const icon =
            coverage === 'mapped' || coverage === 'config'
              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              : coverage === 'device'
              ? <CheckCircle2 className="w-3.5 h-3.5 text-teal-500" />
              : coverage === 'missing'
              ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              : <Info className="w-3.5 h-3.5 text-gray-400" />

          const labelColor =
            coverage === 'missing' ? 'text-amber-700' :
            coverage === 'mapped' || coverage === 'config' ? 'text-emerald-700' :
            coverage === 'device' ? 'text-teal-700' :
            'text-gray-600'

          const badge =
            coverage === 'mapped'  ? <span className="text-emerald-600 font-medium shrink-0 text-xs">✓ mapped</span> :
            coverage === 'config'  ? <span className="text-blue-600 font-medium shrink-0 text-xs">✓ config</span> :
            coverage === 'device'  ? <span className="text-teal-600 font-medium shrink-0 text-xs">~ device GPS</span> :
            coverage === 'default' ? <span className="text-gray-400 font-medium shrink-0 text-xs">~ default</span> :
            null

          return (
            <div key={f.path} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs border ${bgClass}`}>
              <span className="mt-0.5 shrink-0">{icon}</span>
              <div className="flex-1 min-w-0">
                <span className={`font-mono font-semibold ${labelColor}`}>{f.path}</span>
                {note && coverage !== 'mapped' && coverage !== 'config' && (
                  <span className="block text-gray-400 mt-0.5">{note}</span>
                )}
              </div>
              {badge}
            </div>
          )
        })}
      </div>

      {/* GPS hint when device registered but device_id not mapped or configured */}
      {hasDeviceGps && !gpsViableViaDevice && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
          ℹ Devices with GPS are registered, but no device ID source is configured.
          Map <code className="font-mono">device_id</code> in the field mapping above,
          or set a <strong>Device ID Field</strong> in the GPS Fallback panel to enable lookup.
        </p>
      )}
    </div>
  )
}
