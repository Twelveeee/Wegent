import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  listLegacyLocalModelConfigs,
  normalizeStoredLocalModelConfig,
  type LocalModelConfig,
} from './localModelSettings'
import { getProviderFileModels, setProviderFileModels } from './providerConfigState'
import { normalizeLocalModelCatalogEntry } from './localModelCatalog'
export type {
  ProviderApiFormat,
  ProviderDocument,
  ProviderConnection,
  ProviderModel,
  ProviderSnapshot,
} from '../../../electron/src/host/model-config-schema'
import type {
  ProviderDocument,
  ProviderConnection,
  ProviderSnapshot,
} from '../../../electron/src/host/model-config-schema'

let loadedRevision: string | null = null
let lastError: string | null = null
let inFlight: Promise<void> | null = null

export function getProviderFileError(): string | null {
  return lastError
}

export async function loadProviderFileModels(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const result = await invokeDesktopHost<{
        revision: string
        models: LocalModelConfig[]
        error: string | null
      }>('modelConfig.runtime')
      lastError = result.error
      if (!result.revision || result.revision === loadedRevision) return
      const previous = new Map(getProviderFileModels().map(model => [model.id, model]))
      const next = result.models.map(raw => {
        const normalized = normalizeStoredLocalModelConfig(raw)
        const catalogEntry = normalizeLocalModelCatalogEntry(normalized.catalogEntry ?? {}, {
          id: normalized.id,
          displayName: normalized.displayName,
          toolProfile: normalized.toolProfile,
          contextWindow: normalized.contextWindow,
        })
        if (normalized.contextWindow !== undefined) {
          catalogEntry.context_window = normalized.contextWindow
          catalogEntry.max_context_window = normalized.contextWindow
        }
        const old = previous.get(raw.id)
        const sameCatalog = JSON.stringify(old?.catalogEntry) === JSON.stringify(catalogEntry)
        return {
          ...normalized,
          catalogEntry,
          codexCatalogModelId: String(catalogEntry.slug),
          catalogReady: sameCatalog ? old!.catalogReady : false,
          ...(sameCatalog && old?.catalogPendingRuntimeInstanceId
            ? { catalogPendingRuntimeInstanceId: old.catalogPendingRuntimeInstanceId }
            : {}),
        }
      })
      // Commit the entire validated source at once. Do not store secrets in localStorage/events.
      setProviderFileModels(next)
      loadedRevision = result.revision
    } catch {
      lastError =
        'Unable to load local provider configuration; the last valid configuration is retained.'
    }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

export async function reloadProviderFileModels(): Promise<void> {
  if (inFlight) await inFlight
  loadedRevision = null
  await loadProviderFileModels()
  window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
}

export async function readProviderFile(): Promise<ProviderSnapshot> {
  return invokeDesktopHost<ProviderSnapshot>('modelConfig.read')
}

export async function saveProviderFile(
  snapshot: ProviderSnapshot,
  document: ProviderDocument,
  keys: Record<string, string | null> = {}
): Promise<ProviderSnapshot> {
  const saved = await invokeDesktopHost<ProviderSnapshot>('modelConfig.save', {
    revision: snapshot.revision,
    document,
    keys,
  })
  await reloadProviderFileModels()
  return saved
}

/** Preserve model IDs, API paths and capabilities; group only identical connections. */
export function legacyProviders(): {
  providers: ProviderConnection[]
  keys: Record<string, string>
} {
  const groups = new Map<string, ProviderConnection>()
  const keys: Record<string, string> = {}
  for (const model of listLegacyLocalModelConfigs()) {
    const fingerprint = JSON.stringify([
      model.baseUrl.replace(/\/+$/, ''),
      model.apiKey ?? '',
      model.apiFormat,
      model.requestPath ?? '',
    ])
    let provider = groups.get(fingerprint)
    if (!provider) {
      provider = {
        id: crypto.randomUUID(),
        name: model.group || model.displayName || 'Imported connection',
        base_url: model.baseUrl,
        api_format: model.apiFormat,
        request_path: model.requestPath,
        models: [],
      }
      groups.set(fingerprint, provider)
      if (model.apiKey) keys[provider.id] = model.apiKey
    }
    const settings: Record<string, unknown> = {}
    for (const key of [
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
      if (model[key] !== undefined) settings[key] = model[key]
    }
    provider.models.push({
      id: model.id,
      model_id: model.modelId,
      display_name: model.displayName,
      enabled: model.enabled,
      settings,
    })
  }
  return { providers: [...groups.values()], keys }
}
