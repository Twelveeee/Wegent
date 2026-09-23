import { parseDocument, type Document } from 'yaml'
import type {
  ProviderDocument,
  ProviderConnection,
  ProviderFileModel,
} from './provider-config-types.js'
import { HostCapabilityError } from './capability-router.js'

export const MAX_PROVIDER_FILE_BYTES = 1024 * 1024
const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages']
const CONNECTION_FIELDS = [
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
]
const MODEL_FIELDS = [
  'id',
  'model_id',
  'display_name',
  'enabled',
  'api_format',
  'request_path',
  'settings',
]
const SETTINGS_FIELDS = [
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
]

function invalid(path: string, reason: string): never {
  // Do not include YAML source or supplied values: they may contain credentials.
  throw new HostCapabilityError('provider_config_invalid', `${path}: ${reason}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'expected a mapping')
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: string[], path: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key)))
    invalid(path, 'contains an unknown field')
}

function text(value: unknown, path: string, required = true): void {
  if (value === undefined && !required) return
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 8192) {
    invalid(path, 'expected text')
  }
}

function id(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(value)) {
    invalid(path, 'use a stable lowercase ID containing letters, digits, underscores or hyphens')
  }
}

function flag(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') invalid(path, 'expected true or false')
}

function format(value: unknown, path: string, required = false): void {
  if (value === undefined && !required) return
  if (!FORMATS.includes(String(value))) invalid(path, 'unsupported API format')
}

function requestPath(value: unknown, path: string): void {
  if (value === undefined) return
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[#\s]/.test(value)
  ) {
    invalid(path, 'expected a relative API path beginning with /')
  }
}

export function validateProviderDocument(value: unknown): ProviderDocument {
  const root = object(value, 'document')
  fields(root, ['version', 'providers'], 'document')
  if (root.version !== 1) invalid('version', 'only version 1 is supported')
  if (!Array.isArray(root.providers) || root.providers.length > 200)
    invalid('providers', 'expected at most 200 connections')
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  for (const [index, rawProvider] of root.providers.entries()) {
    const path = `providers[${index}]`
    const provider = object(rawProvider, path)
    fields(provider, CONNECTION_FIELDS, path)
    id(provider.id, `${path}.id`)
    if (providerIds.has(String(provider.id))) invalid(`${path}.id`, 'duplicate provider ID')
    providerIds.add(String(provider.id))
    text(provider.name, `${path}.name`)
    text(provider.base_url, `${path}.base_url`)
    let url: URL
    try {
      url = new URL(String(provider.base_url))
    } catch {
      invalid(`${path}.base_url`, 'expected an absolute HTTP(S) URL')
    }
    if (
      !['http:', 'https:'].includes(url!.protocol) ||
      url!.username ||
      url!.password ||
      url!.search ||
      url!.hash
    ) {
      invalid(`${path}.base_url`, 'use an HTTP(S) URL without credentials, query or fragment')
    }
    format(provider.api_format, `${path}.api_format`, true)
    requestPath(provider.request_path, `${path}.request_path`)
    requestPath(provider.models_path, `${path}.models_path`)
    flag(provider.enabled, `${path}.enabled`)
    text(provider.api_key, `${path}.api_key`, false)
    text(provider.api_key_ref, `${path}.api_key_ref`, false)
    if (provider.api_key !== undefined && provider.api_key_ref !== undefined)
      invalid(path, 'choose api_key or api_key_ref, not both')
    if (
      provider.api_key_ref !== undefined &&
      !/^model-provider\.[a-z0-9-]+$/.test(String(provider.api_key_ref))
    )
      invalid(`${path}.api_key_ref`, 'invalid credential reference')
    if (!Array.isArray(provider.models) || provider.models.length > 2000)
      invalid(`${path}.models`, 'expected at most 2000 models')
    const upstreamIds = new Set<string>()
    for (const [modelIndex, rawModel] of provider.models.entries()) {
      const modelPath = `${path}.models[${modelIndex}]`
      const model = object(rawModel, modelPath)
      fields(model, MODEL_FIELDS, modelPath)
      id(model.id, `${modelPath}.id`)
      if (modelIds.has(String(model.id))) invalid(`${modelPath}.id`, 'duplicate model ID')
      modelIds.add(String(model.id))
      text(model.model_id, `${modelPath}.model_id`)
      const upstream = `${String(model.api_format ?? provider.api_format)}:${String(model.model_id).trim()}`
      if (upstreamIds.has(upstream))
        invalid(
          `${modelPath}.model_id`,
          'model already configured for this connection and protocol'
        )
      upstreamIds.add(upstream)
      text(model.display_name, `${modelPath}.display_name`, false)
      format(model.api_format, `${modelPath}.api_format`)
      requestPath(model.request_path, `${modelPath}.request_path`)
      flag(model.enabled, `${modelPath}.enabled`)
      if (model.settings !== undefined)
        validateSettings(model.settings, modelPath, String(model.api_format ?? provider.api_format))
    }
  }
  const document = root as unknown as ProviderDocument
  for (const provider of document.providers)
    for (const model of provider.models) {
      const visionId = model.settings?.visionModelConfigId
      if (visionId === model.id)
        invalid('settings.visionModelConfigId', 'cannot reference the same model')
      // Cross-source legacy references are checked by the renderer against the combined catalog.
    }
  return document
}

function validateSettings(value: unknown, path: string, apiFormat: string): void {
  const settings = object(value, `${path}.settings`)
  fields(settings, SETTINGS_FIELDS, `${path}.settings`)
  for (const field of ['providerProfileId', 'group', 'visionModelConfigId', 'codexCatalogModelId'])
    text(settings[field], `${path}.settings.${field}`, false)
  if (
    settings.contextWindow !== undefined &&
    (!Number.isSafeInteger(settings.contextWindow) || Number(settings.contextWindow) <= 0)
  )
    invalid(`${path}.settings.contextWindow`, 'expected a positive integer')
  if (
    settings.toolProfile !== undefined &&
    !['custom', 'function', 'shell'].includes(String(settings.toolProfile))
  )
    invalid(`${path}.settings.toolProfile`, 'invalid tool profile')
  if (settings.toolProfile === 'custom' && apiFormat !== 'openai-responses')
    invalid(`${path}.settings.toolProfile`, 'custom tools require Responses')
  if (
    settings.codexToolCompatibility !== undefined &&
    !['native', 'standard'].includes(String(settings.codexToolCompatibility))
  )
    invalid(`${path}.settings.codexToolCompatibility`, 'invalid tool compatibility')
  if (
    settings.webSearchMode !== undefined &&
    !['disabled', 'cached', 'live'].includes(String(settings.webSearchMode))
  )
    invalid(`${path}.settings.webSearchMode`, 'invalid search mode')
  flag(settings.imageGenerationEnabled, `${path}.settings.imageGenerationEnabled`)
  if (settings.catalogEntry !== undefined)
    object(settings.catalogEntry, `${path}.settings.catalogEntry`)
}

export function parseProviderFile(source: string): { yaml: Document; config: ProviderDocument } {
  if (Buffer.byteLength(source, 'utf8') > MAX_PROVIDER_FILE_BYTES)
    invalid('document', 'file exceeds 1 MiB')
  const yaml = parseDocument(source, {
    uniqueKeys: true,
    prettyErrors: false,
    strict: true,
    schema: 'core',
  })
  if (yaml.errors.length || yaml.warnings.length) {
    const error = yaml.errors[0] ?? yaml.warnings[0]
    const offset = error.pos?.[0] ?? 0
    const line = source.slice(0, offset).split('\n').length
    invalid(`line ${line}`, 'invalid YAML syntax, duplicate key, or unsupported tag')
  }
  let value: unknown
  try {
    value = yaml.toJS({ maxAliasCount: 0 })
  } catch {
    invalid('document', 'YAML aliases are not supported')
  }
  return { yaml: yaml as Document, config: validateProviderDocument(value) }
}

export function effectiveProviderPath(
  provider: ProviderConnection,
  model?: ProviderFileModel
): string {
  if (model?.request_path) return model.request_path
  if ((!model?.api_format || model.api_format === provider.api_format) && provider.request_path)
    return provider.request_path
  const apiFormat = model?.api_format ?? provider.api_format
  if (apiFormat === 'openai-chat-completions') return '/chat/completions'
  if (apiFormat === 'anthropic-messages') return '/messages'
  return '/responses'
}
