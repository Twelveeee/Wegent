import { useSyncExternalStore } from 'react'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import {
  createDefaultLocalModelCatalogEntry,
  normalizeLocalModelCatalogEntry,
} from './localModelCatalog'
import {
  defaultLocalModelRequestPath,
  listLegacyLocalModelConfigs,
  removeMigratedLocalModelConfigs,
  replaceProviderManagedConfigs,
  type LocalModelConfig,
} from './localModelSettings'
import type {
  ProviderConnection,
  ProviderFileSnapshot,
  ProviderModel,
  ProviderMutation,
  PublicProviderConnection,
} from '../../../electron/src/host/model-provider-schema'

export type { ProviderConnection, ProviderModel, ProviderMutation, PublicProviderConnection }
export type ProviderViewState = Omit<ProviderFileSnapshot, 'credentials'> & { loaded: boolean }
export type ProviderRevision = Pick<ProviderViewState, 'path' | 'revision'>
let state: ProviderViewState = { path: '', revision: '', providers: [], error: null, loaded: false }
const listeners = new Set<() => void>()
let operation = Promise.resolve()
let initialized = false

function publish(patch: Partial<ProviderViewState>): void {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}

export function useProviderConfig(): ProviderViewState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => state
  )
}

export function providerModelPath(
  provider: Pick<ProviderConnection, 'api_format' | 'request_path' | 'base_url'>,
  model?: ProviderModel
): string {
  const format = model?.api_format ?? provider.api_format
  if (model?.request_path) return model.request_path
  if (format === provider.api_format && provider.request_path) return provider.request_path
  if (format === 'anthropic-messages' && provider.base_url.replace(/\/+$/, '').endsWith('/v1'))
    return '/messages'
  return defaultLocalModelRequestPath(format)
}

export function compileProviderModels(snapshot: ProviderFileSnapshot): LocalModelConfig[] {
  return snapshot.providers.flatMap(provider =>
    provider.models.map(model => {
      const apiFormat = model.api_format ?? provider.api_format
      const toolProfile = model.tool_profile ?? 'function'
      const displayName = model.display_name ?? model.model_id
      const base = { id: model.id, displayName, toolProfile, contextWindow: model.context_window }
      const usesBuiltinCatalog =
        model.provider_profile_id &&
        model.provider_profile_id !== 'custom' &&
        model.codex_catalog_model_id &&
        !model.catalog_entry
      const catalogEntry = usesBuiltinCatalog
        ? undefined
        : normalizeLocalModelCatalogEntry(
            model.catalog_entry ?? createDefaultLocalModelCatalogEntry(base),
            base
          )
      return {
        id: model.id,
        providerId: provider.id,
        providerProfileId: model.provider_profile_id ?? 'custom',
        displayName,
        group: model.group ?? provider.name,
        modelId: model.model_id,
        baseUrl: provider.base_url.trim().replace(/\/+$/, ''),
        apiFormat,
        requestPath: providerModelPath(provider, model),
        apiKey: snapshot.credentials[provider.id],
        apiKeyConfigured: provider.api_key_configured,
        toolProfile,
        codexToolCompatibility:
          apiFormat === 'openai-responses'
            ? (model.codex_tool_compatibility ?? 'standard')
            : 'standard',
        contextWindow: model.context_window,
        webSearchMode: model.web_search_mode ?? 'disabled',
        imageGenerationEnabled: model.image_generation_enabled ?? false,
        visionModelConfigId: model.vision_model_config_id,
        codexCatalogModelId:
          model.codex_catalog_model_id ??
          (typeof catalogEntry?.slug === 'string' ? catalogEntry.slug : undefined),
        catalogEntry,
        catalogReady: !catalogEntry,
        enabled:
          provider.enabled !== false && model.enabled !== false && !provider.credential_missing,
        updatedAt: new Date().toISOString(),
      }
    })
  )
}

