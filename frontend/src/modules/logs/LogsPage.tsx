/**
 * LogsPage.tsx — Two-tab log viewer
 *
 * Tab 1 – Ingest Logs  (new, shown first)
 *   Every HTTP POST /webhook request recorded on arrival, including:
 *   – timestamp, client IP, source, HTTP status returned to caller
 *   – result: accepted | rejected | error
 *   – reject_reason (human-readable, e.g. "Auth header 'X-MW-Token' not found")
 *   – request_headers snapshot (auth values masked)
 *
 * Tab 2 – Processing Logs (existing)
 *   Worker pipeline outcomes: FH2 HTTP status, missing fields, FH2 response.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { logService, ingestLogService } from '@/services'
import { useSourceStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import type { ProcessingLog, IngestLog } from '@/services'
import {
  RefreshCw, Trash2, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronRight, Clock, Activity, Filter,
  ArrowDownToLine, ShieldAlert, ShieldCheck,
} from 'lucide-react'

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
  const base = 'px-1.5 py-0.5 text-xs font-mono rounded-full border'
  if (status >= 200 && status < 300)
    return <span className={`${base} bg-emerald-100 text-emerald-700 border-emerald-200`}>{status}</span>
  if (status === 0)
    return <span className={`${base} bg-gray-100 text-gray-500 border-gray-200`}>–</span>
  return <span className={`${base} bg-red-100 text-red-700 border-red-200`}>{status}</span>
}

// ─── Ingest log row ───────────────────────────────────────────────────────────

function IngestRow({ log }: { log: IngestLog }) {
  const [open, setOpen] = useState(false)
  const accepted  = log.result === 'accepted'
  const rejected  = log.result === 'rejected'
  const hasReason = !!log.reject_reason
  const hasHeaders = log.request_headers && Object.keys(log.request_headers).length > 0

  return (
    <div className={`border rounded-lg overflow-hidden ${accepted ? 'border-gray-200' : 'border-red-200'}`}>
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 ${
          accepted ? 'bg-white' : 'bg-red-50'
        }`}
      >
        {/* Icon */}
        {accepted
          ? <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
          : <ShieldAlert className="w-4 h-4 text-red-500 shrink-0" />}

        {/* Time */}
        <span className="text-xs text-gray-400 font-mono shrink-0 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {fmtTs(log.ts)}
        </span>

        {/* Source tag */}
        <span className="text-xs font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded shrink-0">
          {log.source || '(unknown)'}
        </span>

        {/* IP */}
        <span className="text-xs text-gray-400 font-mono shrink-0">{log.ip}</span>

        {/* Result badge */}
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${
          accepted ? 'bg-emerald-100 text-emerald-700' : rejected ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
        }`}>
          {log.result}
        </span>

        {/* HTTP status */}
        {httpBadge(log.status_code)}

        {/* Rejection reason (preview) */}
        {hasReason && !open && (
          <span className="flex-1 text-xs text-red-600 truncate italic">{log.reject_reason}</span>
        )}
        {accepted && !open && (
          <span className="flex-1 text-xs text-gray-400 truncate">Request accepted and queued</span>
        )}

        {/* Expand arrow */}
        {(hasReason || hasHeaders) && (
          open
            ? <ChevronDown  className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        )}
      </button>

      {/* Detail panel */}
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2.5 space-y-3">
          {/* Rejection reason */}
          {hasReason && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <strong>Rejection Reason: </strong>
                {log.reject_reason}
              </div>
            </div>
          )}

          {/* Request headers */}
          {hasHeaders && (
            <div>
              <p className="text-xs text-gray-500 mb-1 font-semibold">Request Headers (auth values masked):</p>
              <div className="bg-gray-900 rounded-lg px-3 py-2 overflow-x-auto">
                <table className="text-xs font-mono w-full">
                  <tbody>
                    {Object.entries(log.request_headers).map(([k, v]) => (
                      <tr key={k}>
                        <td className="text-gray-400 pr-4 py-0.5 align-top whitespace-nowrap">{k}</td>
                        <td className={`py-0.5 break-all ${v === '***' ? 'text-amber-400' : 'text-gray-200'}`}>
                          {v === '***' ? '*** (masked)' : v}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Body size */}
          <p className="text-xs text-gray-400 font-mono">
            Body size: {log.body_size} bytes &nbsp;·&nbsp; Path: {log.path}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Processing log row ───────────────────────────────────────────────────────

function LogRow({ log }: { log: ProcessingLog }) {
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

  const [tab, setTab] = useState<TabId>('ingest')
  const [filterSource, setFilterSource] = useState<string | null>(null)
  const [limit, setLimit] = useState(100)

  // ── Ingest logs query ─────────────────────────────────────────────────────
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

  // ── Processing logs query ─────────────────────────────────────────────────
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

  // ── Derived values ────────────────────────────────────────────────────────
  const ingestAccepted = ingestLogs.filter(l => l.result === 'accepted').length
  const ingestRejected = ingestLogs.filter(l => l.result !== 'accepted').length
  const procSuccess    = procLogs.filter(l => l.ok).length
  const procFail       = procLogs.filter(l => !l.ok).length

  const isLoading   = tab === 'ingest' ? ingestLoading  : procLoading
  const isFetching  = tab === 'ingest' ? ingestFetching : procFetching
  const handleClear = tab === 'ingest'
    ? () => { if (window.confirm('Clear all ingest logs?')) clearIngest() }
    : () => { if (window.confirm(`Clear ${filterSource ? `"${filterSource}"` : 'all'} processing logs?`)) clearProc() }
  const isClearing  = tab === 'ingest' ? clearingIngest : clearingProc

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['ingest-logs'] })
    qc.invalidateQueries({ queryKey: ['logs'] })
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Logs</h1>
          <p className="text-sm text-gray-500 mt-1">
            Inbound request access log &amp; worker processing outcomes
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" loading={isFetching} onClick={handleRefresh}>
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
          <Button
            variant="ghost" size="sm" loading={isClearing}
            onClick={handleClear}
            className="text-red-500 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4" />
            Clear
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 gap-1">
        <button
          onClick={() => setTab('ingest')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            tab === 'ingest'
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <ArrowDownToLine className="w-4 h-4" />
          Ingest Logs
          <span className={`ml-1 text-xs px-1.5 py-0.5 rounded-full font-mono ${
            tab === 'ingest' ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {ingestLogs.length}
          </span>
        </button>
        <button
          onClick={() => setTab('processing')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            tab === 'processing'
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <Activity className="w-4 h-4" />
          Processing Logs
          <span className={`ml-1 text-xs px-1.5 py-0.5 rounded-full font-mono ${
            tab === 'processing' ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {procLogs.length}
          </span>
        </button>
      </div>

      {/* ── INGEST TAB ─────────────────────────────────────────────────────── */}
      {tab === 'ingest' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <div className="flex items-center gap-3">
                <ArrowDownToLine className="w-5 h-5 text-brand-500" />
                <div>
                  <p className="text-2xl font-bold text-gray-900">{ingestLogs.length}</p>
                  <p className="text-xs text-gray-500">Total Requests</p>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-center gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-500" />
                <div>
                  <p className="text-2xl font-bold text-gray-900">{ingestAccepted}</p>
                  <p className="text-xs text-gray-500">Accepted</p>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-center gap-3">
                <ShieldAlert className="w-5 h-5 text-red-500" />
                <div>
                  <p className="text-2xl font-bold text-gray-900">{ingestRejected}</p>
                  <p className="text-xs text-gray-500">Rejected / Error</p>
                </div>
              </div>
            </Card>
          </div>

          {/* Filters */}
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
            {sources.map((s) => (
              <button key={s} onClick={() => setFilterSource(s)}
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
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
                className="text-xs border border-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
              >
                <option value={50}>50 entries</option>
                <option value={100}>100 entries</option>
                <option value={200}>200 entries</option>
                <option value={500}>500 entries</option>
              </select>
            </div>
          </div>

          {/* List */}
          <div>
            {isLoading && (
              <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading…
              </div>
            )}
            {!isLoading && ingestLogs.length === 0 && (
              <Card>
                <div className="text-center py-12">
                  <ArrowDownToLine className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">No ingest logs yet</p>
                  <p className="text-xs text-gray-400 mt-1">
                    Every POST to /webhook will be recorded here, including rejected requests
                  </p>
                </div>
              </Card>
            )}
            {!isLoading && ingestLogs.length > 0 && (
              <div className="space-y-2">
                {ingestLogs.map((log, i) => (
                  <IngestRow key={`${log.ts}-${log.ip}-${i}`} log={log} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── PROCESSING TAB ─────────────────────────────────────────────────── */}
      {tab === 'processing' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <div className="flex items-center gap-3">
                <Activity className="w-5 h-5 text-brand-500" />
                <div>
                  <p className="text-2xl font-bold text-gray-900">{procLogs.length}</p>
                  <p className="text-xs text-gray-500">Recent Log Count</p>
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

          {/* Filters */}
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
            {sources.map((s) => (
              <button key={s} onClick={() => setFilterSource(s)}
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
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
                className="text-xs border border-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
              >
                <option value={50}>50 entries</option>
                <option value={100}>100 entries</option>
                <option value={200}>200 entries</option>
                <option value={500}>500 entries</option>
              </select>
            </div>
          </div>

          {/* List */}
          <div>
            {isLoading && (
              <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading…
              </div>
            )}
            {!isLoading && procLogs.length === 0 && (
              <Card>
                <div className="text-center py-12">
                  <Activity className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">
                    {filterSource ? `No logs for "${filterSource}"` : 'No processing logs yet'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    After sending a test event via /webhook, Worker processing results will appear here
                  </p>
                </div>
              </Card>
            )}
            {!isLoading && procLogs.length > 0 && (
              <div className="space-y-2">
                {procLogs.map((log, i) => (
                  <LogRow key={`${log.msg_id}-${i}`} log={log} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Auto-refresh hint */}
      <p className="text-xs text-gray-400 text-center">
        Auto-refreshes every 10 s · showing up to {limit} most recent entries
      </p>
    </div>
  )
}
