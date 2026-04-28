/**
 * LogsPage.tsx — Dual-tab log viewer
 *
 * Tab 1 – Ingest Logs  : every HTTP POST that arrived at /webhook
 *                         (accepted OR rejected), with rejection reason
 * Tab 2 – Processing Logs : worker→FlightHub2 push results
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { logService, ingestLogService } from '@/services'
import { useSourceStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import {
  RefreshCw, Trash2, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronRight, Clock, Activity, Filter,
  ArrowDownToLine, Zap, Copy, Check, ExternalLink,
} from 'lucide-react'
import type { ProcessingLog, IngestLog } from '@/services'

// ─── Shared helpers ───────────────────────────────────────────────────────────
function fmtTs(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

function httpBadge(status: number) {
  if (status >= 200 && status < 300)
    return <span className="px-1.5 py-0.5 text-xs font-mono rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">{status}</span>
  if (status === 0)
    return <span className="px-1.5 py-0.5 text-xs font-mono rounded-full bg-gray-100 text-gray-500 border border-gray-200">–</span>
  return <span className="px-1.5 py-0.5 text-xs font-mono rounded-full bg-red-100 text-red-700 border border-red-200">{status}</span>
}

// ─── Webhook URL banner ───────────────────────────────────────────────────────
// Always shown at the top of the Ingest Logs tab so operators can quickly copy
// the URL and send it to whoever runs the third-party system.
function WebhookUrlBanner() {
  const [copied, setCopied] = useState(false)
  const url = typeof window !== 'undefined' ? `${window.location.origin}/webhook` : '/webhook'

  const copy = () => {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-xl border-2 border-blue-300 bg-blue-50 overflow-hidden">
      {/* Blue header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-600">
        <ExternalLink className="w-4 h-4 text-white shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm leading-none">Webhook Ingest URL</p>
          <p className="text-blue-200 text-xs mt-0.5">
            Third-party systems must POST to this URL — every request will be logged below
          </p>
        </div>
        <span className="text-xs font-mono font-bold bg-white/20 text-white px-2 py-1 rounded-full shrink-0">
          POST
        </span>
      </div>

      {/* URL row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <code className="flex-1 text-sm font-mono text-blue-900 break-all select-all">{url}</code>
        <button
          onClick={copy}
          className="shrink-0 flex items-center gap-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {copied
            ? <><Check className="w-3.5 h-3.5" />Copied</>
            : <><Copy  className="w-3.5 h-3.5" />Copy URL</>}
        </button>
      </div>

      {/* Body hint */}
      <div className="border-t border-blue-200 px-4 py-2.5 bg-white/60">
        <p className="text-xs text-blue-700">
          <span className="font-semibold">Required JSON body: </span>
          <code className="bg-blue-100 px-1.5 py-0.5 rounded font-mono">
            {'{ "source": "<source-id>", "webhook_event": { ... } }'}
          </code>
        </p>
      </div>
    </div>
  )
}

