/**
 * IntegrationTest.tsx  —  Wizard Step 5
 *
 * Two-panel layout:
 *  LEFT  — test form (token + sample payload) + queue status
 *  RIGHT — debug/run pipeline preview showing the exact FH2 API body
 *          that would be sent, plus per-stage breakdown
 */
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation } from '@tanstack/react-query'
import { runIntegrationTest, debugService } from '@/services'
import { Card } from '@/components/ui/Card'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import {
  CheckCircle, XCircle, FlaskConical, Play,
  ChevronDown, ChevronRight, Copy, CheckCheck,
  AlertTriangle, Info,
} from 'lucide-react'
import type { TestResult } from '@/services'
import type { DebugResult, FH2Body } from '@/types'

// ─── syntax highlighter ──────────────────────────────────────────────────────
function highlight(json: string) {
  return json
    .replace(/(".*?")\s*:/g, '<span class="text-blue-300">$1</span>:')
    .replace(/:\s*(".*?")/g, ': <span class="text-emerald-300">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-amber-300">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="text-purple-300">$1</span>')
}

// ─── collapsible stage row ────────────────────────────────────────────────────
function StageBlock({
  label, data, accent = 'gray',
}: {
  label: string
  data: unknown
  accent?: 'gray' | 'blue' | 'emerald' | 'amber'
}) {
  const [open, setOpen] = useState(false)
  const json = JSON.stringify(data, null, 2)
  const accentMap = {
    gray:    'border-gray-200 bg-gray-50 text-gray-600',
    blue:    'border-blue-200 bg-blue-50 text-blue-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber:   'border-amber-200 bg-amber-50 text-amber-700',
  }
  return (
    <div className={`border rounded-lg overflow-hidden ${accentMap[accent]}`}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:opacity-80 transition-opacity"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        {label}
        <span className="ml-auto font-normal opacity-60">
          {typeof data === 'object' && data !== null ? `${Object.keys(data).length} keys` : ''}
        </span>
      </button>
      {open && (
        <pre className="text-xs font-mono bg-gray-900 text-gray-200 px-3 py-2 overflow-x-auto max-h-48 leading-relaxed">
          {json}
        </pre>
      )}
    </div>
  )
}

// ─── FH2 body preview panel ───────────────────────────────────────────────────
function FH2Preview({ body, missing }: { body: FH2Body | undefined; missing?: string[] }) {
  const [copied, setCopied] = useState(false)

  if (!body) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm gap-2">
        <Play className="w-4 h-4 opacity-40" />
        运行 Pipeline Preview 后显示报文
      </div>
    )
  }

  const json = JSON.stringify(body, null, 2)
  const hasMissing = missing && missing.length > 0

  const copy = () => {
    navigator.clipboard.writeText(json)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Missing fields warning */}
      {hasMissing && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            <strong>缺少必填字段：</strong>
            {missing.map((f) => (
              <code key={f} className="mx-0.5 bg-amber-100 px-1 rounded font-mono">{f}</code>
            ))}
          </span>
        </div>
      )}
      {!hasMissing && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700">
          <CheckCircle className="w-3.5 h-3.5 shrink-0" />
          所有必填字段已覆盖，报文可正常发送
        </div>
      )}

      {/* JSON body */}
      <div className="flex-1 min-h-0 rounded-xl bg-gray-900 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
          <span className="text-xs text-gray-400 font-mono">POST /openapi/v0.1/workflow</span>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
          >
            {copied
              ? <><CheckCheck className="w-3 h-3 text-emerald-400" /> Copied</>
              : <><Copy className="w-3 h-3" /> Copy</>}
          </button>
        </div>
        <pre
          className="flex-1 overflow-auto p-3 text-xs font-mono leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlight(json) }}
        />
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface FormValues {
  ingressToken: string
  webhookEventJson: string
}

const SAMPLE_EVENT = JSON.stringify({
  timestamp: '2026-03-18T10:00:00Z',
  creator_id: 'pilot01',
  latitude: 22.543096,
  longitude: 114.057865,
  level: 'warning',
  description: 'Obstacle detected ahead',
}, null, 2)

