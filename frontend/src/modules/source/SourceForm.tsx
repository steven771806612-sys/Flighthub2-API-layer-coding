import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sourceService, authService } from '@/services'
import { useUIStore, useSourceStore, useMappingStore } from '@/store'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Copy, RefreshCw, Eye, EyeOff, AlertTriangle, Trash2 } from 'lucide-react'
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
  const url = `${window.location.origin}/webhook`

  return (
    <div className="space-y-2">
      {/* Endpoint row */}
      <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
        <span className="text-xs font-semibold text-blue-600 shrink-0">Webhook Endpoint</span>
        <code className="flex-1 text-xs font-mono text-blue-800 truncate">{url}</code>
        <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-mono shrink-0">POST</span>
        <button
          onClick={() => { navigator.clipboard.writeText(url); addToast('info', 'URL copied!') }}
          className="text-blue-400 hover:text-blue-600 shrink-0"
          title="Copy URL"
        >
          <Copy className="w-4 h-4" />
        </button>
      </div>
      {/* Source hint */}
      <p className="text-xs text-gray-400 pl-1">
        Incoming requests must include <code className="bg-gray-100 px-1 rounded">"source": "{sourceId}"</code> in the body
      </p>
    </div>
  )
}
