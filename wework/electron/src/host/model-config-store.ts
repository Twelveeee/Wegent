import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Document } from 'yaml'
import { HostCapabilityError } from './capability-router.js'
import type { SecureValueStore } from './secure-value-store.js'
import {
  configError, configRevision, effectiveRequestPath, EMPTY_MODEL_CONFIG, MODEL_CONFIG_MAX_BYTES,
  MODEL_KEY_PREFIX, parseModelConfig, publicProvider, record, text, validateModelConfig,
  type ModelConfigDocument, type ProviderDefinition, type ProviderModelDefinition,
} from './model-config-schema.js'

const BACKUP_KEY = 'wework.model-config.last-good'
interface AcceptedConfig { path: string; source: string; revision: string; config: ModelConfigDocument }
export interface ModelConfigSnapshot {
  path: string
  revision: string
  providers: Array<ReturnType<typeof publicProvider>>
  migratedModelIds: string[]
  error: { code: string; message: string } | null
}
export interface ModelConfigMutation {
  kind: 'provider.save' | 'provider.delete' | 'models.save' | 'model.delete' | 'migrate'
  revision: string
  providerId?: string
  provider?: Record<string, unknown>
  apiKey?: string
  clearKey?: boolean
  models?: Record<string, unknown>[]
  modelId?: string
  configs?: Record<string, unknown>[]
}
function issue(error: unknown): { code: string; message: string } {
  if (error instanceof HostCapabilityError) return { code: error.code, message: error.message }
  const code = (error as NodeJS.ErrnoException)?.code
  return { code: 'model_config_io', message: code === 'ENOENT' ? 'Configuration file is missing; restore it or choose another YAML file' : 'Cannot access model configuration; check file permissions' }
}

/** The selected local YAML file is the only authority for provider-managed models. */
export class ModelConfigStore {
  private operation: Promise<unknown> = Promise.resolve()
  private selectedPath: string | null = null
  private accepted: AcceptedConfig | null = null
  private lastIssue: ModelConfigSnapshot['error'] = null

  constructor(private readonly dataDirectory: string, private readonly secrets: Pick<SecureValueStore, 'get' | 'set' | 'delete'>) {}

