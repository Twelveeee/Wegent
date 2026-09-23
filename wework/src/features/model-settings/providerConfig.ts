import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { createDefaultLocalModelCatalogEntry } from './localModelCatalog'
import { listProviderModelConfigs, replaceProviderModelConfigs } from './providerModelCache'
import {
  listLegacyLocalModelConfigs,
  notifyLocalModelConfigsChanged,
  removeMigratedLocalModelConfigs,
  defaultLocalModelToolProfile,
  type LocalModelConfig,
} from './localModelSettings'
import type {
  ProviderConnection,
  ProviderFileModel,
  ProviderFileMutation,
  ProviderFileSnapshot,
  PublicProviderConnection,
} from '../../../electron/src/host/provider-config-types'

export type {
  ProviderConnection,
  ProviderFileModel,
  ProviderFileMutation,
  PublicProviderConnection,
}
export interface ProviderConfigState {
  snapshot: ProviderFileSnapshot | null
  error: string | null
  loaded: boolean
}

let state: ProviderConfigState = { snapshot: null, error: null, loaded: false }
let operation: Promise<unknown> = Promise.resolve()
const listeners = new Set<() => void>()
export const providerConfigSnapshot = () => state
export function subscribeProviderConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function publish(next: ProviderConfigState): void {
  state = next
  listeners.forEach(listener => listener())
}

