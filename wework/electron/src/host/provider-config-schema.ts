import { isAlias, LineCounter, parseDocument, visit } from 'yaml'
import type {
  ProviderApiFormat,
  ProviderConnection,
  ProviderDocument,
  ProviderModelEntry,
} from '../../../shared/provider-model-config.js'

const FORMATS: readonly string[] = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
]
const CONNECTION_KEYS = new Set([
  'id',
  'name',
  'base_url',
  'api_format',
  'request_path',
  'models_path',
  'enabled',
  'api_key',
  'api_key_ref',
  'models',
])
const MODEL_KEYS = new Set([
  'id',
  'model_id',
  'display_name',
  'enabled',
  'group',
  'api_format',
  'request_path',
  'context_window',
  'tool_profile',
  'codex_tool_compatibility',
  'web_search_mode',
  'image_generation_enabled',
  'vision_model_config_id',
  'provider_profile_id',
  'codex_catalog_model_id',
  'catalog',
])
export const MAX_PROVIDER_CONFIG_BYTES = 2 * 1024 * 1024

export function providerRequestPath(format: ProviderApiFormat): string {
  return format === 'anthropic-messages'
    ? '/v1/messages'
    : format === 'openai-chat-completions'
      ? '/chat/completions'
      : '/responses'
}
function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${location}: expected an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${location}: expected a non-empty string`)
  return value.trim()
}
function keys(value: Record<string, unknown>, allowed: Set<string>, location: string): void {
  if (Object.keys(value).some(key => !allowed.has(key)))
    throw new Error(`${location}: unsupported field; check the version 1 schema`)
}
function optionalText(value: Record<string, unknown>, name: string, location: string): void {
  if (value[name] !== undefined) text(value[name], `${location}.${name}`)
}
function optionalBoolean(value: Record<string, unknown>, name: string, location: string): void {
  if (value[name] !== undefined && typeof value[name] !== 'boolean')
    throw new Error(`${location}.${name}: expected true or false`)
}
function choice(value: unknown, allowed: readonly string[], location: string): void {
  if (value !== undefined && !allowed.includes(value as string))
    throw new Error(`${location}: unsupported value`)
}
function path(value: unknown, location: string): void {
  if (value === undefined) return
  const parsed = text(value, location)
  if (!parsed.startsWith('/') || parsed.startsWith('//') || /[?#\\]/.test(parsed))
    throw new Error(`${location}: expected a relative API path beginning with /`)
}
function model(value: unknown, location: string, provider: ProviderConnection): ProviderModelEntry {
  const entry = record(value, location)
  keys(entry, MODEL_KEYS, location)
  text(entry.id, `${location}.id`)
  text(entry.model_id, `${location}.model_id`)
  for (const key of [
    'display_name',
    'group',
    'vision_model_config_id',
    'provider_profile_id',
    'codex_catalog_model_id',
  ])
    optionalText(entry, key, location)
  optionalBoolean(entry, 'enabled', location)
  optionalBoolean(entry, 'image_generation_enabled', location)
  choice(entry.api_format, FORMATS, `${location}.api_format`)
  choice(entry.tool_profile, ['custom', 'function', 'shell'], `${location}.tool_profile`)
  choice(
    entry.codex_tool_compatibility,
    ['native', 'standard'],
    `${location}.codex_tool_compatibility`
  )
  choice(entry.web_search_mode, ['disabled', 'cached', 'live'], `${location}.web_search_mode`)
  path(entry.request_path, `${location}.request_path`)
  if (
    entry.context_window !== undefined &&
    (!Number.isSafeInteger(entry.context_window) || Number(entry.context_window) <= 0)
  )
    throw new Error(`${location}.context_window: expected a positive integer`)
  if (
    entry.tool_profile === 'custom' &&
    (entry.api_format ?? provider.api_format) !== 'openai-responses'
  )
    throw new Error(`${location}.tool_profile: custom tools require Responses`)
  if (entry.catalog !== undefined) {
    const catalog = record(entry.catalog, `${location}.catalog`)
    optionalText(catalog, 'slug', `${location}.catalog`)
  }
  return entry as unknown as ProviderModelEntry
}
export function validateProviderDocument(value: unknown): ProviderDocument {
  const root = record(value, 'document')
  keys(root, new Set(['version', 'providers']), 'document')
  if (root.version !== 1) throw new Error('version: expected 1')
  if (!Array.isArray(root.providers)) throw new Error('providers: expected an array')
  if (root.providers.length > 100) throw new Error('providers: maximum 100 connections')
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  const catalogIds = new Set<string>()
  const models: ProviderModelEntry[] = []
  root.providers.forEach((value, index) => {
    const location = `providers[${index}]`
    const provider = record(value, location)
    keys(provider, CONNECTION_KEYS, location)
    const id = text(provider.id, `${location}.id`)
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || providerIds.has(id))
      throw new Error(`${location}.id: invalid or duplicate connection ID`)
    providerIds.add(id)
    text(provider.name, `${location}.name`)
    let url: URL
    try {
      url = new URL(text(provider.base_url, `${location}.base_url`))
    } catch {
      throw new Error(`${location}.base_url: expected a valid HTTP(S) URL`)
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        `${location}.base_url: expected an HTTP(S) base URL without credentials, query or fragment`
      )
    if (!FORMATS.includes(provider.api_format as string))
      throw new Error(`${location}.api_format: unsupported protocol`)
    optionalBoolean(provider, 'enabled', location)
    for (const name of ['request_path', 'models_path']) path(provider[name], `${location}.${name}`)
    if (provider.api_key !== undefined && typeof provider.api_key !== 'string')
      throw new Error(`${location}.api_key: expected a string`)
    optionalText(provider, 'api_key_ref', location)
    if (provider.api_key !== undefined && provider.api_key_ref !== undefined)
      throw new Error(`${location}: use api_key or api_key_ref, not both`)
    if (
      provider.api_key_ref !== undefined &&
      !/^wework-model-[a-zA-Z0-9._-]+$/.test(String(provider.api_key_ref))
    )
      throw new Error(`${location}.api_key_ref: expected a WeWork model credential reference`)
    if (!Array.isArray(provider.models) || provider.models.length > 1000)
      throw new Error(`${location}.models: expected an array of at most 1000 models`)
    provider.models.forEach((value, modelIndex) => {
      const entry = model(
        value,
        `${location}.models[${modelIndex}]`,
        provider as unknown as ProviderConnection
      )
      if (modelIds.has(entry.id))
        throw new Error(`${location}.models[${modelIndex}].id: duplicate model identity`)
      modelIds.add(entry.id)
      const custom = !entry.provider_profile_id || entry.provider_profile_id === 'custom'
      const generated = `wework-custom-${
        entry.id
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'model'
      }`
      const slug = entry.catalog?.slug ?? (custom ? generated : undefined)
      if (typeof slug === 'string') {
        if (catalogIds.has(slug))
          throw new Error(`${location}.models[${modelIndex}].catalog: duplicate catalog identity`)
        catalogIds.add(slug)
      }
      models.push(entry)
    })
  })
  for (const entry of models) {
    if (entry.vision_model_config_id === entry.id)
      throw new Error('vision_model_config_id: a model cannot reference itself')
  }
  return root as unknown as ProviderDocument
}

export function parseProviderYaml(source: string) {
  if (Buffer.byteLength(source, 'utf8') > MAX_PROVIDER_CONFIG_BYTES)
    throw new Error('Model configuration exceeds 2 MiB')
  const lineCounter = new LineCounter()
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
  })
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem) {
    const point = lineCounter.linePos(problem.pos[0])
    // Parser messages can contain credentials from the offending source line.
    throw new Error(`Invalid YAML (${problem.code}) at line ${point.line}, column ${point.col}`)
  }
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) throw new Error('YAML aliases are not supported in model configuration')
    },
  })
  const data = validateProviderDocument(document.toJS({ maxAliasCount: 0 }))
  return { document, data }
}
