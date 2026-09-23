import { LineCounter, parseDocument } from 'yaml'

export type ProviderApiFormat =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'

export interface ProviderModel {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  api_format?: ProviderApiFormat
  request_path?: string
  tool_profile?: 'custom' | 'function' | 'shell'
  codex_tool_compatibility?: 'native' | 'standard'
  context_window?: number
  web_search_mode?: 'disabled' | 'cached' | 'live'
  image_generation_enabled?: boolean
  vision_model_config_id?: string
  group?: string
  provider_profile_id?: string
  codex_catalog_model_id?: string
  catalog_entry?: Record<string, unknown>
}

export interface ProviderConnection {
  id: string
  name: string
  base_url: string
  api_format: ProviderApiFormat
  request_path?: string
  models_path?: string
  api_key?: string
  api_key_ref?: string
  enabled?: boolean
  models: ProviderModel[]
}

export interface ProviderDocument {
  version: 1
  providers: ProviderConnection[]
}

export type PublicProviderConnection = Omit<ProviderConnection, 'api_key'> & {
  api_key_configured: boolean
  credential_missing: boolean
}

export interface ProviderFileSnapshot {
  path: string
  revision: string
  providers: PublicProviderConnection[]
  // Resolved secrets are IPC-only, never placed in renderer storage or events.
  credentials: Record<string, string>
  error: string | null
}

export type ProviderMutation =
  | {
      kind: 'provider'
      provider: Omit<ProviderConnection, 'models' | 'api_key' | 'api_key_ref'>
      apiKey?: string
      clearApiKey?: boolean
    }
  | { kind: 'model'; providerId: string; model: ProviderModel }
  | { kind: 'add-models'; providerId: string; modelIds: string[] }
  | { kind: 'delete-model'; providerId: string; modelId: string }
  | { kind: 'delete-provider'; providerId: string }
  | { kind: 'migrate'; providers: ProviderConnection[] }

export const EMPTY_PROVIDER_YAML =
  '# Local models only. Cloud models are managed separately.\nversion: 1\nproviders: []\n'
export const MAX_PROVIDER_FILE_BYTES = 2 * 1024 * 1024
const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages']
const PROVIDER_KEYS = new Set([
  'id',
  'name',
  'base_url',
  'api_format',
  'request_path',
  'models_path',
  'api_key',
  'api_key_ref',
  'enabled',
  'models',
])
const MODEL_KEYS = new Set([
  'id',
  'model_id',
  'display_name',
  'enabled',
  'api_format',
  'request_path',
  'tool_profile',
  'codex_tool_compatibility',
  'context_window',
  'web_search_mode',
  'image_generation_enabled',
  'vision_model_config_id',
  'group',
  'provider_profile_id',
  'codex_catalog_model_id',
  'catalog_entry',
])