function serial<T>(task: () => Promise<T>): Promise<T> {
  const result = operation.then(task, task)
  operation = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export function effectiveRequestPath(
  provider: PublicProviderConnection,
  model: ProviderFileModel
): string {
  if (model.request_path) return model.request_path
  if ((!model.api_format || model.api_format === provider.api_format) && provider.request_path)
    return provider.request_path
  const format = model.api_format ?? provider.api_format
  return format === 'anthropic-messages'
    ? '/messages'
    : format === 'openai-chat-completions'
      ? '/chat/completions'
      : '/responses'
}

export function projectProviderModels(
  snapshot: ProviderFileSnapshot,
  keys: Record<string, string>,
  previous: LocalModelConfig[] = []
): LocalModelConfig[] {
  return snapshot.providers.flatMap(provider =>
    provider.models.map(model => {
      const settings = model.settings ?? {}
      const apiFormat = model.api_format ?? provider.api_format
      const toolProfile =
        (settings.toolProfile as LocalModelConfig['toolProfile']) ??
        defaultLocalModelToolProfile(apiFormat)
      const displayName = model.display_name || model.model_id
      const catalogEntry =
        (settings.catalogEntry as LocalModelConfig['catalogEntry']) ??
        ((settings.providerProfileId ?? 'custom') === 'custom'
          ? createDefaultLocalModelCatalogEntry({
              id: model.id,
              displayName,
              toolProfile,
              contextWindow: settings.contextWindow as number | undefined,
            })
          : undefined)
      const config: LocalModelConfig = {
        ...settings,
        id: model.id,
        providerConnectionId: provider.id,
        providerProfileId: String(settings.providerProfileId ?? 'custom'),
        displayName,
        group: String(settings.group ?? provider.name),
        modelId: model.model_id,
        baseUrl: provider.base_url.replace(/\/+$/, ''),
        apiFormat,
        requestPath: effectiveRequestPath(provider, model),
        apiKey: keys[provider.id] || undefined,
        apiKeyConfigured: provider.api_key_configured,
        toolProfile,
        codexToolCompatibility:
          (settings.codexToolCompatibility as LocalModelConfig['codexToolCompatibility']) ??
          (apiFormat === 'openai-responses' ? 'native' : 'standard'),
        webSearchMode: (settings.webSearchMode as LocalModelConfig['webSearchMode']) ?? 'disabled',
        imageGenerationEnabled: settings.imageGenerationEnabled === true,
        catalogEntry,
        codexCatalogModelId: String(settings.codexCatalogModelId ?? catalogEntry?.slug ?? ''),
        catalogReady: false,
        enabled: provider.enabled !== false && model.enabled !== false,
        updatedAt: '',
      }
      const old = previous.find(item => item.id === model.id)
      const sameCatalog =
        old && JSON.stringify(old.catalogEntry) === JSON.stringify(config.catalogEntry)
      config.catalogReady = !catalogEntry || Boolean(sameCatalog && old.catalogReady)
      const comparable = (item: LocalModelConfig) =>
        JSON.stringify({ ...item, updatedAt: '', catalogReady: false })
      config.updatedAt =
        old && comparable(old) === comparable(config)
          ? old.updatedAt
          : new Date(Math.max(Date.now(), (old ? Date.parse(old.updatedAt) : 0) + 1)).toISOString()
      return config
    })
  )
}

async function apply(snapshot: ProviderFileSnapshot): Promise<void> {
  if (!snapshot.revision && snapshot.error) {
    publish({ snapshot, error: snapshot.error, loaded: true })
    return
  }
  const keys = await invokeDesktopHost<Record<string, string>>('modelProviders.resolve', {
    revision: snapshot.revision,
  })
  const projected = projectProviderModels(snapshot, keys, listProviderModelConfigs())
  const legacy = listLegacyLocalModelConfigs()
  for (const model of projected) {
    const old = legacy.find(item => item.id === model.id)
    if (
      old &&
      (old.modelId !== model.modelId ||
        old.baseUrl.replace(/\/+$/, '') !== model.baseUrl ||
        old.apiFormat !== model.apiFormat ||
        (old.apiKey || '') !== (model.apiKey || ''))
    ) {
      throw new Error(
        'A file model ID conflicts with an existing local model. Give it a different stable ID.'
      )
    }
  }
  const all = [
    ...legacy.filter(item => !projected.some(model => model.id === item.id)),
    ...projected,
  ]
  for (const model of all) {
    if (
      model.visionModelConfigId &&
      !all.some(candidate => candidate.id === model.visionModelConfigId && candidate.enabled)
    ) {
      throw new Error(
        'A vision model reference is missing or disabled. Restore it before applying this configuration.'
      )
    }
  }
  replaceProviderModelConfigs(projected)
  publish({ snapshot, error: snapshot.error ?? null, loaded: true })
  notifyLocalModelConfigsChanged()
}

export function reloadProviderConfig(): Promise<void> {
  return serial(async () => {
    try {
      await apply(await invokeDesktopHost<ProviderFileSnapshot>('modelProviders.reload'))
    } catch (error) {
      publish({ ...state, loaded: true, error: safeError(error) })
      throw error
    }
  })
}

export async function initializeProviderConfig(): Promise<() => void> {
  if (!isElectronRuntime()) return () => {}
  const unsubscribe = subscribeDesktopHostEvents(event => {
    if (
      event.type === 'modelProviders.changed' &&
      event.payload.revision !== state.snapshot?.revision
    ) {
      void serial(async () => {
        try {
          await apply(await invokeDesktopHost<ProviderFileSnapshot>('modelProviders.read'))
        } catch (error) {
          publish({ ...state, error: safeError(error), loaded: true })
        }
      })
    }
  })
  try {
    await serial(async () =>
      apply(await invokeDesktopHost<ProviderFileSnapshot>('modelProviders.read'))
    )
  } catch (error) {
    publish({ ...state, error: safeError(error), loaded: true })
  }
  return unsubscribe
}

export function mutateProviderConfig(
  mutation: ProviderFileMutation,
  revision: string
): Promise<void> {
  return serial(async () =>
    apply(
      await invokeDesktopHost<ProviderFileSnapshot>('modelProviders.mutate', { revision, mutation })
    )
  )
}

export function bindProviderConfig(): Promise<void> {
  return serial(async () => {
    const snapshot = await invokeDesktopHost<ProviderFileSnapshot | null>('modelProviders.bind')
    if (snapshot) await apply(snapshot)
  })
}

export async function discoverConnectionModels(
  providerId: string,
  revision: string
): Promise<string[]> {
  return invokeDesktopHost<string[]>('modelProviders.discover', { providerId, revision })
}

export function openProviderFile(): Promise<unknown> {
  return invokeDesktopHost('modelProviders.open')
}

export function groupLegacyProviders(models: LocalModelConfig[]): ProviderConnection[] {
  const groups = new Map<string, ProviderConnection>()
  const providers: ProviderConnection[] = []
  for (const model of models) {
    const key = JSON.stringify([
      model.baseUrl.replace(/\/+$/, ''),
      model.apiKey ?? '',
      model.apiFormat,
      model.requestPath,
    ])
    let provider = groups.get(key)
    if (!provider || provider.models.some(item => item.model_id === model.modelId)) {
      provider = {
        id: `provider-${crypto.randomUUID()}`,
        name: model.group || new URL(model.baseUrl).hostname,
        base_url: model.baseUrl,
        api_format: model.apiFormat,
        request_path: model.requestPath,
        api_key: model.apiKey ?? '',
        models: [],
      }
      groups.set(key, provider)
      providers.push(provider)
    }
    const settings: Record<string, unknown> = {}
    for (const field of [
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
    ] as const) {
      if (model[field] !== undefined) settings[field] = model[field]
    }
    provider.models.push({
      id: model.id,
      model_id: model.modelId,
      display_name: model.displayName,
      enabled: model.enabled,
      settings,
    })
  }
  return providers
}

export async function migrateLegacyProviderConfig(revision: string): Promise<void> {
  const legacy = listLegacyLocalModelConfigs().filter(
    model => !listProviderModelConfigs().some(managed => managed.id === model.id)
  )
  if (!legacy.length) return
  await mutateProviderConfig(
    { kind: 'import-providers', providers: groupLegacyProviders(legacy) },
    revision
  )
  // Clear only unchanged inputs; another window may have edited legacy storage meanwhile.
  const current = listLegacyLocalModelConfigs()
  const migratedIds = legacy
    .filter(
      model => JSON.stringify(model) === JSON.stringify(current.find(item => item.id === model.id))
    )
    .map(model => model.id)
  removeMigratedLocalModelConfigs(migratedIds)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Provider configuration could not be loaded'
}
