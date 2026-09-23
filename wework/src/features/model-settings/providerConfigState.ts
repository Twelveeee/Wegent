import type { LocalModelConfig } from './localModelSettings'

// Resolved execution snapshots only. The YAML file owns persistent configuration.
let managedModels: LocalModelConfig[] = []
export function getProviderFileModels(): LocalModelConfig[] {
  return managedModels
}
export function setProviderFileModels(models: LocalModelConfig[]): void {
  managedModels = models
}
export function isProviderFileModel(id: string): boolean {
  return managedModels.some(model => model.id === id)
}
export function updateProviderFileRuntimeState(models: LocalModelConfig[]): void {
  const states = new Map(models.map(model => [model.id, model]))
  managedModels = managedModels.map(model => {
    const state = states.get(model.id)
    return state
      ? {
          ...model,
          catalogReady: state.catalogReady,
          catalogPendingRuntimeInstanceId: state.catalogPendingRuntimeInstanceId,
        }
      : model
  })
}
