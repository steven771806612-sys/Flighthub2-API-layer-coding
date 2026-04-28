import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sourceService, authService } from '@/services'
import { useUIStore, useSourceStore, useMappingStore } from '@/store'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Copy, RefreshCw, Eye, EyeOff, AlertTriangle, Trash2, Check, ExternalLink } from 'lucide-react'
import type { IngressAuth } from '@/types'

// ─── Create Source ────────────────────────────────────────────────────────────
interface CreateForm { sourceId: string }

export function SourceCreateForm({ onCreated }: { onCreated?: (id: string) => void }) {
  const qc = useQueryClient()
  const { addToast } = useUIStore()
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateForm>()

  const { mutate, isPending } = useMutation({
    mutationFn: (id: string) => sourceService.init(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['sources'] })
      addToast('success', `Source "${id}" created`)
      reset()
      onCreated?.(id)
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  return (
    <Card title="Create Source" description="A source is a named webhook entry point">
      <form
        onSubmit={handleSubmit((d) => mutate(d.sourceId))}
        className="flex gap-3 items-end"
      >
        <div className="flex-1">
          <Input
            label="Source ID"
            placeholder="e.g. flighthub2"
            error={errors.sourceId?.message}
            {...register('sourceId', {
              required: 'Required',
              pattern: { value: /^[a-z0-9_-]+$/, message: 'lowercase, numbers, _ - only' },
            })}
          />
        </div>
        <Button type="submit" loading={isPending}>Create Source</Button>
      </form>
    </Card>
  )
}

// ─── Ingress Auth Config ──────────────────────────────────────────────────────
function generateToken(len = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

interface AuthFormFields {
  enabled: boolean
  header_name: string
  token: string
}

export function SourceAuthForm({ sourceId }: { sourceId: string }) {
  const { addToast } = useUIStore()
  const [showToken, setShowToken] = useState(false)
  const { isDirty, markDirty, markClean } = useDirtyGuard()
  const { register, handleSubmit, setValue, watch, reset, formState: { errors } } = useForm<AuthFormFields>({
    defaultValues: { enabled: true, header_name: 'X-MW-Token', token: '' },
  })

  const tokenValue = watch('token')
  const authEnabledValue = watch('enabled')

  // Load existing config (only header_name and enabled are restored; backend masks the token, so token field is left blank for user to re-enter)
  const { data: existingAuth } = useQuery({
    queryKey: ['auth', sourceId],
    queryFn: () => authService.get(sourceId),
    enabled: !!sourceId,
    // staleTime: 0 ensures re-fetch whenever sourceId changes
    staleTime: 0,
  })

  useEffect(() => {
    if (existingAuth) {
      reset({
        enabled: existingAuth.enabled ?? true,
        header_name: existingAuth.header_name ?? 'X-MW-Token',
        token: '', // Do not pre-fill the masked token — user must explicitly enter a new one to overwrite
      })
      markClean()
    }
  }, [existingAuth, reset, markClean])

  // Whether a token is already set (backend returns masked value containing ****)
  const hasExistingToken = !!(existingAuth?.token && existingAuth.token.length > 0)

  const { mutate, isPending } = useMutation({
    mutationFn: (d: AuthFormFields) => {
      const payload: IngressAuth = {
        enabled: d.enabled,
        mode: 'static_token',
        header_name: d.header_name,
        // If token is empty, user does not want to change it — omit token field so backend keeps the existing value
        // Only send token field when non-empty
        ...(d.token.trim() ? { token: d.token.trim() } : {}),
      }
      return authService.set(sourceId, payload)
    },
    onSuccess: () => {
      addToast('success', 'Ingress auth saved')
      setValue('token', '') // Clear token field after save to prevent accidental re-submission
      markClean()
    },
    onError: (e: Error) => addToast('error', e.message),
  })

  // Mark dirty on any form change — use RHF subscription to avoid stale closure
  useEffect(() => {
    const sub = watch(() => {
      // Only flag dirty after server data has been loaded (not on initial mount)
      if (existingAuth !== undefined) markDirty()
    })
    return () => sub.unsubscribe()
  }, [watch, markDirty, existingAuth])

  return (
    <Card
      title="Ingress Authentication"
      description="Only requests with the correct header token will be accepted"
    >
      {/* Warning shown when auth is enabled but no token has been set yet */}
      {authEnabledValue && !hasExistingToken && (
        <div className="flex items-start gap-2 px-3 py-2 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            <strong>No token set</strong> — the endpoint is currently open to all requests.
            Set a token below to enforce authentication.
          </span>
        </div>
      )}
      {isDirty && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
Unsaved changes — please click "Save Auth Config" to save
        </div>
      )}
      <form onSubmit={handleSubmit((d) => mutate(d))} className="space-y-4">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="enabled" {...register('enabled')} className="w-4 h-4 rounded" />
          <label htmlFor="enabled" className="text-sm font-medium text-gray-700">Enable authentication</label>
        </div>

        {/* Header Name & Token — only shown/required when authentication is enabled
             当取消鉴权时隐藏这两个字段，无需配置 header 名称和 token */}
        {authEnabledValue && (
          <>
            <Input
              label="Header Name"
              error={errors.header_name?.message}
              {...register('header_name', { required: authEnabledValue ? 'Required' : false })}
            />

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">Token</label>
                {hasExistingToken && (
                  <span className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                    ✓ Token already set — leave blank to keep existing
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showToken ? 'text' : 'password'}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono pr-10 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder={hasExistingToken ? 'Leave blank to keep existing token' : 'Set a strong random token'}
                    {...register('token', {
                      // Required only when auth is enabled and no token exists yet
                      // 取消鉴权时 token 字段不是必填
                      required: authEnabledValue && !hasExistingToken ? 'Required' : false,
                    })}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => setValue('token', generateToken())}
                  title="Generate random token"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => { navigator.clipboard.writeText(tokenValue); addToast('info', 'Copied!') }}
                  title="Copy token"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              {errors.token && <p className="text-xs text-red-600">{errors.token.message}</p>}
              <p className="text-xs text-gray-400">Token is write-only — backend returns masked value on read</p>
            </div>
          </>
        )}

        {/* Curl example — auth header line is omitted when authentication is disabled */}
        <div className="p-3 bg-gray-900 rounded-lg font-mono text-xs text-green-400 border border-gray-700 overflow-x-auto">
          <span className="text-gray-500"># FlightHub Webhook Transformer — ingest endpoint</span><br />
          curl -X POST {typeof window !== 'undefined' ? window.location.origin : ''}/webhook \<br />
          &nbsp;&nbsp;-H &quot;Content-Type: application/json&quot; \<br />
          {/* Only show auth header when authentication is enabled (取消鉴权时不显示该 header) */}
          {authEnabledValue && (
            <>&nbsp;&nbsp;-H &quot;{watch('header_name') || 'X-MW-Token'}: {tokenValue || (hasExistingToken ? '<existing-token>' : '<token>')}&quot; \<br /></>
          )}
          &nbsp;&nbsp;-d &apos;{`{"source":"${sourceId}","webhook_event":{...}}`}&apos;
        </div>

        <Button type="submit" loading={isPending}>Save Auth Config</Button>
      </form>
    </Card>
  )
}

