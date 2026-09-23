import type {
  ProviderConfigSnapshot,
  ProviderConnection,
} from '../../../shared/provider-model-config'
import { createDefaultLocalModelCatalogEntry } from './localModelCatalog'
import {
  defaultLocalModelRequestPath,
  defaultLocalModelToolProfile,
  type LocalModelConfig,
} from './localModelSettings'

/** Expand shared connection settings only in memory; persisted models contain no copied keys. */
export function resolveProviderModels(
  snapshot: ProviderConfigSnapshot,
  previous: LocalModelConfig[] = []
): LocalModelConfig[] {
  const models: LocalModelConfig[] = []
  const ids = new Set<string>()
  const slugs = new Set<string>()
  for (const provider of snapshot.document.providers) {
    for (const model of provider.models) {
      if (ids.has(model.id)) throw new Error('Duplicate local model identity')
      ids.add(model.id)
      const before = previous.find(entry => entry.id === model.id)
      const apiFormat = model.api_format ?? provider.api_format
      const toolProfile = model.tool_profile ?? defaultLocalModelToolProfile(apiFormat)
      const displayName = model.display_name || model.model_id
      const isCustom = !model.provider_profile_id || model.provider_profile_id === 'custom'
      const defaults = isCustom
        ? createDefaultLocalModelCatalogEntry({
            id: model.id,
            displayName,
            toolProfile,
            contextWindow: model.context_window,
          })
        : undefined
      const catalogEntry = isCustom
        ? {
            ...defaults,
            ...model.catalog,
            display_name: displayName,
            ...(model.context_window
              ? { context_window: model.context_window, max_context_window: model.context_window }
              : {}),
          }
        : model.catalog
      const slug =
        model.codex_catalog_model_id ??
        (typeof catalogEntry?.slug === 'string' ? catalogEntry.slug : undefined)
      const writtenSlug = typeof catalogEntry?.slug === 'string' ? catalogEntry.slug : undefined
      if (writtenSlug && slugs.has(writtenSlug))
        throw new Error('Duplicate custom catalog identity; choose different model IDs')
      if (writtenSlug) slugs.add(writtenSlug)
      const next: LocalModelConfig = {
        id: model.id,
        providerConnectionId: provider.id,
        providerProfileId: model.provider_profile_id ?? 'custom',
        displayName,
        group: model.group ?? provider.name,
        modelId: model.model_id,
        baseUrl: provider.base_url,
        apiKey: snapshot.credentials[provider.id] || undefined,
        apiKeyConfigured: Boolean(snapshot.credentials[provider.id]),
        apiFormat,
        requestPath:
          model.request_path ??
          (apiFormat === provider.api_format ? provider.request_path : undefined) ??
          defaultLocalModelRequestPath(apiFormat),
        toolProfile,
        codexToolCompatibility:
          apiFormat === 'openai-responses'
            ? (model.codex_tool_compatibility ?? 'native')
            : 'standard',
        ...(model.context_window ? { contextWindow: model.context_window } : {}),
        webSearchMode: model.web_search_mode ?? 'disabled',
        imageGenerationEnabled: model.image_generation_enabled ?? false,
        ...(model.vision_model_config_id
          ? { visionModelConfigId: model.vision_model_config_id }
          : {}),
        ...(catalogEntry ? { catalogEntry } : {}),
        ...(slug ? { codexCatalogModelId: slug } : {}),
        catalogReady:
          !catalogEntry ||
          Boolean(
            before?.catalogReady &&
            JSON.stringify(before.catalogEntry) === JSON.stringify(catalogEntry)
          ),
        enabled:
          provider.enabled !== false &&
          model.enabled !== false &&
          !(provider.api_key_ref && !Object.hasOwn(snapshot.credentials, provider.id)),
        updatedAt: before?.updatedAt ?? new Date().toISOString(),
      }
      if (before && connectionFingerprint(before) !== connectionFingerprint(next))
        next.updatedAt = new Date(
          Math.max(Date.now(), Date.parse(before.updatedAt) + 1)
        ).toISOString()
      models.push(next)
    }
  }
  return models
}
function connectionFingerprint(config: LocalModelConfig): string {
  const {
    updatedAt: _updatedAt,
    catalogReady: _ready,
    catalogPendingRuntimeInstanceId: _pending,
    ...value
  } = config
  return JSON.stringify(value)
}

/** Group only identical connection settings, while retaining every model's stable ID and overrides. */
export function migrateLegacyProviders(models: LocalModelConfig[]): ProviderConnection[] {
  const groups = new Map<string, ProviderConnection>()
  for (const model of models) {
    const key = JSON.stringify([
      model.baseUrl,
      model.apiKey ?? '',
      model.apiFormat,
      model.requestPath ?? defaultLocalModelRequestPath(model.apiFormat),
    ])
    let provider = groups.get(key)
    if (!provider) {
      provider = {
        id: crypto.randomUUID(),
        name: model.group || new URL(model.baseUrl).hostname,
        base_url: model.baseUrl,
        api_format: model.apiFormat,
        request_path: model.requestPath ?? defaultLocalModelRequestPath(model.apiFormat),
        api_key: model.apiKey ?? '',
        models: [],
      }
      groups.set(key, provider)
    }
    provider.models.push({
      id: model.id,
      model_id: model.modelId,
      display_name: model.displayName,
      enabled: model.enabled,
      tool_profile: model.toolProfile,
      codex_tool_compatibility: model.codexToolCompatibility,
      ...(model.group ? { group: model.group } : {}),
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      web_search_mode: model.webSearchMode,
      image_generation_enabled: model.imageGenerationEnabled,
      ...(model.visionModelConfigId ? { vision_model_config_id: model.visionModelConfigId } : {}),
      ...(model.providerProfileId ? { provider_profile_id: model.providerProfileId } : {}),
      ...(model.codexCatalogModelId ? { codex_catalog_model_id: model.codexCatalogModelId } : {}),
      ...(model.catalogEntry ? { catalog: model.catalogEntry } : {}),
    })
  }
  return [...groups.values()]
}
