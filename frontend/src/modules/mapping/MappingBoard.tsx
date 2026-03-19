/**
 * MappingBoard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Core 3-column visual mapping UI:
 *
 *  LEFT                CENTER                   RIGHT
 *  ──────────────      ──────────────────────   ──────────────────────
 *  Normalized fields   Mapping rows             FH2 JSON preview
 *  (from debug run)    src → target dropdown    (live, from debug/run)
 *
 * Workflow:
 * 1. User selects source + pastes sample payload
 * 2. Click "Load Fields" → POST /admin/debug/run → left panel populates
 * 3. User drags/selects mappings in center
 * 4. Click "Preview" → re-run debug with current mapping → right panel updates
 * 5. Click "Save" → POST /admin/mapping/set (converts visual mapping to legacy list format)
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Save, RefreshCw, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import { debugService, mappingService, sourceService } from '@/services'
import { useMappingStore, useSourceStore, useUIStore } from '@/store'
import { FieldList } from './components/FieldList'
import { MappingRow, FH2_TARGET_FIELDS } from './components/MappingRow'
import { OutputPreview } from './components/OutputPreview'
import { MissingPanel } from './components/MissingPanel'
import { FH2ConfigPanel } from './components/FH2ConfigPanel'
import { DevicePicker } from './components/DevicePicker'
import type { DebugResult, FH2Body, MappingConfig, MappingRow as MappingRowType } from '@/types'

// ─── Convert visual mapping  →  legacy MappingConfig ─────────────────────────
// Visual: { "event.name": "name", "device.id": "params.device_id" }
// Legacy: { mappings: [{ src: "$.event.name", dst: "name", type: "string", ... }] }

function visualToLegacy(
  visual: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

// ─── Auto-suggest: run name-similarity on all normalized fields ───────────────
function autoSuggestAll(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const s = (f: string) => f.toLowerCase()

  for (const f of fields) {
    const sf = s(f)
    if (sf.includes('lat'))                               result[f] = 'params.latitude'
    else if (sf.includes('lon') || sf.includes('lng'))    result[f] = 'params.longitude'
    else if (sf.includes('level') || sf.includes('severity')) result[f] = 'params.level'
    else if (sf.includes('desc') || sf.includes('message')) result[f] = 'params.desc'
    else if (sf.includes('creator') || sf.includes('operator') || sf.includes('pilot')) result[f] = 'params.creator'
    else if ((sf.includes('name') || sf.includes('event')) && !sf.includes('device')) result[f] = 'name'
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

  // In wizard mode, always use wizardSourceId as the active source
  const activeSource = wizardSourceId || selected

  const {
    mapping, setMapping, setNormalizedFields, normalizedFields,
    setPreview, setMissing, missing,
    samplePayload, setSamplePayload,
  } = useMappingStore()

  const [debugResult, setDebugResult] = useState<DebugResult | null>(null)
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [showSampleEditor, setShowSampleEditor] = useState(false)

  // Load source list (not needed in wizard mode, but harmless)
  const { data: sources = [] } = useQuery({
    queryKey: ['sources'],
    queryFn: sourceService.list,
    enabled: !wizardSourceId,
  })

  // Load existing mapping from Redis on source change
  useQuery({
    queryKey: ['mapping', activeSource],
    queryFn: () => mappingService.get(activeSource),
    enabled: !!activeSource,
    onSuccess: (cfg: MappingConfig) => {
      // Convert legacy → visual mapping
      const visual: Record<string, string> = {}
      for (const row of cfg.mappings ?? []) {
        const src = row.src?.replace(/^\$\./, '')
        if (src && row.dst) visual[src] = row.dst
      }
      if (Object.keys(visual).length > 0) setMapping(visual)
    },
  } as Parameters<typeof useQuery>[0])

  // Debug run mutation
  const { mutate: runDebug, isPending: running } = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(samplePayload) } catch { parsed = {} }
      return debugService.run(activeSource, parsed)
    },
    onSuccess: (result) => {
      setDebugResult(result)
      if (result.normalized_fields) {
        setNormalizedFields(result.normalized_fields)
      }
      if (result.final_body) {
        setPreview(result.final_body as FH2Body)
      }
      if (result.missing) {
        setMissing(result.missing)
      }
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // Save mapping mutation
  const { mutate: saveMapping, isPending: saving } = useMutation({
    mutationFn: () => {
      const legacy = visualToLegacy(mapping, normalizedFields)
      return mappingService.set(activeSource, legacy)
    },
    onSuccess: () => {
      addToast('success', 'Mapping saved to Redis')
      qc.invalidateQueries({ queryKey: ['mapping', activeSource] })
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // Auto-suggest all fields
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

  // Compute center panel: show all normalized fields
  const allFields = normalizedFields.length > 0
    ? normalizedFields
    : Object.keys(mapping)

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* ── Top bar: source selector + actions ─────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Source: locked badge in wizard mode, dropdown otherwise */}
        {wizardSourceId ? (
          <span className="inline-flex items-center gap-2 px-3 py-2 text-sm font-mono bg-brand-50 border border-brand-200 rounded-lg text-brand-800">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
            {wizardSourceId}
          </span>
        ) : (
          <select
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">— select source —</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

        {/* Sample payload toggle */}
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-2 transition-colors"
          onClick={() => setShowSampleEditor(!showSampleEditor)}
        >
          {showSampleEditor
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronRight className="w-3.5 h-3.5" />}
          Sample Payload
        </button>

        {/* Load fields */}
        <button
          type="button"
          onClick={() => runDebug()}
          disabled={!selected || running}
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
          disabled={!selected || saving || Object.keys(mapping).length === 0}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors ml-auto"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Saving…' : 'Save Mapping'}
        </button>
      </div>

      {/* Sample payload editor (collapsible) */}
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
      {activeSource && <FH2ConfigPanel sourceId={activeSource} />}

      {/* Device GPS fallback panel */}
      {activeSource && <DevicePicker sourceId={activeSource} />}

      {/* ── 3-column mapping board ──────────────────────────────────────── */}
      <div className="grid grid-cols-[220px_1fr_300px] gap-4 flex-1 min-h-0">

        {/* LEFT — normalized field list */}
        <div className="border border-gray-200 rounded-xl bg-white p-3 flex flex-col min-h-0 max-h-[600px]">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Input Fields
          </h3>
          <FieldList
            fields={allFields}
            selectedField={selectedField}
            onSelect={setSelectedField}
          />
        </div>

        {/* CENTER — mapping rows */}
        <div className="border border-gray-200 rounded-xl bg-white p-3 flex flex-col min-h-0 max-h-[600px]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Field Mapping
            </h3>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="text-emerald-600 font-medium">{Object.keys(mapping).length}</span>
              <span>/ {allFields.length} mapped</span>
              {Object.keys(mapping).length > 0 && (
                <button
                  type="button"
                  onClick={() => setMapping({})}
                  className="text-red-400 hover:text-red-600 transition-colors"
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
                <MappingRow
                  key={f}
                  srcField={f}
                  targetField={mapping[f] ?? ''}
                />
              ))
            )}
          </div>
        </div>

        {/* RIGHT — output preview */}
        <div className="border border-gray-200 rounded-xl bg-white p-3 flex flex-col min-h-0 max-h-[600px]">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            FH2 Output
          </h3>
          <OutputPreview body={debugResult?.final_body as FH2Body | undefined} />
        </div>
      </div>

      {/* Missing fields panel */}
      {(missing.length > 0 || normalizedFields.length > 0) && activeSource && (
        <div className="border border-gray-200 rounded-xl bg-white p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Required Fields Status
          </h3>
          <MissingPanel missing={debugResult?.missing ?? missing} />
        </div>
      )}
    </div>
  )
}
