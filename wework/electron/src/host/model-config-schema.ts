import { createHash } from 'node:crypto'
import { isAlias, LineCounter, parseDocument, visit } from 'yaml'
import { HostCapabilityError } from './capability-router.js'

export type ProviderApiFormat = 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'
export interface ProviderModelDefinition {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  api_format?: ProviderApiFormat
  request_path?: string
  context_window?: number
  tool_profile?: 'custom' | 'function' | 'shell'
  codex_tool_compatibility?: 'native' | 'standard'
  web_search_mode?: 'disabled' | 'cached' | 'live'
  image_generation_enabled?: boolean
  vision_model_config_id?: string
  codex_catalog_model_id?: string
  catalog_entry?: Record<string, unknown>
  group?: string
  provider_profile_id?: string
}
export interface ProviderDefinition {
  id: string
  name: string
  base_url: string
  api_format?: ProviderApiFormat
  request_path?: string
  models_path?: string
  models_base_url?: string
  models_api_key_header?: 'Authorization' | 'X-Api-Key'
  api_key?: string
  api_key_ref?: string
  tool_profile?: 'custom' | 'function' | 'shell'
  codex_tool_compatibility?: 'native' | 'standard'
  enabled?: boolean
  models: ProviderModelDefinition[]
}
export interface ModelConfigDocument {
  version: 1
  providers: ProviderDefinition[]
  migrated_model_ids?: string[]
}
export const EMPTY_MODEL_CONFIG = '# Local providers only. Cloud models are managed separately.\nversion: 1\nproviders: []\n'
export const MODEL_CONFIG_MAX_BYTES = 2 * 1024 * 1024
export const MODEL_KEY_PREFIX = 'wework.model-provider.'
const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages']
const MODEL_FIELDS = ['id', 'model_id', 'display_name', 'enabled', 'api_format', 'request_path', 'context_window', 'tool_profile', 'codex_tool_compatibility', 'web_search_mode', 'image_generation_enabled', 'vision_model_config_id', 'codex_catalog_model_id', 'catalog_entry', 'group', 'provider_profile_id']
const PROVIDER_FIELDS = ['id', 'name', 'base_url', 'api_format', 'request_path', 'models_path', 'models_base_url', 'models_api_key_header', 'api_key', 'api_key_ref', 'tool_profile', 'codex_tool_compatibility', 'enabled', 'models']