  read(): Promise<ModelConfigSnapshot> { return this.serial(() => this.readCurrent()) }
  bind(path: string): Promise<ModelConfigSnapshot> {
    return this.serial(async () => {
      const selected = resolve(path)
      if (!/\.ya?ml$/i.test(selected)) configError('model_config_invalid', 'Choose a .yml or .yaml file')
      const candidate = await this.load(selected)
      await this.atomicWrite(this.bindingPath(), JSON.stringify({ version: 1, path: selected }))
      this.selectedPath = selected
      await this.accept(candidate)
      return this.snapshot()
    })
  }
  mutate(input: ModelConfigMutation): Promise<ModelConfigSnapshot> {
    return this.serial(async () => {
      const path = await this.path()
      const current = await this.load(path)
      if (!input.revision || current.revision !== input.revision) configError('model_config_conflict', 'Configuration changed outside this form. Reload, review the changes and save again')
      const { document } = parseModelConfig(current.source)
      const createdKeys: string[] = []
      let committed = false
      try {
        await this.applyMutation(document, current.config, input, createdKeys)
        const nextSource = document.toString({ lineWidth: 0 })
        const next = parseModelConfig(nextSource).config
        await this.atomicWrite(path, nextSource, current.revision)
        committed = true
        await this.accept({ path, source: nextSource, revision: configRevision(nextSource), config: next })
        return this.snapshot()
      } catch (error) {
        // A failed CAS must never rotate credentials for the last valid configuration.
        if (!committed) for (const key of createdKeys) await this.secrets.delete(key)
        throw error
      }
    })
  }
  resolveCredential(modelId: string, revision: string): Promise<{ apiKey?: string; requestUrl: string }> {
    return this.serial(async () => {
      if (!this.accepted) await this.readCurrent()
      if (!this.accepted || this.accepted.revision !== revision) configError('model_config_conflict', 'Model configuration changed. Refresh the model list and retry')
      const provider = this.accepted.config.providers.find(item => item.models.some(model => model.id === modelId))
      const model = provider?.models.find(item => item.id === modelId)
      if (!provider || !model) configError('model_config_missing', 'This local model is no longer configured')
      if (provider.enabled === false || model.enabled === false) configError('model_config_disabled', 'This local provider or model is disabled')
      const apiKey = provider.api_key_ref ? await this.secrets.get(provider.api_key_ref) : provider.api_key
      if (provider.api_key_ref && !apiKey) configError('model_config_key_missing', 'The provider credential is unavailable on this device. Enter its API key in provider settings')
      return { ...(apiKey ? { apiKey } : {}), requestUrl: provider.base_url.replace(/\/+$/, '') + effectiveRequestPath(provider, model) }
    })
  }
  discover(providerId: string, revision: string): Promise<Array<{ id: string; displayName: string }>> {
    return this.serial(async () => {
      if (!this.accepted) await this.readCurrent()
      if (!this.accepted || this.accepted.revision !== revision) configError('model_config_conflict', 'Configuration changed. Reload before discovering models')
      const provider = this.accepted.config.providers.find(item => item.id === providerId)
      if (!provider) configError('model_config_missing', 'Provider is no longer configured')
      const baseUrl = (provider.models_base_url ?? provider.base_url).replace(/\/+$/, '')
      const apiKey = provider.api_key_ref ? await this.secrets.get(provider.api_key_ref) : provider.api_key
      if (provider.api_key_ref && !apiKey) configError('model_config_key_missing', 'Enter the provider API key on this device')
      const headers: Record<string, string> = {}
      if (apiKey) {
        if (provider.models_api_key_header === 'X-Api-Key') headers['X-Api-Key'] = apiKey
        else headers.Authorization = `Bearer ${apiKey}`
      }
      try {
        const response = await fetch(baseUrl + (provider.models_path ?? '/models'), { headers, signal: AbortSignal.timeout(15_000), redirect: 'error' })
        if (!response.ok) configError('model_config_discovery', `Model discovery returned HTTP ${response.status}; manual model entry remains available`)
        const body = await response.text()
        if (Buffer.byteLength(body) > MODEL_CONFIG_MAX_BYTES) configError('model_config_discovery', 'Provider model list is too large')
        const data = (JSON.parse(body) as { data?: unknown }).data
        if (!Array.isArray(data)) configError('model_config_discovery', 'Provider did not return an OpenAI-compatible model list; add model IDs manually')
        const ids = [...new Set(data.flatMap(item => item && typeof item.id === 'string' && item.id.trim() ? [item.id.trim()] : []))] as string[]
        return ids.slice(0, 4096).map(id => ({ id, displayName: id }))
      } catch (error) {
        if (error instanceof HostCapabilityError) throw error
        configError('model_config_discovery', 'Cannot load provider models. Check the URL/key or add model IDs manually')
      }
    })
  }
  private async path(): Promise<string> {
    if (this.selectedPath) return this.selectedPath
    await mkdir(join(this.dataDirectory, 'model-config'), { recursive: true, mode: 0o700 })
    try {
      const binding = JSON.parse(await readFile(this.bindingPath(), 'utf8')) as { version?: number; path?: unknown }
      if (binding.version !== 1 || typeof binding.path !== 'string') configError('model_config_binding', 'Invalid model configuration binding')
      this.selectedPath = resolve(binding.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const path = join(this.dataDirectory, 'model-config', 'model.yml')
      try { await writeFile(path, EMPTY_MODEL_CONFIG, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await this.atomicWrite(this.bindingPath(), JSON.stringify({ version: 1, path }))
      this.selectedPath = path
    }
    return this.selectedPath
  }
  private bindingPath(): string { return join(this.dataDirectory, 'model-config', 'binding.json') }
  private async load(path: string): Promise<AcceptedConfig> {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > MODEL_CONFIG_MAX_BYTES) configError('model_config_too_large', 'Choose a regular YAML file smaller than 2 MiB')
    const source = await readFile(path, 'utf8')
    return { path, source, revision: configRevision(source), config: parseModelConfig(source).config }
  }
  private async readCurrent(): Promise<ModelConfigSnapshot> {
    const path = await this.path()
    try {
      await this.accept(await this.load(path))
    } catch (error) {
      this.lastIssue = issue(error)
      if (!this.accepted) {
        try {
          const saved = await this.secrets.get(BACKUP_KEY)
          const backup = saved ? JSON.parse(saved) as { path?: string; source?: string } : null
          if (backup?.path === path && typeof backup.source === 'string') {
            this.accepted = { path, source: backup.source, revision: configRevision(backup.source), config: parseModelConfig(backup.source).config }
          }
        } catch { /* A corrupt backup cannot replace the configuration file. */ }
      }
    }
    return this.snapshot()
  }
  private async accept(candidate: AcceptedConfig): Promise<void> {
    this.lastIssue = null
    if (this.accepted?.revision === candidate.revision && this.accepted.path === candidate.path) return
    this.accepted = candidate
    try { await this.secrets.set(BACKUP_KEY, JSON.stringify({ path: candidate.path, source: candidate.source })) }
    catch { this.lastIssue = { code: 'model_config_backup', message: 'Configuration is loaded, but its encrypted recovery copy could not be saved' } }
  }
  private async snapshot(): Promise<ModelConfigSnapshot> {
    const providers = await Promise.all((this.accepted?.config.providers ?? []).map(async provider => {
      const result = publicProvider(provider)
      if (provider.api_key_ref) result.api_key_configured = Boolean(await this.secrets.get(provider.api_key_ref))
      return result
    }))
    return { path: this.selectedPath ?? this.accepted?.path ?? '', revision: this.accepted?.revision ?? '', providers, migratedModelIds: this.accepted?.config.migrated_model_ids ?? [], error: this.lastIssue }
  }
  private async applyMutation(document: Document, config: ModelConfigDocument, input: ModelConfigMutation, createdKeys: string[]): Promise<void> {
    if (input.kind === 'migrate') {
      await this.migrate(document, config, input.configs ?? [], createdKeys)
      return
    }
    const id = text(input.providerId ?? input.provider?.id, 'providerId')!
    const index = config.providers.findIndex(provider => provider.id === id)
    if (input.kind === 'provider.save') {
      const fields = { ...record(input.provider, 'provider') }
      if ('models' in fields || 'api_key' in fields || 'api_key_ref' in fields) configError('model_config_invalid', 'Provider form must use the dedicated models and credential actions')
      if (index >= 0 && fields.id !== undefined && fields.id !== id) configError('model_config_invalid', 'Provider ID cannot be changed in an edit')
      const target = index < 0 ? config.providers.length : index
      if (index < 0) document.addIn(['providers'], { ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null)), models: [] })
      else this.patch(document, ['providers', target], fields)
      if (input.clearKey || input.apiKey?.trim()) {
        document.deleteIn(['providers', target, 'api_key'])
        document.deleteIn(['providers', target, 'api_key_ref'])
        if (input.apiKey?.trim()) {
          const key = MODEL_KEY_PREFIX + randomUUID()
          await this.secrets.set(key, text(input.apiKey, 'apiKey')!)
          createdKeys.push(key)
          document.setIn(['providers', target, 'api_key_ref'], key)
        }
      }
      return
    }
    if (index < 0) configError('model_config_missing', 'Provider is no longer configured')
    if (input.kind === 'provider.delete') { document.deleteIn(['providers', index]); return }
    if (input.kind === 'model.delete') {
      const modelIndex = config.providers[index].models.findIndex(model => model.id === input.modelId)
      if (modelIndex < 0) configError('model_config_missing', 'Model is no longer configured')
      document.deleteIn(['providers', index, 'models', modelIndex])
      return
    }
    if (input.kind !== 'models.save' || !Array.isArray(input.models)) configError('model_config_invalid', 'Unknown model configuration operation')
    const ids = config.providers[index].models.map(model => model.id)
    for (const value of input.models) {
      const model = record(value, 'model')
      const id = text(model.id, 'model.id')!
      const modelIndex = ids.indexOf(id)
      if (modelIndex < 0) { document.addIn(['providers', index, 'models'], model); ids.push(id) }
      else this.patch(document, ['providers', index, 'models', modelIndex], model)
    }
  }
  private patch(document: Document, path: Array<string | number>, value: Record<string, unknown>): void {
    for (const [key, field] of Object.entries(value)) {
      if (field === null) document.deleteIn([...path, key])
      else if (field !== undefined) document.setIn([...path, key], field)
    }
  }
  private async migrate(document: Document, config: ModelConfigDocument, configs: Record<string, unknown>[], createdKeys: string[]): Promise<void> {
    if (!Array.isArray(configs) || configs.length > 4096) configError('model_config_invalid', 'Invalid legacy model list')
    const migrated = new Set(config.migrated_model_ids ?? [])
    const groups = new Map<string, ProviderDefinition>()
    for (const old of configs) {
      const id = text(old.id, 'legacy.id')!
      if (migrated.has(id)) continue
      const baseUrl = text(old.baseUrl, 'legacy.baseUrl')!.replace(/\/+$/, '')
      const apiKey = typeof old.apiKey === 'string' ? old.apiKey.trim() : ''
      const format = old.apiFormat ?? 'openai-responses'
      const key = JSON.stringify([baseUrl, apiKey, format, old.requestPath ?? null])
      let provider = groups.get(key)
      if (!provider) {
        provider = { id: randomUUID(), name: typeof old.group === 'string' && old.group ? old.group : `Imported connection ${groups.size + 1}`, base_url: baseUrl, api_format: format as ProviderDefinition['api_format'], ...(old.requestPath ? { request_path: String(old.requestPath) } : {}), models: [] }
        if (apiKey) {
          const ref = MODEL_KEY_PREFIX + randomUUID()
          await this.secrets.set(ref, apiKey)
          createdKeys.push(ref)
          provider.api_key_ref = ref
        }
        groups.set(key, provider)
      }
      const model: Record<string, unknown> = { id, model_id: text(old.modelId, 'legacy.modelId')! }
      const fields: Record<string, string> = { providerProfileId: 'provider_profile_id', displayName: 'display_name', group: 'group', enabled: 'enabled', contextWindow: 'context_window', toolProfile: 'tool_profile', codexToolCompatibility: 'codex_tool_compatibility', webSearchMode: 'web_search_mode', imageGenerationEnabled: 'image_generation_enabled', visionModelConfigId: 'vision_model_config_id', codexCatalogModelId: 'codex_catalog_model_id', catalogEntry: 'catalog_entry' }
      for (const [from, to] of Object.entries(fields)) if (old[from] !== undefined && old[from] !== '') model[to] = old[from]
      provider.models.push(model as unknown as ProviderModelDefinition)
      migrated.add(id)
    }
    for (const provider of groups.values()) document.addIn(['providers'], provider)
    document.set('migrated_model_ids', [...migrated])
    validateModelConfig(document.toJS({ maxAliasCount: 0 }))
  }
  private async atomicWrite(path: string, source: string, expectedRevision?: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, source, { flag: 'wx', mode: 0o600 })
      if (expectedRevision && configRevision(await readFile(path, 'utf8')) !== expectedRevision) configError('model_config_conflict', 'Configuration changed during save. Reload before retrying')
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}