// ─── Tab 1: Ingest Log row ────────────────────────────────────────────────────
function IngestRow({ log }: { log: IngestLog }) {
  const [open, setOpen] = useState(false)

  const isAccepted = log.result === 'accepted'
  const isRejected = log.result === 'rejected'
  const hasHeaders = log.request_headers && Object.keys(log.request_headers).length > 0
  const hasReason  = !!log.reject_reason

  const resultBadge = isAccepted
    ? <span className="px-1.5 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 shrink-0">accepted</span>
    : isRejected
      ? <span className="px-1.5 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 border border-red-200 shrink-0">rejected</span>
      : <span className="px-1.5 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 border border-amber-200 shrink-0">error</span>

  return (
    <div className={`border rounded-lg overflow-hidden ${isAccepted ? 'border-gray-200' : 'border-red-200'}`}>
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 ${
          isAccepted ? 'bg-white' : 'bg-red-50'
        }`}
      >
        {/* Icon */}
        {isAccepted
          ? <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
          : <XCircle     className="w-4 h-4 text-red-500 shrink-0" />}

        {/* Time */}
        <span className="text-xs text-gray-400 font-mono shrink-0 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {fmtTs(log.ts)}
        </span>

        {/* Source */}
        <span className="text-xs font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded shrink-0">
          {log.source || '—'}
        </span>

        {/* IP */}
        <span className="text-xs text-gray-400 font-mono shrink-0">{log.ip || '—'}</span>

        {/* Result badge */}
        {resultBadge}

        {/* HTTP status */}
        {httpBadge(log.status_code)}

        {/* Rejection reason (short) */}
        {isRejected && hasReason && (
          <span className="flex-1 text-xs text-red-600 truncate">
            {log.reject_reason}
          </span>
        )}
        {isAccepted && (
          <span className="flex-1 text-xs text-gray-400 truncate">
            body {log.body_size} bytes
          </span>
        )}

        {/* Expand arrow */}
        {(hasHeaders || hasReason) && (
          open
            ? <ChevronDown  className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        )}
      </button>

      {/* Detail panel */}
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2 space-y-2">

          {/* Rejection reason (full) */}
          {hasReason && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <strong>Rejection Reason: </strong>
                <span className="ml-1 break-all">{log.reject_reason}</span>
              </div>
            </div>
          )}

          {/* Request headers */}
          {hasHeaders && (
            <div>
              <p className="text-xs text-gray-500 mb-1 font-semibold">Request Headers:</p>
              <div className="font-mono text-xs bg-gray-900 text-gray-200 rounded-lg px-3 py-2 space-y-0.5 overflow-x-auto">
                {Object.entries(log.request_headers).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-blue-300">{k}</span>
                    <span className="text-gray-400">: </span>
                    <span className={v === '***' ? 'text-amber-400' : 'text-gray-200'}>{v}</span>
                  </div>
                ))}
              </div>
              {Object.values(log.request_headers).some(v => v === '***') && (
                <p className="text-xs text-amber-600 mt-1">
                  <AlertTriangle className="w-3 h-3 inline mr-1" />
                  Headers marked <code className="bg-amber-100 px-1 rounded">***</code> were present but their values are masked for security.
                </p>
              )}
            </div>
          )}

          {/* Meta info */}
          <div className="flex flex-wrap gap-4 text-xs text-gray-400 font-mono">
            <span>method: <span className="text-gray-600">POST</span></span>
            <span>path: <span className="text-gray-600">{log.path}</span></span>
            <span>body_size: <span className="text-gray-600">{log.body_size} bytes</span></span>
            <span>ip: <span className="text-gray-600">{log.ip}</span></span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab 2: Processing Log row ────────────────────────────────────────────────
function ProcessingRow({ log }: { log: ProcessingLog }) {
  const [open, setOpen] = useState(false)
  const hasMissing  = log.missing_fields?.length > 0
  const hasResponse = !!log.fh2_response

  return (
    <div className={`border rounded-lg overflow-hidden ${log.ok ? 'border-gray-200' : 'border-red-200'}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 ${
          log.ok ? 'bg-white' : 'bg-red-50'
        }`}
      >
        {log.ok
          ? <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
          : <XCircle     className="w-4 h-4 text-red-500 shrink-0" />}

        <span className="text-xs text-gray-400 font-mono shrink-0 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {fmtTs(log.ts)}
        </span>

        <span className="text-xs font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded shrink-0">
          {log.source}
        </span>

        <span className="flex-1 text-xs text-gray-700 truncate font-medium">
          {log.body_name || <span className="text-gray-400 italic">unnamed</span>}
        </span>

        {httpBadge(log.http_status)}

        {hasMissing && (
          <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full shrink-0">
            <AlertTriangle className="w-3 h-3" />
            {log.missing_fields.length} missing
          </span>
        )}

        {(hasResponse || hasMissing) && (
          open
            ? <ChevronDown  className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2 space-y-2">
          <div className="flex flex-wrap gap-4 text-xs text-gray-400 font-mono">
            <span>msg_id: <span className="text-gray-600">{log.msg_id}</span></span>
            {log.workflow_uuid && (
              <span>workflow_uuid: <span className="text-gray-600">{log.workflow_uuid}</span></span>
            )}
          </div>

          {hasMissing && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <strong>Missing required fields: </strong>
                <span className="ml-1">{log.missing_fields.join(', ')}</span>
              </div>
            </div>
          )}

          {hasResponse && (
            <div>
              <p className="text-xs text-gray-500 mb-1 font-semibold">FlightHub2 Response:</p>
              <pre className="text-xs font-mono bg-gray-900 text-gray-200 rounded-lg px-3 py-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                {log.fh2_response}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
type TabId = 'ingest' | 'processing'

export default function LogsPage() {
  const { sources } = useSourceStore()
  const { addToast } = useUIStore()
  const qc = useQueryClient()

  const [activeTab, setActiveTab]     = useState<TabId>('ingest')
  const [filterSource, setFilterSource] = useState<string | null>(null)
  const [limit, setLimit]             = useState(100)

  // ── Ingest logs query ──────────────────────────────────────────────────────
  const ingestKey = ['ingest-logs', filterSource, limit]
  const {
    data: ingestLogs = [],
    isLoading: ingestLoading,
    isFetching: ingestFetching,
  } = useQuery({
    queryKey: ingestKey,
    queryFn: () => ingestLogService.get(filterSource ?? undefined, limit),
    staleTime: 0,
    refetchInterval: 10_000,
  })

  const { mutate: clearIngest, isPending: clearingIngest } = useMutation({
    mutationFn: () => ingestLogService.clear(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ingest-logs'] })
      addToast('success', 'Ingest logs cleared')
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // ── Processing logs query ──────────────────────────────────────────────────
  const procKey = ['logs', filterSource, limit]
  const {
    data: procLogs = [],
    isLoading: procLoading,
    isFetching: procFetching,
  } = useQuery({
    queryKey: procKey,
    queryFn: () => logService.get(filterSource ?? undefined, limit),
    staleTime: 0,
    refetchInterval: 10_000,
  })

  const { mutate: clearProc, isPending: clearingProc } = useMutation({
    mutationFn: () => logService.clear(filterSource ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logs'] })
      addToast('success', 'Processing logs cleared')
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // ── Derived stats ──────────────────────────────────────────────────────────
  const ingestAccepted = ingestLogs.filter(l => l.result === 'accepted').length
  const ingestRejected = ingestLogs.filter(l => l.result === 'rejected').length
  const procSuccess    = procLogs.filter(l => l.ok).length
  const procFail       = procLogs.filter(l => !l.ok).length

  const isIngest      = activeTab === 'ingest'
  const isFetching    = isIngest ? ingestFetching : procFetching
  const isLoading     = isIngest ? ingestLoading  : procLoading
  const isClearing    = isIngest ? clearingIngest  : clearingProc

  function handleRefresh() {
    qc.invalidateQueries({ queryKey: isIngest ? ['ingest-logs'] : ['logs'] })
  }

  function handleClear() {
    const label = filterSource ? `"${filterSource}"` : 'all'
    if (!window.confirm(`Confirm clearing ${label} ${isIngest ? 'ingest' : 'processing'} logs?`)) return
    isIngest ? clearIngest() : clearProc()
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Page header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Logs</h1>
          <p className="text-sm text-gray-500 mt-1">
            Inbound webhook requests &amp; outbound FlightHub2 push results
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" loading={isFetching} onClick={handleRefresh}>
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
          <Button
            variant="ghost" size="sm" loading={isClearing} onClick={handleClear}
            className="text-red-500 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4" />
            Clear
          </Button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-0 border border-gray-200 rounded-xl overflow-hidden w-fit">
        <button
          onClick={() => setActiveTab('ingest')}
          className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium transition-colors ${
            isIngest
              ? 'bg-brand-600 text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <ArrowDownToLine className="w-4 h-4" />
          Ingest Logs
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-mono ${
            isIngest ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
          }`}>
            {ingestLogs.length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('processing')}
          className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium transition-colors border-l border-gray-200 ${
            !isIngest
              ? 'bg-brand-600 text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Zap className="w-4 h-4" />
          Processing Logs
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-mono ${
            !isIngest ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
          }`}>
            {procLogs.length}
          </span>
        </button>
      </div>

      {/* ── Stats cards ── */}
      {isIngest ? (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <div className="flex items-center gap-3">
              <Activity className="w-5 h-5 text-brand-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{ingestLogs.length}</p>
                <p className="text-xs text-gray-500">Total Requests</p>
              </div>
            </div>
          </Card>
          <Card>
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{ingestAccepted}</p>
                <p className="text-xs text-gray-500">Accepted</p>
              </div>
            </div>
          </Card>
          <Card>
            <div className="flex items-center gap-3">
              <XCircle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{ingestRejected}</p>
                <p className="text-xs text-gray-500">Rejected</p>
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <div className="flex items-center gap-3">
              <Activity className="w-5 h-5 text-brand-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{procLogs.length}</p>
                <p className="text-xs text-gray-500">Total Pushes</p>
              </div>
            </div>
          </Card>
          <Card>
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{procSuccess}</p>
                <p className="text-xs text-gray-500">Push Successful</p>
              </div>
            </div>
          </Card>
          <Card>
            <div className="flex items-center gap-3">
              <XCircle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{procFail}</p>
                <p className="text-xs text-gray-500">Push Failed</p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ── Filters ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <Filter className="w-4 h-4 text-gray-400" />
        <span className="text-sm text-gray-500">Filter by Source:</span>

        <button
          onClick={() => setFilterSource(null)}
          className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
            filterSource === null
              ? 'bg-brand-600 text-white border-brand-600'
              : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'
          }`}
        >
          All
        </button>

        {sources.map(s => (
          <button
            key={s}
            onClick={() => setFilterSource(s)}
            className={`px-3 py-1 rounded-full text-xs font-mono border transition-colors ${
              filterSource === s
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'
            }`}
          >
            {s}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-400">Show recent</span>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="text-xs border border-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
          >
            <option value={50}>50 entries</option>
            <option value={100}>100 entries</option>
            <option value={200}>200 entries</option>
            <option value={500}>500 entries</option>
          </select>
        </div>
      </div>

      {/* ── Webhook URL banner (Ingest tab only) ── */}
      {isIngest && <WebhookUrlBanner />}

      {/* ── Log list ── */}
      <div>
        {isLoading && (
          <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {/* Ingest tab content */}
        {isIngest && !isLoading && ingestLogs.length === 0 && (
          <Card>
            <div className="text-center py-12">
              <ArrowDownToLine className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">
                {filterSource ? `No ingest logs for "${filterSource}"` : 'No ingest logs yet'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Every POST to /webhook will appear here — including rejected requests and the rejection reason
              </p>
            </div>
          </Card>
        )}

        {isIngest && !isLoading && ingestLogs.length > 0 && (
          <div className="space-y-2">
            {ingestLogs.map((log, i) => (
              <IngestRow key={`${log.ts}-${log.ip}-${i}`} log={log} />
            ))}
          </div>
        )}

        {/* Processing tab content */}
        {!isIngest && !isLoading && procLogs.length === 0 && (
          <Card>
            <div className="text-center py-12">
              <Activity className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">
                {filterSource ? `No processing logs for "${filterSource}"` : 'No processing logs yet'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                After a webhook is accepted and processed by the worker, results appear here
              </p>
            </div>
          </Card>
        )}

        {!isIngest && !isLoading && procLogs.length > 0 && (
          <div className="space-y-2">
            {procLogs.map((log, i) => (
              <ProcessingRow key={`${log.msg_id}-${i}`} log={log} />
            ))}
          </div>
        )}
      </div>

      {/* Auto-refresh hint */}
      <p className="text-xs text-gray-400 text-center">
        Auto-refreshes every 10 s · showing the latest {limit} records
      </p>
    </div>
  )
}
