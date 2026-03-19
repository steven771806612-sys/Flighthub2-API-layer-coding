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
  async run(sourceId: string, samplePayload: Record<string, unknown>): Promise<DebugResult> {
    const { data } = await apiClient.post('/admin/debug/run', {
      source: sourceId,
      sample_payload: samplePayload,
    })
    return data as DebugResult
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
