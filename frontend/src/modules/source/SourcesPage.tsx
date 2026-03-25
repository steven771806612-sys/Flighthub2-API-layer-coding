import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sourceService } from '@/services'
import { useSourceStore, useMappingStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { SourceCreateForm, SourceAuthForm, WebhookURL, SourceSelector } from '@/modules/source/SourceForm'

export default function SourcesPage() {
  const { setSources, selected, setSelected } = useSourceStore()
  const { switchSource } = useMappingStore()
  const { addToast } = useUIStore()
  const qc = useQueryClient()

  const { data: sourceList } = useQuery({
    queryKey: ['sources'],
    queryFn: sourceService.list,
    staleTime: 30_000,    // cache 30s — manual invalidate after create/delete
  })

  useEffect(() => {
    if (sourceList) setSources(sourceList)
  }, [sourceList, setSources])

  const { mutate: deleteSource } = useMutation({
    mutationFn: (id: string) => sourceService.delete(id),
    onSuccess: (_data, id) => {
      addToast('success', `Source "${id}" deleted`)
      qc.invalidateQueries({ queryKey: ['sources'] })
      if (useSourceStore.getState().selected === id) {
        useSourceStore.getState().setSelected('')
        useMappingStore.getState().switchSource('')
      }
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  /** Called by SourceCreateForm after a successful create — auto-select the new source */
  const handleCreated = (id: string) => {
    setSelected(id)
    switchSource(id)
    qc.invalidateQueries({ queryKey: ['sources'] })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Sources</h1>
        <p className="text-sm text-gray-500 mt-1">
          Create a source to get a webhook ingress endpoint, then configure auth and proceed to mapping.
          {selected && (
            <span className="ml-2 inline-flex items-center gap-1 text-brand-600 font-medium text-xs">
              — 当前 Source：<code className="font-mono">{selected}</code>
            </span>
          )}
        </p>
      </div>

      {/* Step 1 — Create */}
      <SourceCreateForm onCreated={handleCreated} />

      {/* Step 2 — Select (if multiple) */}
      <Card
        title="Active Source"
        description="Select the source you want to configure"
      >
        <SourceSelector onDelete={deleteSource} />
      </Card>

      {/* Step 3 — Configure (only when a source is selected) */}
      {selected ? (
        <div className="space-y-4">
          <WebhookURL sourceId={selected} />
          <SourceAuthForm sourceId={selected} />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-10 text-center text-sm text-gray-400">
          Select a source above to view its webhook URL and configure ingress authentication.
        </div>
      )}
    </div>
  )
}
