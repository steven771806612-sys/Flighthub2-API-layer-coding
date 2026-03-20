import { useEffect, useState, useRef } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  sourceService, authService, mappingService, egressService, debugService,
} from '@/services'
import { useSourceStore, useWizardStore } from '@/store'
import { Card, Badge } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import {
  Zap, ArrowRight, CheckCircle, AlertCircle, XCircle, Layers,
  ChevronDown, ChevronUp, Play, Copy, CheckCheck, AlertTriangle,
  RefreshCw, Eye,
} from 'lucide-react'
import type { StepStatus, SourcePipeline, DebugResult, FH2Body } from '@/types'

// ─── JSON syntax highlight ────────────────────────────────────────────────────
function highlight(json: string): string {
  return json
    .replace(/(".*?")\s*:/g, '<span class="text-blue-300">$1</span>:')
    .replace(/:\s*(".*?")/g, ': <span class="text-emerald-300">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-amber-300">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="text-purple-300">$1</span>')
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusBadge(s: StepStatus) {
  if (s === 'ok')   return <Badge variant="green">✓ OK</Badge>
  if (s === 'warn') return <Badge variant="yellow">⚠ Partial</Badge>
  return                   <Badge variant="red">✗ Missing</Badge>
}

function statusIcon(s: StepStatus) {
  if (s === 'ok')   return <CheckCircle className="w-4 h-4 text-emerald-500" />
  if (s === 'warn') return <AlertCircle className="w-4 h-4 text-amber-500" />
  return                   <XCircle     className="w-4 h-4 text-red-400" />
}

// ─── Default sample payload used for quick preview ───────────────────────────
const DEFAULT_SAMPLE: Record<string, unknown> = {
  timestamp:   '2026-03-18T10:00:00Z',
  creator_id:  'pilot01',
  latitude:    22.543096,
  longitude:   114.057865,
  level:       'warning',
  description: 'Obstacle detected ahead',
}

// ─── Inline API Preview Panel ─────────────────────────────────────────────────
function ApiPreviewPanel({ sourceId }: { sourceId: string }) {
  const [result, setResult]   = useState<DebugResult | null>(null)
  const [copied, setCopied]   = useState(false)
  const [payload, setPayload] = useState(JSON.stringify(DEFAULT_SAMPLE, null, 2))
  const [editing, setEditing] = useState(false)
  const textareaRef           = useRef<HTMLTextAreaElement>(null)

  const { mutate: runPreview, isPending } = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(payload) } catch { parsed = DEFAULT_SAMPLE }
      return debugService.run(sourceId, parsed)
    },
    onSuccess: (r) => setResult(r),
  })

  const finalBody: FH2Body | undefined = result?.final_body as FH2Body | undefined
  const missing: string[]              = result?.missing ?? []
  const bodyJson: string | null        = finalBody ? JSON.stringify(finalBody, null, 2) : null

  const copyBody = () => {
    if (!bodyJson) return
    navigator.clipboard.writeText(bodyJson).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="border-t border-gray-100 mt-3 pt-3 space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-gray-500 flex items-center gap-1">
          <Eye className="w-3.5 h-3.5" /> 实时 API 输出预览
        </span>

        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
            editing
              ? 'border-brand-400 text-brand-600 bg-brand-50'
              : 'border-gray-300 text-gray-500 hover:border-gray-400'
          }`}
        >
          {editing ? '收起 Payload' : '编辑 Payload'}
        </button>

        <Button
          size="sm"
          variant="secondary"
          loading={isPending}
          onClick={() => runPreview()}
          className="ml-auto"
        >
          {isPending
            ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            : <Play className="w-3.5 h-3.5" />}
          {result ? '重新运行' : '运行预览'}
        </Button>
      </div>

      {/* Editable payload area */}
      {editing && (
        <textarea
          ref={textareaRef}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          className="w-full text-xs font-mono bg-gray-950 text-gray-200 border border-gray-700 rounded-lg p-3 resize-y focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="输入 JSON payload…"
          spellCheck={false}
        />
      )}

      {/* Results: 两列并排 */}
      {result && (
        <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
          {/* FH2 body */}
          <div className="rounded-lg overflow-hidden border border-gray-700">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-900">
              <div className="flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-brand-400" />
                <span className="text-xs font-semibold text-gray-200">FH2 API 报文</span>
                {missing.length === 0 && finalBody && (
                  <span className="text-xs bg-emerald-900/60 text-emerald-400 border border-emerald-700/40 rounded-full px-2 py-0.5">
                    ✓ 字段完整
                  </span>
                )}
                {missing.length > 0 && (
                  <span className="text-xs bg-amber-900/60 text-amber-400 border border-amber-700/40 rounded-full px-2 py-0.5">
                    ⚠ {missing.length} 缺失
                  </span>
                )}
              </div>
              {bodyJson && (
                <button
                  type="button"
                  onClick={copyBody}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {copied
                    ? <><CheckCheck className="w-3.5 h-3.5 text-emerald-400" /> Copied</>
                    : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                </button>
              )}
            </div>

            {/* Body */}
            <div className="bg-gray-950 min-h-[80px]">
              {result.status === 'error' && (
                <p className="text-xs text-red-400 font-mono p-3">{result.message}</p>
              )}
              {bodyJson && (
                <pre
                  className="text-xs font-mono leading-relaxed p-3 overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: highlight(bodyJson) }}
                />
              )}
              {!bodyJson && result.status === 'ok' && (
                <p className="text-xs text-gray-500 p-3 font-mono">暂无输出（检查映射配置）</p>
              )}
            </div>

            {/* Missing list */}
            {missing.length > 0 && (
              <div className="px-3 py-2 border-t border-gray-800 bg-gray-950 flex flex-wrap gap-1 items-center">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                {missing.map((f) => (
                  <span
                    key={f}
                    className="text-xs font-mono text-amber-300 bg-amber-900/30 border border-amber-700/40 rounded px-1.5 py-0.5"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Pipeline stage mini-summary */}
          {result.status === 'ok' && (
            <div className="shrink-0 w-44 space-y-1.5">
              <MiniStage label="① raw"        ok={!!result.raw}        count={Object.keys(result.raw ?? {}).length} />
              <MiniStage label="② flat"       ok={!!result.flat}       count={Object.keys(result.flat ?? {}).length} />
              <MiniStage label="③ normalized" ok={!!result.normalized} count={Object.keys(result.normalized ?? {}).length} />
              <MiniStage label="④ mapped"     ok={!!result.mapped}     count={Object.keys(result.mapped ?? {}).length} />
              <MiniStage label="⑤ final_body" ok={!!result.final_body} count={result.final_body ? Object.keys(result.final_body).length : 0} highlight />
            </div>
          )}
        </div>
      )}

      {/* Idle state */}
      {!result && !isPending && (
        <div className="flex items-center justify-center h-12 text-gray-400 gap-2 border border-dashed border-gray-200 rounded-lg">
          <Play className="w-4 h-4 opacity-40" />
          <span className="text-xs">点击「运行预览」查看最终 FH2 报文</span>
        </div>
      )}
    </div>
  )
}

function MiniStage({
  label, ok, count, highlight: hl = false,
}: { label: string; ok: boolean; count: number; highlight?: boolean }) {
  return (
    <div className={`flex items-center justify-between text-xs rounded px-2 py-1 ${
      hl
        ? 'bg-brand-50 border border-brand-200 text-brand-700'
        : 'bg-gray-50 border border-gray-200 text-gray-600'
    }`}>
      <span className="font-mono">{label}</span>
      <span className={`font-semibold ${ok ? (hl ? 'text-brand-600' : 'text-emerald-600') : 'text-gray-400'}`}>
        {ok ? `${count}k` : '–'}
      </span>
    </div>
  )
}

// ─── Pipeline Card (with expandable preview) ──────────────────────────────────
function PipelineCard({
  p, onConfigure,
}: { p: SourcePipeline; onConfigure: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false)

  const overallStatus: StepStatus =
    p.steps.every(s => s.status === 'ok')      ? 'ok'      :
    p.steps.some(s => s.status === 'missing')  ? 'missing' : 'warn'

  return (
    <Card>
      {/* Main row */}
      <div className="flex items-center gap-4">
        {/* Source ID */}
        <div className="w-32 shrink-0">
          <span className="font-mono text-sm font-semibold text-gray-800">{p.sourceId}</span>
        </div>

        {/* Pipeline steps */}
        <div className="flex-1 flex items-center gap-2">
          {p.steps.map((step, i) => (
            <div key={step.label} className="flex items-center gap-2">
              <div className="flex flex-col items-center gap-0.5">
                <div className="flex items-center gap-1">
                  {statusIcon(step.status)}
                  <span className="text-xs font-medium text-gray-600">{step.label}</span>
                </div>
                {step.detail && (
                  <span className="text-xs text-gray-400 font-mono truncate max-w-[100px]">
                    {step.detail}
                  </span>
                )}
              </div>
              {i < p.steps.length - 1 && (
                <ArrowRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />
              )}
            </div>
          ))}
        </div>

        {/* Status badge */}
        <div>{statusBadge(overallStatus)}</div>

        {/* Preview toggle */}
        <button
          type="button"
          onClick={() => setPreviewOpen(!previewOpen)}
          className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-all ${
            previewOpen
              ? 'border-brand-400 bg-brand-50 text-brand-600'
              : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-700'
          }`}
          title="实时 API 输出预览"
        >
          <Eye className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">API 预览</span>
          {previewOpen
            ? <ChevronUp   className="w-3 h-3" />
            : <ChevronDown className="w-3 h-3" />}
        </button>

        {/* Configure */}
        <Button variant="ghost" size="sm" onClick={onConfigure}>
          Configure <ArrowRight className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Expandable preview panel */}
      {previewOpen && <ApiPreviewPanel sourceId={p.sourceId} />}
    </Card>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export function Dashboard() {
  const navigate = useNavigate()
  const { setSources, sources } = useSourceStore()
  const { startWizard } = useWizardStore()

  const { isLoading, data: sourceListData } = useQuery({
    queryKey: ['sources'],
    queryFn: sourceService.list,
    staleTime: 0,
  })

  useEffect(() => {
    if (sourceListData) setSources(sourceListData)
  }, [sourceListData, setSources])

  // Per-source pipeline health
  const pipelineQueries = useQuery({
    queryKey: ['pipeline-health', sources],
    enabled: sources.length > 0,
    queryFn: async (): Promise<SourcePipeline[]> => {
      return Promise.all(
        sources.map(async (id) => {
          const [auth, mapping, egress] = await Promise.allSettled([
            authService.get(id),
            mappingService.get(id),
            egressService.get(id),
          ])

          const authCfg = auth.status    === 'fulfilled' ? auth.value    : null
          const mapCfg  = mapping.status === 'fulfilled' ? mapping.value : null
          const egsCfg  = egress.status  === 'fulfilled' ? egress.value  : null

          const authStatus: StepStatus =
            authCfg?.enabled && authCfg?.token ? 'ok' :
            authCfg ? 'warn' : 'missing'

          const mapStatus: StepStatus =
            (mapCfg?.mappings?.length ?? 0) > 0 ? 'ok' : 'missing'

          const egsStatus: StepStatus =
            egsCfg?.endpoint
              ? (egsCfg.headers?.['X-User-Token'] ? 'ok' : 'warn')
              : 'missing'

          return {
            sourceId: id,
            steps: [
              { label: 'Source',  status: 'ok'       as StepStatus },
              { label: 'Auth',    status: authStatus,  detail: authCfg?.header_name },
              { label: 'Mapping', status: mapStatus,   detail: `${mapCfg?.mappings?.length ?? 0} rules` },
              { label: 'Egress',  status: egsStatus,   detail: egsCfg?.endpoint?.slice(8, 40) },
            ],
          }
        }),
      )
    },
  })

  const pipelines: SourcePipeline[] = (pipelineQueries.data as SourcePipeline[] | undefined) ?? []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            FlightHub Webhook Transformer — DJI FlightHub2
          </p>
        </div>
        <Button onClick={() => { startWizard(); navigate('/wizard') }}>
          <Zap className="w-4 h-4" /> New Integration
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          label="Total Sources"
          value={sources.length}
          icon={<Layers className="w-5 h-5 text-brand-500" />}
        />
        <StatCard
          label="Healthy Pipelines"
          value={pipelines.filter(p => p.steps.every(s => s.status !== 'missing')).length}
          icon={<CheckCircle className="w-5 h-5 text-emerald-500" />}
        />
        <StatCard
          label="Needs Attention"
          value={pipelines.filter(p => p.steps.some(s => s.status === 'missing')).length}
          icon={<AlertCircle className="w-5 h-5 text-amber-500" />}
        />
      </div>

      {/* Pipeline cards */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-800">Integration Pipelines</h2>
          {pipelines.length > 0 && (
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Eye className="w-3.5 h-3.5" />
              点击「API 预览」可实时查看最终输出报文
            </span>
          )}
        </div>

        {isLoading && <p className="text-sm text-gray-400">Loading…</p>}

        {!isLoading && sources.length === 0 && (
          <Card>
            <div className="text-center py-12">
              <Zap className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No integrations yet</p>
              <Button className="mt-4" onClick={() => { startWizard(); navigate('/wizard') }}>
                Create your first integration
              </Button>
            </div>
          </Card>
        )}

        <div className="space-y-3">
          {pipelines.map((p) => (
            <PipelineCard
              key={p.sourceId}
              p={p}
              onConfigure={() => { startWizard(p.sourceId); navigate('/wizard') }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({
  label, value, icon,
}: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center border border-gray-200">
          {icon}
        </div>
        <div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          <p className="text-xs text-gray-500">{label}</p>
        </div>
      </div>
    </Card>
  )
}

import type React from 'react'
