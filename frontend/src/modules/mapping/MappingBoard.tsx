/**
 * MappingBoard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Core 3-column visual mapping UI.
 *
 * Draft semantics:
 *   • Mapping changes go into the per-source draft in MappingStore immediately
 *     (no unsaved data loss on page refresh — they're persisted in localStorage).
 *   • `isDirty` from MappingStore tracks whether the draft differs from the
 *     last-saved snapshot, so we show a "Draft" badge next to the source.
 *   • Clicking "Save Mapping" writes to Redis AND calls markSaved() to clear
 *     the dirty flag and update the snapshot.
 *   • The active source is read from MappingStore (was set by Sidebar switcher
 *     or wizard). In standalone Mapping page mode the user can still override
 *     via the source dropdown.
 */
import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Save, RefreshCw, Sparkles, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { debugService, mappingService, sourceService, deviceService } from '@/services'
import { useMappingStore, useSourceStore, useUIStore } from '@/store'
import { FieldList } from './components/FieldList'
import { MappingRow, FH2_TARGET_FIELDS } from './components/MappingRow'
import { OutputPreview } from './components/OutputPreview'
import { MissingPanel } from './components/MissingPanel'
import { FH2ConfigPanel } from './components/FH2ConfigPanel'
import { DevicePicker } from './components/DevicePicker'
import { ApiFormatPanel } from './components/ApiFormatPanel'
import type { DebugResult, FH2Body, MappingConfig, MappingRow as MappingRowType, DeviceInfo } from '@/types'

// ─── Visual mapping → legacy MappingConfig ────────────────────────────────────
function visualToLegacy(
  visual: Record<string, string>,
  _normalizedFields: string[],
): MappingConfig {
  const rows: MappingRowType[] = []
  for (const [src, dst] of Object.entries(visual)) {
    if (!src || !dst) continue
    const target = FH2_TARGET_FIELDS.find((f) => f.path === dst)
    rows.push({
      src: `$.${src}`,
      dst,
      type: target?.type === 'int' ? 'int'
           : target?.type === 'number' ? 'float'
           : 'string',
      default: '',
      required: target?.required ?? false,
    })
  }
  return { mappings: rows }
}

// ─── Legacy MappingConfig → visual mapping ────────────────────────────────────
function legacyToVisual(cfg: MappingConfig): Record<string, string> {
  const visual: Record<string, string> = {}
  for (const row of cfg.mappings ?? []) {
    const src = row.src?.replace(/^\$\./, '')
    if (src && row.dst) visual[src] = row.dst
  }
  return visual
}