function accept(snapshot: ProviderFileSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.providers))
    throw new Error('Invalid model provider response')
  const models = compileProviderModels(snapshot)
  replaceProviderManagedConfigs(models)
  // Never expose resolved credentials in UI subscriptions or browser storage.
  const { credentials: _credentials, ...publicState } = snapshot
  publish({ ...publicState, loaded: true })
}

function serial<Result>(action: () => Promise<Result>): Promise<Result> {
  const result = operation.then(action, action)
  operation = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export function reloadProviderConfig(): Promise<void> {
  return serial(async () => {
    try {
      accept(await invokeDesktopHost<ProviderFileSnapshot>('modelProviders.read'))
    } catch (error) {
      publish({
        loaded: true,
        error: error instanceof Error ? error.message : 'Model configuration could not be loaded',
      })
      throw error
    }
  })
}

export async function initializeProviderConfig(): Promise<void> {
  if (initialized) return
  initialized = true
  subscribeDesktopHostEvents(event => {
    if (event.type === 'model-providers.changed') void reloadProviderConfig().catch(() => {})
  })
  // A bad local file must not prevent startup or loading cloud models.
  await reloadProviderConfig().catch(() => {})
}

export function saveProviderMutation(
  mutation: ProviderMutation,
  expected: ProviderRevision
): Promise<void> {
  return serial(async () => {
    const snapshot = await invokeDesktopHost<ProviderFileSnapshot>('modelProviders.update', {
      path: expected.path,
      revision: expected.revision,
      mutation,
    })
    accept(snapshot)
  })
}

export function bindProviderFile(expected: ProviderRevision): Promise<void> {
  return serial(async () => {
    const snapshot = await invokeDesktopHost<ProviderFileSnapshot | null>('modelProviders.bind', {
      path: expected.path,
      revision: expected.revision,
      legacyIds: listLegacyLocalModelConfigs().map(model => model.id),
    })
    if (snapshot) accept(snapshot)
  })
}

export function openProviderFile(): Promise<unknown> {
  return invokeDesktopHost('modelProviders.open')
}

export function buildProviderMigration(models: LocalModelConfig[]): ProviderConnection[] {
  const groups = new Map<string, ProviderConnection>()
  for (const config of models) {
    const fingerprint = JSON.stringify([
      config.baseUrl,
      config.apiKey ?? '',
      config.apiFormat,
      config.requestPath ?? '',
    ])
    let provider = groups.get(fingerprint)
    if (!provider) {
      provider = {
        id: crypto.randomUUID(),
        name: config.group || config.displayName,
        base_url: config.baseUrl,
        api_format: config.apiFormat,
        request_path: config.requestPath,
        api_key: config.apiKey,
        models: [],
      }
      groups.set(fingerprint, provider)
    }
    provider.models.push({
      id: config.id,
      model_id: config.modelId,
      display_name: config.displayName,
      enabled: config.enabled,
      tool_profile: config.toolProfile,
      codex_tool_compatibility: config.codexToolCompatibility,
      context_window: config.contextWindow,
      web_search_mode: config.webSearchMode,
      image_generation_enabled: config.imageGenerationEnabled,
      vision_model_config_id: config.visionModelConfigId,
      group: config.group,
      provider_profile_id: config.providerProfileId,
      codex_catalog_model_id: config.codexCatalogModelId,
      catalog_entry: config.catalogEntry,
    })
  }
  return [...groups.values()]
}

export async function migrateProviderModels(expected: ProviderRevision): Promise<void> {
  const models = listLegacyLocalModelConfigs()
  if (!models.length) return
  await saveProviderMutation(
    { kind: 'migrate', providers: buildProviderMigration(models) },
    expected
  )
  removeMigratedLocalModelConfigs(models.map(model => model.id))
}

export function discoverConfiguredProviderModels(
  providerId: string,
  expected: ProviderRevision
): Promise<string[]> {
  return invokeDesktopHost<string[]>('modelProviders.discover', {
    providerId,
    path: expected.path,
    revision: expected.revision,
  })
}
