import type { LocalModelConfig, LocalModelCatalogSnapshot } from './localModelSettings'

let configs: LocalModelConfig[] = []

/** Runtime-only projection. Credentials are never persisted in renderer storage. */
export function listProviderModelConfigs(): LocalModelConfig[] {
  return configs
}

export function replaceProviderModelConfigs(next: LocalModelConfig[]): void {
  configs = next
}

export function markProviderModelCatalogReady(
  snapshot: readonly LocalModelCatalogSnapshot[]
): void {
  const versions = new Map(snapshot.map(model => [model.id, model.updatedAt]))
  configs = configs.map(model =>
    versions.get(model.id) === model.updatedAt ? { ...model, catalogReady: true } : model
  )
}