// ─── Auto-suggest ─────────────────────────────────────────────────────────────
function autoSuggestAll(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const s = (f: string) => f.toLowerCase()
  for (const f of fields) {
    const sf = s(f)
    if (sf.includes('lat'))                                    result[f] = 'params.latitude'
    else if (sf.includes('lon') || sf.includes('lng'))         result[f] = 'params.longitude'
    else if (sf.includes('level') || sf.includes('severity'))  result[f] = 'params.level'
    else if (sf.includes('desc') || sf.includes('message'))    result[f] = 'params.desc'
    else if (sf.includes('creator') || sf.includes('operator') || sf.includes('pilot')) result[f] = 'params.creator'
    else if ((sf.includes('name') || sf.includes('event')) && !sf.includes('device'))   result[f] = 'name'
  }
  return result
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface MappingBoardProps {
  /** When passed from wizard, lock the source selector to this value */
  wizardSourceId?: string
}

export function MappingBoard({ wizardSourceId }: MappingBoardProps = {}) {
  const { addToast } = useUIStore()
  const { selected, setSelected } = useSourceStore()
  const qc = useQueryClient()

  const {
    activeSourceId, switchSource,
    mapping, setMapping, setSamplePayload,
    setNormalizedFields, normalizedFields,
    setPreview, setMissing, missing,
    samplePayload,
    isDirty, markSaved,
  } = useMappingStore()

  // Determine the source to operate on:
  //   wizard mode → wizardSourceId (locked)
  //   standalone  → use MappingStore's activeSourceId (set by sidebar),
  //                 fall back to SourceStore.selected for backwards compatibility
  const activeSource = wizardSourceId || activeSourceId || selected

  // When standalone mode: sync MappingStore if it's behind the global selection
  useEffect(() => {
    if (!wizardSourceId && selected && selected !== activeSourceId) {
      switchSource(selected)
    }
  }, [wizardSourceId, selected, activeSourceId, switchSource])

  const [debugResult, setDebugResult] = useState<DebugResult | null>(null)
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [showSampleEditor, setShowSampleEditor] = useState(false)
  const [liveWorkflowUuid, setLiveWorkflowUuid] = useState('')
  const [liveDeviceIdField, setLiveDeviceIdField] = useState('')
  const [hasDeviceGps, setHasDeviceGps] = useState(false)

  // Source list (only needed in standalone mode for the dropdown)
  const { data: sources = [] } = useQuery({
    queryKey: ['sources'],
    queryFn: sourceService.list,
    enabled: !wizardSourceId,
    staleTime: 30_000,
  })

  // GPS device check for MissingPanel coverage
  const { data: deviceList = [] } = useQuery({
    queryKey: ['device-list'],
    queryFn: async (): Promise<DeviceInfo[]> => {
      const ids = await deviceService.list()
      if (!ids.length) return []
      return Promise.all(ids.map((id) => deviceService.get(id)))
    },
    staleTime: 30_000,
  })
  useEffect(() => {
    setHasDeviceGps(deviceList.some((d) => d.location?.lat != null && d.location?.lng != null))
  }, [deviceList])

  // Load saved mapping from Redis — runs once per source, then cached.
  // We do NOT blindly overwrite the draft; only load if the draft is empty
  // (i.e., user hasn't started working on this source yet).
  const { data: savedMapping } = useQuery({
    queryKey: ['mapping', activeSource],
    queryFn: () => mappingService.get(activeSource),
    enabled: !!activeSource,
    staleTime: 30_000,
  })

  const [bootstrapped, setBootstrapped] = useState<string>('')
  useEffect(() => {
    if (!savedMapping || activeSource === bootstrapped) return
    const visual = legacyToVisual(savedMapping)
    // Only pre-fill draft if draft is currently empty (don't clobber user's draft)
    if (Object.keys(mapping).length === 0 && Object.keys(visual).length > 0) {
      setMapping(visual)
    }
    setBootstrapped(activeSource)
  }, [savedMapping, activeSource, bootstrapped, mapping, setMapping])

  // ── Debug run — pass current (unsaved) visual mapping as override ─────────
  const { mutate: runDebug, isPending: running } = useMutation({
    mutationFn: async () => {
      const latestPayload = useMappingStore.getState().samplePayload
      const latestMapping = useMappingStore.getState().mapping
      const latestNormalized = useMappingStore.getState().normalizedFields
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(latestPayload) } catch { parsed = {} }
      const mappingOverride = Object.keys(latestMapping).length > 0
        ? visualToLegacy(latestMapping, latestNormalized) as unknown as Record<string, unknown>
        : undefined
      return debugService.run(activeSource, parsed, mappingOverride)
    },
    onSuccess: (result) => {
      setDebugResult(result)
      if (result.normalized_fields) setNormalizedFields(result.normalized_fields)
      if (result.final_body)        setPreview(result.final_body as FH2Body)
      if (result.missing)           setMissing(result.missing)
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // ── Save mapping ──────────────────────────────────────────────────────────
  const { mutate: saveMapping, isPending: saving } = useMutation({
    mutationFn: () => {
      const currentMapping = useMappingStore.getState().mapping
      const currentNormalized = useMappingStore.getState().normalizedFields
      const legacy = visualToLegacy(currentMapping, currentNormalized)
      return mappingService.set(activeSource, legacy)
    },
    onSuccess: () => {
      addToast('success', 'Mapping saved')
      markSaved()   // clear dirty flag + update snapshot
      qc.invalidateQueries({ queryKey: ['mapping', activeSource] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const handleAutoSuggest = () => {
    const suggested = autoSuggestAll(normalizedFields)
    const merged = { ...mapping }
    let count = 0
    for (const [src, dst] of Object.entries(suggested)) {
      if (!merged[src]) { merged[src] = dst; count++ }
    }
    setMapping(merged)
    if (count > 0) addToast('info', `Auto-suggested ${count} field${count !== 1 ? 's' : ''}`)
    else addToast('info', 'No new suggestions')
  }

  const allFields = normalizedFields.length > 0 ? normalizedFields : Object.keys(mapping)

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Source indicator */}
        {wizardSourceId ? (
          <span className="inline-flex items-center gap-2 px-3 py-2 text-sm font-mono bg-brand-50 border border-brand-200 rounded-lg text-brand-800">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
            {wizardSourceId}
          </span>
        ) : (
          <select
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            value={activeSource}
            onChange={(e) => {
              const next = e.target.value
              if (isDirty && next !== activeSource) {
                if (!window.confirm('当前映射草稿未保存，切换 Source 后草稿仍会保留（各 Source 独立保存），但预览结果将重置。\n\n确认切换 Source 吗？')) return
              }
              setSelected(next)
              switchSource(next)
            }}
          >
            <option value="">— select source —</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

        {/* Draft / saved state badge */}
        {activeSource && (
          isDirty ? (
            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
              <AlertTriangle className="w-3 h-3" /> 草稿未保存
            </span>
          ) : Object.keys(mapping).length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
              ✓ 已保存
            </span>
          ) : null
        )}

        {/* Sample payload toggle */}
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-2 transition-colors"
          onClick={() => setShowSampleEditor(!showSampleEditor)}
        >
          {showSampleEditor ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Sample Payload
        </button>

        {/* Load fields */}
        <button
          type="button"
          onClick={() => runDebug()}
          disabled={!activeSource || running}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
        >
          <Play className="w-3.5 h-3.5" />
          {running ? 'Loading…' : 'Load Fields & Preview'}
        </button>

        {/* Auto-suggest */}
        {normalizedFields.length > 0 && (
          <button
            type="button"
            onClick={handleAutoSuggest}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Auto-Suggest
          </button>
        )}

        {/* Save */}
        <button
          type="button"
          onClick={() => saveMapping()}
          disabled={!activeSource || saving || Object.keys(mapping).length === 0}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors ml-auto"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Saving…' : 'Save Mapping'}
        </button>
      </div>

      {/* Sample payload editor */}
      {showSampleEditor && (
        <div className="border border-gray-200 rounded-xl p-3 bg-gray-50">
          <label className="text-xs font-medium text-gray-600 block mb-1.5">
            Sample Payload — used for normalizing fields and live preview
          </label>
          <textarea
            className="w-full font-mono text-xs border border-gray-300 rounded-lg p-2 h-32 resize-y focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            value={samplePayload}
            onChange={(e) => setSamplePayload(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      {/* FH2 credentials panel */}
      {activeSource && (
        <FH2ConfigPanel sourceId={activeSource} onWorkflowUuidChange={setLiveWorkflowUuid} />
      )}

      {/* Device GPS fallback panel */}
      {activeSource && (
        <DevicePicker sourceId={activeSource} onDeviceIdFieldChange={setLiveDeviceIdField} />
      )}

      {/* ── 3-column mapping board ────────────────────────────────────────── */}
      <div className="grid grid-cols-[220px_1fr_300px] gap-4 flex-1 min-h-0">

        {/* LEFT — normalized field list */}
        <div className="border border-gray-200 rounded-xl bg-white p-3 flex flex-col min-h-0 max-h-[600px]">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Input Fields</h3>
          <FieldList fields={allFields} selectedField={selectedField} onSelect={setSelectedField} />
        </div>

        {/* CENTER — mapping rows */}
        <div className="border border-gray-200 rounded-xl bg-white p-3 flex flex-col min-h-0 max-h-[600px]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Field Mapping</h3>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="text-emerald-600 font-medium">{Object.keys(mapping).length}</span>
              <span>/ {allFields.length} mapped</span>
              {Object.keys(mapping).length > 0 && (
                <button
                  type="button"
                  onClick={() => setMapping({})}
                  className="text-red-400 hover:text-red-600 transition-colors"
                  title="Clear all mappings"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0">
            {allFields.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 gap-2">
                <Play className="w-8 h-8 opacity-20" />
                <p className="text-sm">Click "Load Fields & Preview" to start</p>
                <p className="text-xs">Select a source and run the debug pipeline</p>
              </div>
            ) : (
              allFields.map((f) => (
                <MappingRow key={f} srcField={f} targetField={mapping[f] ?? ''} />
              ))
            )}
          </div>
        </div>

        {/* RIGHT — output preview */}
        <div className="flex flex-col gap-3 min-h-0 max-h-[600px] overflow-y-auto">
          <div className="border border-gray-200 rounded-xl bg-white p-3 flex flex-col min-h-[200px]">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">FH2 Output</h3>
            <OutputPreview body={debugResult?.final_body as FH2Body | undefined} />
          </div>
        </div>
      </div>

      {/* FH2 API format reference */}
      <ApiFormatPanel />

      {/* Missing fields panel */}
      {activeSource && (
        <div className="border border-gray-200 rounded-xl bg-white p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Required Fields Status</h3>
          <MissingPanel
            missing={debugResult?.missing ?? (normalizedFields.length > 0 ? missing : undefined)}
            workflowUuid={liveWorkflowUuid}
            deviceIdField={liveDeviceIdField}
            hasDeviceGps={hasDeviceGps}
          />
        </div>
      )}
    </div>
  )
}