export function IntegrationTest({ sourceId }: { sourceId: string }) {
  const [queueResult, setQueueResult] = useState<TestResult | null>(null)
  const [debugResult, setDebugResult] = useState<DebugResult | null>(null)

  const { register, handleSubmit, watch, formState: { errors } } = useForm<FormValues>({
    defaultValues: { ingressToken: '', webhookEventJson: SAMPLE_EVENT },
  })

  // ── Debug/run — preview pipeline without enqueuing ────────────────────────
  const { mutate: runPreview, isPending: previewing } = useMutation({
    mutationFn: async (payload: string) => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(payload) } catch { /**/ }
      return debugService.run(sourceId, parsed)
    },
    onSuccess: setDebugResult,
  })

  // ── Actual integration test — send through webhook ────────────────────────
  const { mutate: runTest, isPending: testing } = useMutation({
    mutationFn: (d: FormValues) => {
      const webhookEvent = JSON.parse(d.webhookEventJson) as Record<string, unknown>
      return runIntegrationTest({ sourceId, ingressToken: d.ingressToken, webhookEvent })
    },
    onSuccess: setQueueResult,
  })

  const payloadVal = watch('webhookEventJson')

  return (
    <div className="grid grid-cols-[1fr_1fr] gap-5 min-h-0">

      {/* ── LEFT: form + queue result ──────────────────────────────────────── */}
      <div className="space-y-4">
        <Card title="Integration Test" description="发送测试事件并检查 Pipeline 全流程">
          <div className="space-y-4">
            <Input
              label="Ingress Token (X-MW-Token)"
              placeholder="Step 2 中配置的 token"
              error={errors.ingressToken?.message}
              {...register('ingressToken', { required: 'Required' })}
            />
            <Textarea
              label="Sample webhook_event (JSON)"
              rows={9}
              mono
              error={errors.webhookEventJson?.message}
              {...register('webhookEventJson', {
                validate: (v) => {
                  try { JSON.parse(v); return true }
                  catch { return 'Invalid JSON' }
                },
              })}
            />

            <div className="flex items-center gap-3 flex-wrap">
              {/* Preview pipeline (no enqueue) */}
              <Button
                type="button"
                variant="secondary"
                loading={previewing}
                onClick={() => runPreview(payloadVal)}
                disabled={!sourceId}
              >
                <Play className="w-4 h-4" />
                Pipeline Preview
              </Button>

              {/* Full test (enqueue) */}
              <Button
                type="button"
                loading={testing}
                onClick={handleSubmit((d) => runTest(d))}
              >
                <FlaskConical className="w-4 h-4" /> Send & Test
              </Button>
            </div>
          </div>
        </Card>

        {/* Queue result */}
        {queueResult && (
          <Card title="Webhook 入队结果">
            <div className="space-y-2">
              <ResultRow
                ok={queueResult.authStatus === 200}
                label="Ingress Auth Gate"
                detail={`HTTP ${queueResult.authStatus}`}
              />
              <ResultRow
                ok={queueResult.queueAccepted}
                label="Enqueued to Redis Stream"
                detail={queueResult.queueAccepted ? 'accepted' : 'rejected'}
              />
              {queueResult.error && (
                <pre className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono whitespace-pre-wrap">
                  {queueResult.error}
                </pre>
              )}
              {queueResult.queueAccepted && (
                <div className="mt-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="text-emerald-700 font-medium">
                    事件已入队 — Worker 将完成映射并推送至 FlightHub2
                  </span>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Pipeline stages breakdown */}
        {debugResult && (
          <Card title="Pipeline 各阶段数据">
            <div className="space-y-2">
              <StageBlock label="① Raw (原始 payload)"        data={debugResult.raw}        accent="gray" />
              <StageBlock label="② Flat (展开后)"             data={debugResult.flat}       accent="gray" />
              <StageBlock label="③ Normalized (规范化)"       data={debugResult.normalized}  accent="blue" />
              <StageBlock label="④ Mapped (字段映射结果)"     data={debugResult.mapped}      accent="blue" />
              <StageBlock label="⑤ Event (规范事件)"          data={debugResult.event}       accent="amber" />
            </div>
            {debugResult.message && (
              <div className="mt-3 flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {debugResult.message}
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ── RIGHT: FH2 API body preview ────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3 min-h-[480px]">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <h3 className="text-sm font-semibold text-gray-800">最终 FH2 API 报文</h3>
            <span className="text-xs text-gray-400 ml-auto">
              {debugResult
                ? <span className="text-emerald-600 font-medium">✓ 预览已生成</span>
                : '点击 Pipeline Preview 生成'}
            </span>
          </div>

          {/* hint before first run */}
          {!debugResult && (
            <div className="flex items-start gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              点击左侧 <strong>Pipeline Preview</strong> 按钮，即可在此处看到 Worker 最终会发送给 FlightHub2 的完整 HTTP 请求体。
              无需提供 Ingress Token，不会入队。
            </div>
          )}

          <div className="flex-1 min-h-0">
            <FH2Preview
              body={debugResult?.final_body}
              missing={debugResult?.missing}
            />
          </div>
        </div>

        {/* HTTP headers reference */}
        {debugResult?.final_body && (
          <div className="bg-gray-900 rounded-xl p-4 text-xs font-mono space-y-1">
            <p className="text-gray-400 mb-2 font-sans font-semibold text-xs">HTTP Headers (来自 Egress 配置)</p>
            <p><span className="text-blue-300">Content-Type</span>: <span className="text-emerald-300">application/json</span></p>
            <p><span className="text-blue-300">X-User-Token</span>: <span className="text-gray-500">{'<configured>'}</span></p>
            <p><span className="text-blue-300">x-project-uuid</span>: <span className="text-gray-500">{'<configured>'}</span></p>
          </div>
        )}
      </div>
    </div>
  )
}

function ResultRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">
      {ok
        ? <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
        : <XCircle     className="w-4 h-4 text-red-500 shrink-0" />}
      <span className="flex-1 text-sm text-gray-700">{label}</span>
      <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${ok
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-red-100 text-red-700'}`}>
        {detail}
      </span>
    </div>
  )
}
