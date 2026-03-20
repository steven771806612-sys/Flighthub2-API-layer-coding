// ─── Domain Types ────────────────────────────────────────────────────────────

export type AuthMode = 'static_token'

export interface IngressAuth {
  enabled: boolean
  mode: AuthMode
  header_name: string
  token?: string       // optional: omit to keep existing; masked on read from backend
}

export interface MappingRow {
  src: string          // JSONPath e.g. "$.creator_id"
  dst: string          // unified field name
  type: 'string' | 'int' | 'float' | 'bool' | 'json'
  default: string | number | boolean | null
  required: boolean
}

export interface MappingConfig {
  mappings: MappingRow[]
}

export interface RetryPolicy {
  max_retries: number
  backoff: 'exponential' | 'linear'
}

export interface EgressConfig {
  endpoint: string
  headers: Record<string, string>   // X-User-Token masked on read
  template_body: Record<string, unknown>
  retry_policy: RetryPolicy
}

export interface Source {
  id: string           // same as name / slug
  auth?: IngressAuth
  mapping?: MappingConfig
  egress?: EgressConfig
}

// ─── Pipeline health / overview ──────────────────────────────────────────────

export type StepStatus = 'ok' | 'warn' | 'missing'

export interface PipelineStep {
  label: string
  status: StepStatus
  detail?: string
}

export interface SourcePipeline {
  sourceId: string
  steps: PipelineStep[]
}

// ─── Wizard state ─────────────────────────────────────────────────────────────

export type WizardStep =
  | 'create_source'
  | 'configure_auth'
  | 'configure_mapping'
  | 'configure_egress'
  | 'test'

export interface WizardState {
  currentStep: WizardStep
  sourceId: string
  completedSteps: Set<WizardStep>
}

// ─── API response wrappers ───────────────────────────────────────────────────

export interface ApiOk<T = unknown> {
  status: 'ok'
  data: T
}

export interface ApiError {
  status: 'error'
  message: string
}

export type ApiResult<T = unknown> = ApiOk<T> | ApiError

// ─── Adapter (uw:adapter:{source}) ───────────────────────────────────────────

/** One row in the adapter field-normalization table */
export interface AdapterField {
  target: string          // normalized key, e.g. "event.name"
  paths: string[]         // candidate paths in priority order
}

export interface AdapterConfig {
  fields: Record<string, string[]>   // { "event.name": ["Event.Name", "eventType"] }
}

// ─── Mapping DSL (uw:map:{source}) ───────────────────────────────────────────

export interface DslCase {
  if: string              // e.g. "$.event.name == 'VMD'"
  then: string | number   // replacement value
}

export interface DslRule {
  from?: string[]         // flat-dict keys tried in order
  default?: string | number | boolean | null
  cases?: DslCase[]
  transform?: 'upper' | 'lower' | 'strip' | 'int' | 'float' | 'bool' | 'str'
  type?: 'string' | 'int' | 'float' | 'bool' | 'json'
  required?: boolean
}

/** DSL mapping config — stored under { dsl: { ... } } */
export interface DslMappingConfig {
  dsl: Record<string, DslRule>
}

// ─── Device (uw:device:{device_id}) ──────────────────────────────────────────

export interface DeviceLocation {
  lat?: number | null
  lng?: number | null
  alt?: number | null
}

export interface DeviceInfo {
  device_id: string
  model?: string
  site?: string
  location?: DeviceLocation
}

// ─── Debug pipeline (extended v2) ────────────────────────────────────────────

export interface DebugResult {
  status: 'ok' | 'error'
  source: string
  raw: Record<string, unknown>
  flat?: Record<string, unknown>
  normalized?: Record<string, unknown>
  normalized_fields?: string[]
  mapped?: Record<string, unknown>
  event?: Record<string, unknown>
  final_body?: FH2Body
  missing?: string[]
  message?: string
}

// ─── FlightHub2 body structure ────────────────────────────────────────────────

export interface FH2Params {
  creator: string
  latitude: number | null
  longitude: number | null
  level: number
  desc: string
}

export interface FH2Body {
  workflow_uuid: string
  trigger_type: number
  name: string
  params: FH2Params
}

/** Visual mapping: normalized_field_key → fh2_body_path */
export type VisualMapping = Record<string, string>

/** FH2 target field definition */
export interface FH2TargetField {
  path: string                    // e.g. "params.latitude"
  label: string                   // human label
  type: 'string' | 'number' | 'int'
  required: boolean
  description?: string
}

// ─── UI / role ───────────────────────────────────────────────────────────────

export type Role = 'admin' | 'operator' | 'readonly'
