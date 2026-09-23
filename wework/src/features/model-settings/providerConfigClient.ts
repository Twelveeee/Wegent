import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { createDefaultLocalModelCatalogEntry } from './localModelCatalog'
import {
  defaultLocalModelToolProfile, LOCAL_MODEL_SETTINGS_CHANGED_EVENT, retireMigratedLocalModelConfigs,
  type LocalModelApiFormat, type LocalModelConfig,
} from './localModelSettings'
import { getProviderConfigState, getProviderModelConfigs, setProviderConfigState } from './providerConfigState'
import type { ProviderConfigSnapshot, ProviderDefinition, ProviderModelDefinition } from './providerConfigTypes'

let initialLoad: Promise<void> | null = null
let refreshInFlight: Promise<ProviderConfigSnapshot> | null = null
let unsubscribe: (() => void) | null = null
let requestVersion = 0

export function providerRequestPath(format: LocalModelApiFormat, baseUrl: string): string {
  if (format === 'openai-chat-completions') return '/chat/completions'
  if (format === 'anthropic-messages') return baseUrl.replace(/\/+$/, '').endsWith('/v1') ? '/messages' : '/v1/messages'
  return '/responses'
}
export function providerModelToLocalConfig(provider: ProviderDefinition, model: ProviderModelDefinition, previous?: LocalModelConfig): LocalModelConfig {
  const apiFormat = model.api_format ?? provider.api_format ?? 'openai-responses'
  const toolProfile = model.tool_profile ?? provider.tool_profile ?? defaultLocalModelToolProfile(apiFormat)
  const displayName = model.display_name || model.model_id
  const providerProfileId = model.provider_profile_id ?? 'custom'
  const catalogEntry = model.catalog_entry ?? (providerProfileId === 'custom' ? createDefaultLocalModelCatalogEntry({ id: model.id, displayName, toolProfile, contextWindow: model.context_window }) : undefined)
  const effectiveCatalog = catalogEntry ? { ...catalogEntry, display_name: displayName } : undefined
  const catalogReady = !effectiveCatalog || Boolean(previous?.catalogReady && JSON.stringify(previous.catalogEntry) === JSON.stringify(effectiveCatalog))
  const requestPath = model.request_path ?? ((!model.api_format || model.api_format === (provider.api_format ?? 'openai-responses')) ? provider.request_path : undefined) ?? providerRequestPath(apiFormat, provider.base_url)
  return {
    id: model.id,
    providerConnectionId: provider.id,
    providerProfileId,
    displayName,
    group: model.group ?? provider.name,
    modelId: model.model_id,
    baseUrl: provider.base_url.replace(/\/+$/, ''),
    apiFormat,
    toolProfile,
    codexToolCompatibility: apiFormat === 'openai-responses' ? model.codex_tool_compatibility ?? provider.codex_tool_compatibility ?? 'native' : 'standard',
    requestPath,
    apiKeyConfigured: provider.api_key_configured,
    contextWindow: model.context_window,
    webSearchMode: model.web_search_mode ?? 'disabled',
    imageGenerationEnabled: model.image_generation_enabled === true,
    visionModelConfigId: model.vision_model_config_id,
    codexCatalogModelId: model.codex_catalog_model_id ?? (typeof effectiveCatalog?.slug === 'string' ? effectiveCatalog.slug : undefined),
    catalogEntry: effectiveCatalog,
    catalogReady,
    enabled: provider.enabled !== false && model.enabled !== false,
    updatedAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString(),
  }
}
function applySnapshot(snapshot: ProviderConfigSnapshot): void {
  const previous = getProviderConfigState().snapshot
  const changed = previous?.revision !== snapshot.revision || previous?.path !== snapshot.path
  const configs = changed ? snapshot.providers.flatMap(provider => provider.models.map(model => providerModelToLocalConfig(provider, model, getProviderModelConfigs().find(item => item.id === model.id)))) : undefined
  setProviderConfigState({ snapshot, loading: false, error: snapshot.error?.message ?? null }, configs)
  retireMigratedLocalModelConfigs(snapshot.migratedModelIds)
  if (changed) window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, { detail: { configs: getProviderModelConfigs() } }))
}
export async function ensureProviderModelsLoaded(): Promise<void> {
  if (!isDesktopRuntime()) return
  unsubscribe ??= subscribeDesktopHostEvents(event => {
    if (event.type !== 'modelConfig.changed') return
    if (event.payload.revision === getProviderConfigState().snapshot?.revision) return
    void reloadProviderConfig().catch(() => undefined)
  })
  initialLoad ??= reloadProviderConfig().then(() => undefined, () => undefined)
  await initialLoad
}
export function reloadProviderConfig(): Promise<ProviderConfigSnapshot> {
  if (refreshInFlight) return refreshInFlight
  const version = ++requestVersion
  setProviderConfigState({ ...getProviderConfigState(), loading: true })
  refreshInFlight = invokeDesktopHost<ProviderConfigSnapshot>('modelConfig.read').then(snapshot => {
    if (version === requestVersion) applySnapshot(snapshot)
    return snapshot
  }, error => {
    if (version === requestVersion) setProviderConfigState({ ...getProviderConfigState(), loading: false, error: error instanceof Error ? error.message : 'Cannot read local model configuration' })
    throw error
  }).finally(() => { refreshInFlight = null })
  return refreshInFlight
}
export async function mutateProviderConfig(input: Record<string, unknown>, revision: string): Promise<ProviderConfigSnapshot> {
  const version = ++requestVersion
  const snapshot = await invokeDesktopHost<ProviderConfigSnapshot>('modelConfig.mutate', { ...input, revision })
  if (version === requestVersion) applySnapshot(snapshot)
  return snapshot
}
export async function bindProviderConfig(): Promise<ProviderConfigSnapshot | null> {
  const version = ++requestVersion
  const snapshot = await invokeDesktopHost<ProviderConfigSnapshot | null>('modelConfig.bind')
  if (snapshot && version === requestVersion) applySnapshot(snapshot)
  if (!snapshot) await reloadProviderConfig()
  return snapshot
}
export function openProviderConfig(): Promise<{ opened: boolean }> { return invokeDesktopHost('modelConfig.open') }
export function discoverConfiguredProvider(providerId: string, revision: string): Promise<Array<{ id: string; displayName: string }>> {
  return invokeDesktopHost('modelConfig.discover', { providerId, revision })
}
export async function resolveProviderRuntimeConfig(config: LocalModelConfig): Promise<LocalModelConfig> {
  if (!config.providerConnectionId) return config
  const snapshot = getProviderConfigState().snapshot
  if (!snapshot) throw new Error('Provider configuration has not loaded')
  const result = await invokeDesktopHost<{ apiKey?: string; requestUrl: string }>('modelConfig.resolve', { modelId: config.id, revision: snapshot.revision })
  return { ...config, apiKey: result.apiKey, providerRequestUrl: result.requestUrl }
}
export function resetProviderConfigClientForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  initialLoad = null
  refreshInFlight = null
  requestVersion += 1
}
