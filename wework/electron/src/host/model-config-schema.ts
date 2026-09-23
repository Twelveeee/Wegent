/** Shared, serializable contract for the local Provider/YAML editor. */
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
  context_window?: number
  /** Existing per-model capabilities are preserved during migration and UI edits. */
  settings?: Record<string, unknown>
}

export interface ProviderConnection {
  id: string
  name: string
  base_url: string
  api_format: ProviderApiFormat
  request_path?: string
  models_path?: string
  models_base_url?: string
  api_key?: string
  api_key_ref?: string
  enabled?: boolean
  models: ProviderModel[]
}

export interface ProviderDocument {
  version: 1
  providers: ProviderConnection[]
}

export interface ProviderSnapshot {
  path: string
  revision: string
  document: ProviderDocument
  configuredKeys: string[]
}

const formats = new Set(['openai-responses', 'openai-chat-completions', 'anthropic-messages'])
const providerFields = new Set([
  'id',
  'name',
  'base_url',
  'api_format',
  'request_path',
  'models_path',
  'models_base_url',
  'api_key',
  'api_key_ref',
  'enabled',
  'models',
])
const modelFields = new Set([
  'id',
  'model_id',
  'display_name',
  'enabled',
  'api_format',
  'request_path',
  'context_window',
  'settings',
])
const settingFields = new Set([
  'providerProfileId',
  'group',
  'codexToolCompatibility',
  'toolProfile',
  'contextWindow',
  'webSearchMode',
  'imageGenerationEnabled',
  'visionModelConfigId',
  'codexCatalogModelId',
  'catalogEntry',
])

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`)
  }
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(`${path}: contains an unsupported field`)
  }
}

function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error(`${path}: expected a non-empty string (maximum 4096 characters)`)
  }
}

function stableId(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${path}: use 1–128 letters, digits, underscores or hyphens`)
  }
}

function httpUrl(value: unknown, path: string): void {
  text(value, path)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${path}: invalid URL`)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${path}: use an HTTP(S) base URL without credentials, query or fragment`)
  }
}

function optionalFields(value: Record<string, unknown>, path: string): void {
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${path}.enabled: expected a boolean`)
  }
  if (value.api_format !== undefined && !formats.has(String(value.api_format))) {
    throw new Error(`${path}.api_format: unsupported protocol`)
  }
  if (value.request_path !== undefined) requestPath(value.request_path, `${path}.request_path`)
}

function requestPath(value: unknown, path: string): void {
  text(value, path)
  if (!value.startsWith('/') || value.startsWith('//') || /[?#\\]/.test(value)) {
    throw new Error(`${path}: expected a relative API path beginning with one slash`)
  }
}

export function validateProviderDocument(value: unknown): ProviderDocument {
  const root = record(value, 'config')
  fields(root, new Set(['version', 'providers']), 'config')
  if (root.version !== 1) throw new Error('version: only schema version 1 is supported')
  if (!Array.isArray(root.providers) || root.providers.length > 100) {
    throw new Error('providers: expected an array with at most 100 connections')
  }
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  for (const [i, raw] of root.providers.entries()) {
    const path = `providers[${i}]`
    const p = record(raw, path)
    fields(p, providerFields, path)
    stableId(p.id, `${path}.id`)
    if (providerIds.has(p.id)) throw new Error(`${path}.id: duplicate provider ID`)
    providerIds.add(p.id)
    text(p.name, `${path}.name`)
    httpUrl(p.base_url, `${path}.base_url`)
    if (!formats.has(String(p.api_format)))
      throw new Error(`${path}.api_format: unsupported protocol`)
    optionalFields(p, path)
    if (p.models_base_url !== undefined) httpUrl(p.models_base_url, `${path}.models_base_url`)
    if (p.models_path !== undefined) requestPath(p.models_path, `${path}.models_path`)
    if (p.api_key !== undefined && typeof p.api_key !== 'string')
      throw new Error(`${path}.api_key: expected a string`)
    if (p.api_key_ref !== undefined) {
      text(p.api_key_ref, `${path}.api_key_ref`)
      if (!/^model-provider\.key\.[a-zA-Z0-9._-]{1,130}$/.test(p.api_key_ref)) {
        throw new Error(`${path}.api_key_ref: invalid model credential reference`)
      }
    }
    if (p.api_key !== undefined && p.api_key_ref !== undefined)
      throw new Error(`${path}: use api_key OR api_key_ref`)
    if (!Array.isArray(p.models) || p.models.length > 1000)
      throw new Error(`${path}.models: expected an array (maximum 1000)`)
    for (const [j, rawModel] of p.models.entries()) {
      const mp = `${path}.models[${j}]`
      const m = record(rawModel, mp)
      fields(m, modelFields, mp)
      stableId(m.id, `${mp}.id`)
      if (modelIds.has(m.id.toLowerCase()))
        throw new Error(`${mp}.id: model IDs must be unique across providers`)
      modelIds.add(m.id.toLowerCase())
      text(m.model_id, `${mp}.model_id`)
      if (m.display_name !== undefined) text(m.display_name, `${mp}.display_name`)
      optionalFields(m, mp)
      const settings = m.settings === undefined ? {} : record(m.settings, `${mp}.settings`)
      fields(settings, settingFields, `${mp}.settings`)
      const contextWindow = m.context_window ?? settings.contextWindow
      if (
        contextWindow !== undefined &&
        (!Number.isSafeInteger(contextWindow) || Number(contextWindow) <= 0)
      ) {
        throw new Error(`${mp}.context_window: expected a positive integer`)
      }
      const apiFormat = m.api_format ?? p.api_format
      if (
        settings.toolProfile !== undefined &&
        !['custom', 'function', 'shell'].includes(String(settings.toolProfile))
      ) {
        throw new Error(`${mp}.settings.toolProfile: unsupported tool profile`)
      }
      if (settings.toolProfile === 'custom' && apiFormat !== 'openai-responses') {
        throw new Error(`${mp}: native custom tools require Responses`)
      }
      if (
        settings.codexToolCompatibility !== undefined &&
        !['native', 'standard'].includes(String(settings.codexToolCompatibility))
      ) {
        throw new Error(`${mp}.settings.codexToolCompatibility: invalid compatibility`)
      }
      if (
        settings.webSearchMode !== undefined &&
        !['disabled', 'cached', 'live'].includes(String(settings.webSearchMode))
      ) {
        throw new Error(`${mp}.settings.webSearchMode: invalid search mode`)
      }
      if (
        settings.imageGenerationEnabled !== undefined &&
        typeof settings.imageGenerationEnabled !== 'boolean'
      ) {
        throw new Error(`${mp}.settings.imageGenerationEnabled: expected a boolean`)
      }
      for (const key of [
        'group',
        'visionModelConfigId',
        'codexCatalogModelId',
        'providerProfileId',
      ]) {
        if (settings[key] !== undefined) text(settings[key], `${mp}.settings.${key}`)
      }
      if (settings.catalogEntry !== undefined)
        record(settings.catalogEntry, `${mp}.settings.catalogEntry`)
    }
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new Error('config: cyclic YAML aliases are not supported')
  }
  return structuredClone(value) as ProviderDocument
}

export function defaultProviderRequestPath(format: ProviderApiFormat): string {
  return format === 'anthropic-messages'
    ? '/v1/messages'
    : format === 'openai-chat-completions'
      ? '/chat/completions'
      : '/responses'
}
