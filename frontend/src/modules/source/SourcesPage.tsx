import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sourceService } from '@/services'
import { useSourceStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { SourceCreateForm, SourceAuthForm, WebhookURL, SourceSelector } from '@/modules/source/SourceForm'

export default function SourcesPage() {
  const { setSources, selected } = useSourceStore()
  const { addToast } = useUIStore()
  const qc = useQueryClient()

  useQuery({
    queryKey: ['sources'],
    queryFn: sourceService.list,
    onSuccess: setSources,
  } as Parameters<typeof useQuery>[0])

  const { mutate: deleteSource } = useMutation({
    mutationFn: (id: string) => sourceService.delete(id),
    onSuccess: (_data, id) => {
      addToast('success', `Source "${id}" deleted`)
      qc.invalidateQueries({ queryKey: ['sources'] })
      // clear selection if deleted the selected one
      if (useSourceStore.getState().selected === id) {
        useSourceStore.getState().setSelected('')
      }
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Sources</h1>
      <SourceCreateForm />

      {selected && (
        <>
          <WebhookURL sourceId={selected} />
          <SourceAuthForm sourceId={selected} />
        </>
      )}

      <Card title="Select Source to Configure">
        <SourceSelector onDelete={deleteSource} />
      </Card>
    </div>
  )
}
