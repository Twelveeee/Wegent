import type { LocalModelCatalogSnapshot, LocalModelConfig } from './localModelSettings'
import type { ProviderConfigState } from './providerConfigTypes'

export const PROVIDER_CONFIG_CHANGED_EVENT = 'wework:provider-config-state-changed'
let models: LocalModelConfig[] = []
let migrated = new Set<string>()
let state: ProviderConfigState = { snapshot: null, loading: false, error: null }

export function getProviderConfigState(): ProviderConfigState { return state }
export function getProviderModelConfigs(): LocalModelConfig[] { return models }
export function isMigratedProviderModel(id: string): boolean { return migrated.has(id) }
export function isProviderModel(id: string): boolean { return models.some(model => model.id === id) }
export function setProviderConfigState(next: ProviderConfigState, configs?: LocalModelConfig[]): void {
  state = next
  if (configs) models = configs
  if (next.snapshot) migrated = new Set(next.snapshot.migratedModelIds)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROVIDER_CONFIG_CHANGED_EVENT))
}
export function markProviderModelsReady(snapshot: readonly LocalModelCatalogSnapshot[]): void {
  const versions = new Map(snapshot.map(model => [model.id, model.updatedAt]))
  models = models.map(model => versions.get(model.id) === model.updatedAt ? { ...model, catalogReady: true, catalogPendingRuntimeInstanceId: undefined } : model)
}
export function resetProviderConfigStateForTests(): void {
  models = []
  migrated = new Set()
  state = { snapshot: null, loading: false, error: null }
}
