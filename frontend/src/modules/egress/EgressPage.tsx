import { useNavigate } from 'react-router-dom'
import { useSourceStore } from '@/store'
import { Button } from '@/components/ui/Button'
import { Layers } from 'lucide-react'
import { EgressConfigPanel } from '@/modules/egress/EgressConfigPanel'

export default function EgressPage() {
  const { selected } = useSourceStore()
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Egress Configuration</h1>
        <p className="text-sm text-gray-500 mt-1">
          Configure the FlightHub2 downstream API endpoint, credentials, and retry policy.
          {selected && (
            <span className="ml-2 inline-flex items-center gap-1 text-brand-600 font-medium">
              — {selected}
            </span>
          )}
        </p>
      </div>

      {selected ? (
        <EgressConfigPanel sourceId={selected} />
      ) : (
        /* No source selected — clear call-to-action */
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-16 flex flex-col items-center gap-4 text-center">
          <Layers className="w-10 h-10 text-gray-300" />
          <div>
            <p className="text-sm font-medium text-gray-600">No source selected</p>
            <p className="text-xs text-gray-400 mt-1">
              Select an active source in the sidebar, or go to Sources to create one.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate('/sources')}>
            <Layers className="w-4 h-4" /> Go to Sources
          </Button>
        </div>
      )}
    </div>
  )
}