export function configError(code: string, message: string): never {
  throw new HostCapabilityError(code, message)
}
export function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) configError('model_config_invalid', `${field}: expected an object`)
  return value as Record<string, unknown>
}
function allowedFields(value: Record<string, unknown>, fields: string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) configError('model_config_invalid', `${field}: unknown field (check the configuration reference)`)
  }
}
export function text(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f]/.test(value)) configError('model_config_invalid', `${field}: expected non-empty text`)
  return value.trim()
}
function identifier(value: unknown, field: string): string {
  const result = text(value, field)!
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(result)) configError('model_config_invalid', `${field}: use a stable identifier containing letters, digits, dots, underscores or hyphens`)
  return result
}
export function httpUrl(value: unknown, field: string): string {
  const result = text(value, field)!
  try {
    const url = new URL(result)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch {
    configError('model_config_invalid', `${field}: expected an HTTP(S) base URL without credentials, query or fragment`)
  }
  return result.replace(/\/+$/, '')
}
function optionalEnum(value: unknown, choices: readonly string[], field: string): void {
  if (value !== undefined && !choices.includes(value as string)) configError('model_config_invalid', `${field}: unsupported value`)
}
function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') configError('model_config_invalid', `${field}: expected true or false`)
}
function optionalPath(value: unknown, field: string): void {
  if (value === undefined) return
  const path = text(value, field)!
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.includes('?') || path.includes('://') || path.split('/').includes('..')) configError('model_config_invalid', `${field}: expected an API path beginning with /`)
}
export function effectiveApiFormat(provider: ProviderDefinition, model?: ProviderModelDefinition): ProviderApiFormat {
  return model?.api_format ?? provider.api_format ?? 'openai-responses'
}
export function defaultRequestPath(format: ProviderApiFormat, baseUrl: string): string {
  if (format === 'openai-chat-completions') return '/chat/completions'
  if (format === 'anthropic-messages') return baseUrl.replace(/\/+$/, '').endsWith('/v1') ? '/messages' : '/v1/messages'
  return '/responses'
}
export function effectiveRequestPath(provider: ProviderDefinition, model?: ProviderModelDefinition): string {
  if (model?.request_path) return model.request_path
  if (!model?.api_format || model.api_format === effectiveApiFormat(provider)) {
    if (provider.request_path) return provider.request_path
  }
  return defaultRequestPath(effectiveApiFormat(provider, model), provider.base_url)
}
function validateCommon(value: Record<string, unknown>, field: string): void {
  optionalEnum(value.api_format, FORMATS, `${field}.api_format`)
  optionalEnum(value.tool_profile, ['custom', 'function', 'shell'], `${field}.tool_profile`)
  optionalEnum(value.codex_tool_compatibility, ['native', 'standard'], `${field}.codex_tool_compatibility`)
  optionalBoolean(value.enabled, `${field}.enabled`)
  optionalPath(value.request_path, `${field}.request_path`)
}
function validateModel(value: unknown, provider: ProviderDefinition, field: string): ProviderModelDefinition {
  const model = record(value, field)
  allowedFields(model, MODEL_FIELDS, field)
  identifier(model.id, `${field}.id`)
  text(model.model_id, `${field}.model_id`)
  for (const name of ['display_name', 'group', 'codex_catalog_model_id', 'provider_profile_id']) text(model[name], `${field}.${name}`, false)
  if (model.vision_model_config_id !== undefined) identifier(model.vision_model_config_id, `${field}.vision_model_config_id`)
  validateCommon(model, field)
  optionalEnum(model.web_search_mode, ['disabled', 'cached', 'live'], `${field}.web_search_mode`)
  optionalBoolean(model.image_generation_enabled, `${field}.image_generation_enabled`)
  if (model.context_window !== undefined && (!Number.isSafeInteger(model.context_window) || Number(model.context_window) <= 0)) configError('model_config_invalid', `${field}.context_window: expected a positive integer`)
  if (model.catalog_entry !== undefined) record(model.catalog_entry, `${field}.catalog_entry`)
  const typed = model as unknown as ProviderModelDefinition
  const format = effectiveApiFormat(provider, typed)
  if ((typed.tool_profile ?? provider.tool_profile) === 'custom' && format !== 'openai-responses') configError('model_config_invalid', `${field}.tool_profile: native custom tools require Responses`)
  return typed
}
export function validateModelConfig(value: unknown): ModelConfigDocument {
  const config = record(value, 'document')
  allowedFields(config, ['version', 'providers', 'migrated_model_ids'], 'document')
  if (config.version !== 1) configError('model_config_version', 'Unsupported model configuration version; expected version: 1')
  if (!Array.isArray(config.providers) || config.providers.length > 128) configError('model_config_invalid', 'providers: expected at most 128 providers')
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  const allModels: ProviderModelDefinition[] = []
  for (const [index, value] of config.providers.entries()) {
    const field = `providers[${index}]`
    const provider = record(value, field)
    allowedFields(provider, PROVIDER_FIELDS, field)
    const id = identifier(provider.id, `${field}.id`)
    if (providerIds.has(id)) configError('model_config_duplicate', `${field}.id: duplicate provider ID`)
    providerIds.add(id)
    text(provider.name, `${field}.name`)
    httpUrl(provider.base_url, `${field}.base_url`)
    if (provider.models_base_url !== undefined) httpUrl(provider.models_base_url, `${field}.models_base_url`)
    validateCommon(provider, field)
    optionalPath(provider.models_path, `${field}.models_path`)
    optionalEnum(provider.models_api_key_header, ['Authorization', 'X-Api-Key'], `${field}.models_api_key_header`)
    text(provider.api_key, `${field}.api_key`, false)
    if (provider.api_key_ref !== undefined) {
      const key = text(provider.api_key_ref, `${field}.api_key_ref`)!
      if (!key.startsWith(MODEL_KEY_PREFIX) || !/^[a-zA-Z0-9._-]{1,160}$/.test(key)) configError('model_config_invalid', `${field}.api_key_ref: expected a WeWork model-provider credential reference`)
    }
    if (provider.api_key && provider.api_key_ref) configError('model_config_invalid', `${field}: use api_key OR api_key_ref, not both`)
    if (!Array.isArray(provider.models)) configError('model_config_invalid', `${field}.models: expected a list`)
    for (const [modelIndex, value] of provider.models.entries()) {
      const model = validateModel(value, provider as unknown as ProviderDefinition, `${field}.models[${modelIndex}]`)
      if (modelIds.has(model.id)) configError('model_config_duplicate', `${field}.models[${modelIndex}].id: duplicate model ID`)
      modelIds.add(model.id)
      allModels.push(model)
    }
  }
  if (allModels.length > 4096) configError('model_config_invalid', 'Too many models; maximum is 4096')
  for (const model of allModels) {
    if (model.vision_model_config_id && (model.vision_model_config_id === model.id || !modelIds.has(model.vision_model_config_id))) configError('model_config_invalid', 'vision_model_config_id: reference must identify another model in this file')
  }
  if (config.migrated_model_ids !== undefined) {
    if (!Array.isArray(config.migrated_model_ids)) configError('model_config_invalid', 'migrated_model_ids: expected a list')
    for (const id of config.migrated_model_ids) identifier(id, 'migrated_model_ids')
  }
  return config as unknown as ModelConfigDocument
}
export function parseModelConfig(source: string) {
  if (Buffer.byteLength(source) > MODEL_CONFIG_MAX_BYTES) configError('model_config_too_large', 'Model configuration exceeds 2 MiB')
  const lines = new LineCounter()
  const document = parseDocument(source, { lineCounter: lines, prettyErrors: false, uniqueKeys: true, version: '1.2', logLevel: 'silent' })
  const issue = document.errors[0] ?? document.warnings[0]
  if (issue) {
    const position = lines.linePos(issue.pos[0])
    configError('model_config_yaml', `Invalid YAML at line ${position.line}, column ${position.col} (${issue.code}); file content is omitted to protect credentials`)
  }
  visit(document, (_key, node) => {
    if (isAlias(node)) configError('model_config_yaml', 'YAML aliases are not supported; use provider inheritance instead')
  })
  let data: unknown
  try { data = document.toJS({ maxAliasCount: 0 }) } catch { configError('model_config_yaml', 'Cannot decode model configuration') }
  return { document, config: validateModelConfig(data) }
}
export function configRevision(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}
export function publicProvider(provider: ProviderDefinition): Omit<ProviderDefinition, 'api_key'> & { api_key_configured: boolean } {
  const { api_key, ...rest } = provider
  return { ...rest, api_key_configured: Boolean(api_key || provider.api_key_ref) }
}
