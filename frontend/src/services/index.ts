import { apiClient } from './apiClient'
import type { IngressAuth, MappingConfig, EgressConfig, AdapterConfig, DeviceInfo, DebugResult } from '@/types'

// ─── Sources ─────────────────────────────────────────────────────────────────

export const sourceService = {
  async list(): Promise<string[]> {
    const { data } = await apiClient.post('/admin/source/list', {})
    return data.sources ?? []
  },

  async init(sourceId: string, force = false): Promise<void> {
    await apiClient.post('/admin/source/init', { source: sourceId, force })
  },

  async delete(sourceId: string): Promise<void> {
    await apiClient.post('/admin/source/delete', { source: sourceId })
  },
}

// ─── Ingress Auth ─────────────────────────────────────────────────────────────

export const authService = {
  async get(sourceId: string): Promise<IngressAuth> {
    const { data } = await apiClient.post('/admin/source/auth/get', { source: sourceId })
    return data.auth as IngressAuth
  },

  async set(sourceId: string, auth: IngressAuth): Promise<void> {
    await apiClient.post('/admin/source/auth/set', { source: sourceId, auth })
  },
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

export const mappingService = {
  async get(sourceId: string): Promise<MappingConfig> {
    const { data } = await apiClient.post('/admin/mapping/get', { source: sourceId })
    return data.mapping as MappingConfig
  },

  async set(sourceId: string, mapping: MappingConfig): Promise<void> {
    await apiClient.post('/admin/mapping/set', { source: sourceId, mapping })
  },

  async reset(sourceId: string): Promise<string> {
    const { data } = await apiClient.post('/admin/mapping/reset', { source: sourceId })
    return data.message as string
  },
}

// ─── Egress (FlightHub2) ──────────────────────────────────────────────────────

export const egressService = {
  async get(sourceId: string): Promise<EgressConfig> {
    const { data } = await apiClient.post('/admin/flighthub/get', { source: sourceId })
    return data.config as EgressConfig
  },

  async set(sourceId: string, config: EgressConfig): Promise<void> {
    await apiClient.post('/admin/flighthub/set', { source: sourceId, config })
  },
}

// ─── Token extractor ─────────────────────────────────────────────────────────

export const tokenService = {
  async extract(raw: string): Promise<Record<string, string>> {
    const { data } = await apiClient.post('/admin/token/extract', { raw })
    return data.extracted ?? {}
  },
}

// ─── Adapter (uw:adapter:{source}) ────────────────────────────────────────────

export const adapterService = {
  async get(sourceId: string): Promise<AdapterConfig> {
    const { data } = await apiClient.post('/admin/adapter/get', { source: sourceId })
    return (data.adapter ?? { fields: {} }) as AdapterConfig
  },

  async set(sourceId: string, adapter: AdapterConfig): Promise<void> {
    await apiClient.post('/admin/adapter/set', { source: sourceId, adapter })
  },
}

// ─── Device (uw:device:{device_id}) ───────────────────────────────────────────

export const deviceService = {
  async list(): Promise<string[]> {
    const { data } = await apiClient.post('/admin/device/list', {})
    return data.devices ?? []
  },

  async get(deviceId: string): Promise<DeviceInfo> {
    const { data } = await apiClient.post('/admin/device/get', { device_id: deviceId })
    return (data.device ?? {}) as DeviceInfo
  },

  async set(deviceId: string, info: DeviceInfo): Promise<void> {
    await apiClient.post('/admin/device/set', { device_id: deviceId, device: info })
  },

  async delete(deviceId: string): Promise<void> {
    await apiClient.post('/admin/device/delete', { device_id: deviceId })
  },
}

// ─── Debug pipeline ───────────────────────────────────────────────────────────

export const debugService = {
  async run(
    sourceId: string,
    samplePayload: Record<string, unknown>,
    mappingOverride?: Record<string, unknown>,
  ): Promise<DebugResult> {
    const { data } = await apiClient.post('/admin/debug/run', {
      source: sourceId,
      sample_payload: samplePayload,
      ...(mappingOverride ? { mapping_override: mappingOverride } : {}),
    })
    return data as DebugResult
  },
}

// ─── Device ID Field (uw:deviceidfield:{source}) ─────────────────────────────
// Configures which flattened payload field to use as the device lookup key
// when the vendor doesn't use the standard `device_id` field.

export const deviceIdFieldService = {
  async get(sourceId: string): Promise<string> {
    const { data } = await apiClient.post('/admin/deviceidfield/get', { source: sourceId })
    return (data.device_id_field ?? '') as string
  },

  async set(sourceId: string, field: string): Promise<void> {
    await apiClient.post('/admin/deviceidfield/set', { source: sourceId, device_id_field: field })
  },
}

// ─── Processing Logs ─────────────────────────────────────────────────────────

export interface ProcessingLog {
  ts: number
  source: string
  msg_id: string
  http_status: number
  fh2_response: string
  body_name: string
  workflow_uuid: string
  missing_fields: string[]
  ok: boolean
}

export const logService = {
  async get(sourceId?: string, limit = 100): Promise<ProcessingLog[]> {
    const { data } = await apiClient.post('/admin/logs/get', {
      ...(sourceId ? { source: sourceId } : {}),
      limit,
    })
    return (data.logs ?? []) as ProcessingLog[]
  },

  async clear(sourceId?: string): Promise<void> {
    await apiClient.post('/admin/logs/clear', {
      ...(sourceId ? { source: sourceId } : {}),
    })
  },
}

// ─── Integration test ─────────────────────────────────────────────────────────

export interface TestPayload {
  sourceId: string
  ingressToken: string
  webhookEvent: Record<string, unknown>
}

export interface TestResult {
  authStatus: number
  queueAccepted: boolean
  error?: string
}

export async function runIntegrationTest(p: TestPayload): Promise<TestResult> {
  try {
    const resp = await apiClient.post(
      '/webhook',
      { source: p.sourceId, webhook_event: p.webhookEvent },
      { headers: { 'X-MW-Token': p.ingressToken }, validateStatus: () => true },
    )
    return {
      authStatus: resp.status,
      queueAccepted: resp.status === 200 && resp.data?.status === 'accepted',
      error: resp.status !== 200 ? JSON.stringify(resp.data) : undefined,
    }
  } catch (e) {
    return { authStatus: 0, queueAccepted: false, error: String(e) }
  }
}

// ─── Diagnostic ───────────────────────────────────────────────────────────────

export interface DiagnosticResult {
  status: string
  stream_pending_total?: number
  stream_info_error?: string
  consumer_groups?: Array<{
    name: string
    pending: number
    consumers: number
    last_delivered_id: string
  }>
  fhcfg_issues?: Record<string, string[]>
  fhcfg_ok?: string[]
  log_counts?: { total: number; success: number; fail: number }
  latest_log?: {
    ts: number
    http_status: number
    ok: boolean
    source: string
    missing: string[]
    fh2_response: string
  }
  // Redis URL actually in use by the API process (masked password)
  redis_url_in_use?: string
}

export const diagnosticService = {
  async run(sourceId?: string): Promise<DiagnosticResult> {
    const { data } = await apiClient.post('/admin/diagnostic', {
      ...(sourceId ? { source: sourceId } : {}),
    })
    return data as DiagnosticResult
  },
}

export const streamService = {
  /** Reclaim messages stuck in the Redis Stream PEL and re-queue them for processing. */
  async drainPending(): Promise<{ status: string; drained: number; requeued: number; message: string }> {
    const { data } = await apiClient.post('/admin/stream/drain-pending', {})
    return data
  },
}

// ─── Ingest Access Logs ───────────────────────────────────────────────────────
// Records every HTTP request that arrives at POST /webhook,
// including rejected ones (auth failures, missing source, bad payload).

export interface IngestLog {
  ts: number
  source: string
  ip: string
  method: string
  path: string
  status_code: number
  result: 'accepted' | 'rejected' | 'error'
  reject_reason: string
  request_headers: Record<string, string>
  body_size: number
}

export const ingestLogService = {
  async get(sourceId?: string, limit = 100): Promise<IngestLog[]> {
    const { data } = await apiClient.post('/admin/ingest-logs/get', {
      ...(sourceId ? { source: sourceId } : {}),
      limit,
    })
    return (data.logs ?? []) as IngestLog[]
  },

  async clear(): Promise<void> {
    await apiClient.post('/admin/ingest-logs/clear', {})
  },
}
