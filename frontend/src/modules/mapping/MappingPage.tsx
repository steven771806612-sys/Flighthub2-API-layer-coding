import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Layers } from 'lucide-react'
import { MappingBoard } from '@/modules/mapping/MappingBoard'
import { useMappingStore, useSourceStore } from '@/store'
import { Button } from '@/components/ui/Button'

/**
 * MappingPage
 * ─────────────────────────────────────────────────────────────────────────────
 * Wraps MappingBoard with:
 *   • No-source guard: shows a call-to-action if no source is selected.
 *   • beforeunload guard: warns browser on refresh/close if mapping is dirty.
 *     (In-app navigation warning is handled by MappingBoard's isDirty badge;
 *      a full blocking router guard is omitted to avoid heavy complexity.)
 */
export default function MappingPage() {
  const { selected } = useSourceStore()
  const { isDirty } = useMappingStore()
  const navigate = useNavigate()

  // Bind browser beforeunload — fires on tab close / refresh only
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return
      e.preventDefault()
      e.returnValue = '映射草稿未保存，离开将丢失更改。'
      return e.returnValue
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Visual Field Mapper</h1>
        <p className="text-sm text-gray-500 mt-1">
          Map normalized input fields to FlightHub2 workflow body fields.
          Click <strong>Load Fields &amp; Preview</strong> to see your data flow end-to-end.
          {selected && (
            <span className="ml-2 inline-flex items-center gap-1 text-brand-600 font-medium text-xs">
              — {selected}
              {isDirty && (
                <span className="inline-flex items-center gap-1 ml-1 text-amber-600">
                  <AlertTriangle className="w-3 h-3" />
                  草稿未保存
                </span>
              )}
            </span>
          )}
        </p>
      </div>

      {/* No-source guard */}
      {!selected ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-16 flex flex-col items-center gap-4 text-center">
          <Layers className="w-10 h-10 text-gray-300" />
          <div>
            <p className="text-sm font-medium text-gray-600">未选择 Source</p>
            <p className="text-xs text-gray-400 mt-1">
              请在左侧边栏切换 Source，或前往 Sources 页面创建一个。
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate('/sources')}>
            <Layers className="w-4 h-4" /> Go to Sources
          </Button>
        </div>
      ) : (
        <MappingBoard />
      )}
    </div>
  )
}
