/**
 * LogsPage.tsx — Processing Logs Viewer
 *
 * Shows per-source (or global) worker processing logs including:
 *  - Timestamp, source, message ID
 *  - HTTP status returned by FlightHub2
 *  - Full FH2 response body (collapsible)
 *  - Missing fields warnings
 *  - Success / failure indicator
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { logService } from '@/services'
import { useSourceStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import {
  RefreshCw, Trash2, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronRight, Clock, Activity, Filter,
} from 'lucide-react'
import type { ProcessingLog } from '@/services'

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

// ─── Single log row ───────────────────────────────────────────────────────────
function LogRow({ log }: { log: ProcessingLog }) {
  const [open, setOpen] = useState(false)
  const hasMissing = log.missing_fields?.length > 0
  const hasResponse = !!log.fh2_response

  return (
    <div className={`border rounded-lg overflow-hidden ${log.ok ? 'border-gray-200' : 'border-red-200'}`}>
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 ${
          log.ok ? 'bg-white' : 'bg-red-50'
        }`}
      >
        {/* OK/fail icon */}
        {log.ok
          ? <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
          : <XCircle     className="w-4 h-4 text-red-500 shrink-0" />}

        {/* Time */}
        <span className="text-xs text-gray-400 font-mono shrink-0 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {fmtTs(log.ts)}
        </span>

        {/* Source */}
        <span className="text-xs font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded shrink-0">
          {log.source}
        </span>

        {/* Event name (body_name) */}
        <span className="flex-1 text-xs text-gray-700 truncate font-medium">
          {log.body_name || <span className="text-gray-400 italic">unnamed</span>}
        </span>

        {/* HTTP badge */}
        {httpBadge(log.http_status)}

        {/* Missing fields warning */}
        {hasMissing && (
          <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full shrink-0">
            <AlertTriangle className="w-3 h-3" />
            {log.missing_fields.length} missing
          </span>
        )}

        {/* Expand arrow */}
        {(hasResponse || hasMissing) && (
          open
            ? <ChevronDown  className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        )}
      </button>

      {/* Detail panel */}
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2 space-y-2">
          {/* msg_id + workflow_uuid */}
          <div className="flex flex-wrap gap-4 text-xs text-gray-400 font-mono">
            <span>msg_id: <span className="text-gray-600">{log.msg_id}</span></span>
            {log.workflow_uuid && (
              <span>workflow_uuid: <span className="text-gray-600">{log.workflow_uuid}</span></span>
            )}
          </div>

          {/* Missing fields */}
          {hasMissing && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                {/* <strong>Missing required fields:</strong> */}
              <strong>Missing required fields:</strong>
                <span className="ml-1">{log.missing_fields.join(', ')}</span>
              </div>
            </div>
          )}

          {/* FH2 response body */}
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
export default function LogsPage() {
  const { sources } = useSourceStore()
  const { addToast } = useUIStore()
  const qc = useQueryClient()

  // Filter: null = global (all sources), or a specific source id
  const [filterSource, setFilterSource] = useState<string | null>(null)
  const [limit, setLimit] = useState(100)

  const queryKey = ['logs', filterSource, limit]

  const { data: logs = [], isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: () => logService.get(filterSource ?? undefined, limit),
    staleTime: 0,
    refetchInterval: 10_000,   // auto-refresh every 10s
  })

  const { mutate: clearLogs, isPending: clearing } = useMutation({
    mutationFn: () => logService.clear(filterSource ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logs'] })
      addToast('success', 'Logs cleared')
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  const successCount = logs.filter(l => l.ok).length
  const failCount    = logs.filter(l => !l.ok).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Processing Logs</h1>
          <p className="text-sm text-gray-500 mt-1">
            Worker Processing Logs &amp; FlightHub2 API Responses
          
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={isFetching}
            onClick={() => qc.invalidateQueries({ queryKey: ['logs'] })}
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={clearing}
            onClick={() => {
              
          if (window.confirm(`Confirm clearing ${filterSource ? `"${filterSource}"` : 'all'} logs?`)) {
                clearLogs()
              }
            }}
            className="text-red-500 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4" />
            Clear Logs
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5 text-brand-500" />
            <div>
              <p className="text-2xl font-bold text-gray-900">{logs.length}</p>
              {/* Recent Log Entries */}
              <p className="text-xs text-gray-500">Recent Log Count</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-500" />
            <div>
              <p className="text-2xl font-bold text-gray-900">{successCount}</p>
              {/* Pushed Successfully */}
              <p className="text-xs text-gray-500">Push Successful</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <XCircle className="w-5 h-5 text-red-500" />
            <div>
              <p className="text-2xl font-bold text-gray-900">{failCount}</p>
              {/* Push Failed */}
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
          {/* Show latest */}
              <span className="text-xs text-gray-400">Show recent</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="text-xs border border-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
          >
            <option value={50}>50 entries</option>
            <option value={100}>100 entries</option>
            <option value={200}>200 entries</option>
            <option value={500}>500 entries</option>
          </select>
        </div>
      </div>

      {/* Log list */}
      <div>
        {isLoading && (
          <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {!isLoading && logs.length === 0 && (
          <Card>
            <div className="text-center py-12">
              <Activity className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">
                
              {filterSource ? `No logs for "${filterSource}"` : 'No processing logs yet'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                After sending a test event via /webhook, Worker processing results will appear here
              {/* Send a test event via /webhook — Worker processing results will appear here */}
              </p>
            </div>
          </Card>
        )}

        {!isLoading && logs.length > 0 && (
          <div className="space-y-2">
            {logs.map((log, i) => (
              <LogRow key={`${log.msg_id}-${i}`} log={log} />
            ))}
          </div>
        )}
      </div>

      {/* Auto-refresh hint */}
      <p className="text-xs text-gray-400 text-center">
        Auto-refreshes every 10 s · shows the latest {limit} records
          {/* Auto-refreshes every 10 seconds · showing up to {limit} most recent entries */}
      </p>
    </div>
  )
}