// ─── Source Selector (shared) ──────────────────────────────────────────────────
export function SourceSelector({ onDelete }: { onDelete?: (id: string) => void }) {
  const { sources, selected, setSelected } = useSourceStore()
  const { switchSource } = useMappingStore()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleSelectSource = (s: string) => {
    if (s === selected) return
    // Mapping drafts persist per-source; no data loss, but inform user preview resets
    setSelected(s)
    switchSource(s)
  }

  if (!sources.length) return (
    <p className="text-sm text-gray-400">No sources yet. Create one first.</p>
  )

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {sources.map((s) => (
        <div key={s} className="relative group flex items-center">
          <button
            onClick={() => handleSelectSource(s)}
            className={`pl-3 pr-2 py-1 rounded-full text-sm font-mono border transition-colors flex items-center gap-1.5 ${
              selected === s
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'
            }`}
          >
            {s}
          </button>
          {/* Delete button */}
          {onDelete && (
            confirmDelete === s ? (
              <div className="flex items-center gap-1 ml-1">
                <button
                  onClick={() => { onDelete(s); setConfirmDelete(null) }}
                  className="text-xs text-white bg-red-500 hover:bg-red-600 px-2 py-0.5 rounded-full transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="text-xs text-gray-500 hover:text-gray-700 px-1 py-0.5"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(s)}
                className="ml-1 w-5 h-5 flex items-center justify-center text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                title={`Delete source ${s}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Webhook URL display ──────────────────────────────────────────────────────
export function WebhookURL({ sourceId }: { sourceId: string }) {
  const { addToast } = useUIStore()
  const [urlCopied, setUrlCopied] = useState(false)
  const [bodyCopied, setBodyCopied] = useState(false)

  const url        = `${window.location.origin}/webhook`
  const bodySnippet = JSON.stringify({ source: sourceId, webhook_event: { /* your payload */ } }, null, 2)

  const copyUrl = () => {
    navigator.clipboard.writeText(url)
    setUrlCopied(true)
    setTimeout(() => setUrlCopied(false), 2000)
    addToast('info', 'URL copied!')
  }
  const copyBody = () => {
    navigator.clipboard.writeText(bodySnippet)
    setBodyCopied(true)
    setTimeout(() => setBodyCopied(false), 2000)
    addToast('info', 'Body template copied!')
  }

  return (
    <div className="rounded-xl border-2 border-blue-300 bg-blue-50 overflow-hidden shadow-sm">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-blue-600">
        <ExternalLink className="w-4 h-4 text-white shrink-0" />
        <div className="flex-1">
          <p className="text-white font-semibold text-sm leading-none">Webhook Ingest URL</p>
          <p className="text-blue-200 text-xs mt-0.5">Point your third-party system to this endpoint</p>
        </div>
        <span className="text-xs font-mono font-bold bg-white/20 text-white px-2 py-1 rounded-full shrink-0">
          POST
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* ── Full URL row ── */}
        <div>
          <p className="text-xs font-semibold text-blue-700 mb-1.5 uppercase tracking-wide">Endpoint</p>
          <div className="flex items-center gap-2 bg-white border border-blue-200 rounded-lg px-3 py-2.5 shadow-sm">
            <code className="flex-1 text-sm font-mono text-blue-900 break-all select-all">{url}</code>
            <button
              onClick={copyUrl}
              className="shrink-0 flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 font-medium transition-colors px-2 py-1 rounded-md hover:bg-blue-50"
              title="Copy URL"
            >
              {urlCopied
                ? <><Check className="w-3.5 h-3.5 text-green-500" /><span className="text-green-600">Copied</span></>
                : <><Copy  className="w-3.5 h-3.5" /><span>Copy</span></>}
            </button>
          </div>
        </div>

        {/* ── Required body fields ── */}
        <div>
          <p className="text-xs font-semibold text-blue-700 mb-1.5 uppercase tracking-wide">
            Required Request Body (JSON)
          </p>
          <div className="bg-gray-900 rounded-lg overflow-hidden border border-gray-700">
            <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
              <span className="text-xs text-gray-400 font-mono">application/json</span>
              <button
                onClick={copyBody}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                title="Copy body template"
              >
                {bodyCopied
                  ? <><Check className="w-3 h-3 text-green-400" /><span className="text-green-400">Copied</span></>
                  : <><Copy  className="w-3 h-3" /><span>Copy</span></>}
              </button>
            </div>
            <pre className="text-xs font-mono px-3 py-3 text-gray-200 overflow-x-auto">
<span className="text-gray-500">{'{'}</span>
{`\n`}  <span className="text-blue-300">"source"</span>: <span className="text-amber-300">"{sourceId}"</span>,       <span className="text-gray-500">// required — identifies this source</span>
{`\n`}  <span className="text-blue-300">"webhook_event"</span>: <span className="text-gray-500">{'{ ... }'}</span>    <span className="text-gray-500">// required — your raw payload (any JSON)</span>
{`\n`}<span className="text-gray-500">{'}'}</span>
            </pre>
          </div>
          <p className="text-xs text-blue-600 mt-1.5 pl-0.5">
            Both fields are required. <code className="bg-blue-100 px-1 rounded font-mono">webhook_event</code> can be any JSON object — the mapping rules will transform it.
          </p>
        </div>
      </div>
    </div>
  )
}