export function parseProviderDocument(text: string) {
  if (new TextEncoder().encode(text).length > MAX_PROVIDER_FILE_BYTES) {
    throw new Error('Model configuration exceeds 2 MiB')
  }
  const lineCounter = new LineCounter()
  const document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true })
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem) {
    const position = lineCounter.linePos(problem.pos[0])
    // YAML diagnostics must not echo source lines containing credentials.
    throw new Error(`YAML ${problem.code} at line ${position.line}, column ${position.col}`)
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 25 })
  } catch {
    throw new Error('Invalid YAML references or excessive aliases')
  }
  validateProviderDocument(value)
  return { document, value }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, optional = false): void {
  if (optional && value === undefined) return
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty text`)
}

function identifier(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    throw new Error(`${field} must contain 1–160 letters, numbers, dots, hyphens or underscores`)
  }
}

function choice(value: unknown, values: string[], field: string, optional = true): void {
  if (optional && value === undefined) return
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`Invalid ${field}`)
}

function bool(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean')
    throw new Error(`${field} must be true or false`)
}

function knownKeys(value: Record<string, unknown>, keys: Set<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`Unknown field in ${field}; check the model.yml schema`)
  }
}

function requestPath(value: unknown, field: string): void {
  if (value === undefined) return
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[?#\s]/.test(value)
  ) {
    throw new Error(`${field} must be an absolute API path without a query or fragment`)
  }
}

export function validateProviderDocument(value: unknown): asserts value is ProviderDocument {
  const root = record(value, 'Configuration')
  knownKeys(root, new Set(['version', 'providers']), 'configuration')
  if (root.version !== 1) throw new Error('Unsupported model.yml version; expected version: 1')
  if (!Array.isArray(root.providers) || root.providers.length > 100)
    throw new Error('providers must be a list with at most 100 connections')
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  for (const [index, raw] of root.providers.entries()) {
    const field = `providers[${index}]`
    const provider = record(raw, field)
    knownKeys(provider, PROVIDER_KEYS, field)
    identifier(provider.id, `${field}.id`)
    const id = provider.id as string
    if (providerIds.has(id)) throw new Error(`Duplicate provider ID at ${field}`)
    providerIds.add(id)
    text(provider.name, `${field}.name`)
    text(provider.base_url, `${field}.base_url`)
    let url: URL
    try {
      url = new URL(provider.base_url as string)
    } catch {
      throw new Error(`Invalid ${field}.base_url`)
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `${field}.base_url must be an HTTP(S) URL without credentials, query or fragment`
      )
    }
    choice(provider.api_format, FORMATS, `${field}.api_format`, false)
    requestPath(provider.request_path, `${field}.request_path`)
    requestPath(provider.models_path, `${field}.models_path`)
    bool(provider.enabled, `${field}.enabled`)
    if (provider.api_key !== undefined && typeof provider.api_key !== 'string')
      throw new Error(`${field}.api_key must be text`)
    if (provider.api_key_ref !== undefined) {
      identifier(provider.api_key_ref, `${field}.api_key_ref`)
      if (!(provider.api_key_ref as string).startsWith('model-provider.'))
        throw new Error(`${field}.api_key_ref must reference a model-provider credential`)
    }
    if (provider.api_key !== undefined && provider.api_key_ref !== undefined)
      throw new Error(`${field} must use either api_key or api_key_ref, not both`)
    if (!Array.isArray(provider.models) || provider.models.length > 1000)
      throw new Error(`${field}.models must be a list with at most 1000 entries`)
    for (const [modelIndex, entry] of provider.models.entries()) {
      const mf = `${field}.models[${modelIndex}]`
      const model = record(entry, mf)
      knownKeys(model, MODEL_KEYS, mf)
      identifier(model.id, `${mf}.id`)
      const modelId = model.id as string
      if (modelIds.has(modelId)) throw new Error(`Duplicate model ID at ${mf}`)
      modelIds.add(modelId)
      text(model.model_id, `${mf}.model_id`)
      for (const key of ['display_name', 'group', 'provider_profile_id', 'codex_catalog_model_id'])
        text(model[key], `${mf}.${key}`, true)
      if (model.vision_model_config_id !== undefined)
        identifier(model.vision_model_config_id, `${mf}.vision_model_config_id`)
      bool(model.enabled, `${mf}.enabled`)
      bool(model.image_generation_enabled, `${mf}.image_generation_enabled`)
      choice(model.api_format, FORMATS, `${mf}.api_format`)
      choice(model.tool_profile, ['custom', 'function', 'shell'], `${mf}.tool_profile`)
      choice(
        model.codex_tool_compatibility,
        ['native', 'standard'],
        `${mf}.codex_tool_compatibility`
      )
      choice(model.web_search_mode, ['disabled', 'cached', 'live'], `${mf}.web_search_mode`)
      requestPath(model.request_path, `${mf}.request_path`)
      if (
        model.context_window !== undefined &&
        (!Number.isSafeInteger(model.context_window) || (model.context_window as number) <= 0)
      )
        throw new Error(`${mf}.context_window must be a positive integer`)
      if (model.catalog_entry !== undefined) record(model.catalog_entry, `${mf}.catalog_entry`)
      if (
        model.tool_profile === 'custom' &&
        (model.api_format ?? provider.api_format) !== 'openai-responses'
      )
        throw new Error(`${mf}: custom tools require Responses`)
    }
  }
  const models = (value as ProviderDocument).providers.flatMap(provider => provider.models)
  for (const model of models) {
    if (
      model.vision_model_config_id &&
      (model.vision_model_config_id === model.id || !modelIds.has(model.vision_model_config_id))
    ) {
      throw new Error('Vision model reference is missing or refers to itself')
    }
  }
}

export function providerRequestPath(
  provider: Pick<ProviderConnection, 'api_format' | 'base_url' | 'request_path'>,
  model?: ProviderModel
): string {
  const format = model?.api_format ?? provider.api_format
  if (model?.request_path) return model.request_path
  if (format === provider.api_format && provider.request_path) return provider.request_path
  if (format === 'openai-chat-completions') return '/chat/completions'
  if (format === 'anthropic-messages')
    return provider.base_url.replace(/\/+$/, '').endsWith('/v1') ? '/messages' : '/v1/messages'
  return '/responses'
}
