import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type {
  ProviderConfigMutation,
  ProviderConfigSnapshot,
} from '../../../shared/provider-model-config'
import { listLocalModelConfigs, replaceProviderLocalModels } from './localModelSettings'
import { resolveProviderModels } from './providerModelConfig'

interface ProviderConfigState {
  snapshot: ProviderConfigSnapshot | null
  error: string | null
  loading: boolean
}
let state: ProviderConfigState = { snapshot: null, error: null, loading: false }
let pending: Promise<void> | null = null
let initialized = false
let operationRevision = 0
let listening = false
const listeners = new Set<() => void>()
export const getProviderConfigState = () => state
export const subscribeProviderConfig = (callback: () => void) => {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}
function updateState(patch: Partial<ProviderConfigState>): void {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}
function apply(snapshot: ProviderConfigSnapshot): void {
  // Resolve the complete candidate before replacing any active models.
  const resolved = resolveProviderModels(snapshot, listLocalModelConfigs())
  replaceProviderLocalModels(resolved)
  updateState({ snapshot, error: snapshot.error ?? null, loading: false })
}
export async function reloadProviderConfig(): Promise<void> {
  if (pending) return pending
  const revision = ++operationRevision
  updateState({ loading: true })
  pending = invokeDesktopHost<ProviderConfigSnapshot>('modelConfig.read')
    .then(snapshot => {
      if (revision === operationRevision) apply(snapshot)
    })
    .catch(error => {
      if (revision === operationRevision)
        updateState({
          error: error instanceof Error ? error.message : 'Model configuration could not be loaded',
          loading: false,
        })
    })
    .finally(() => {
      pending = null
      initialized = true
    })
  return pending
}
export async function ensureProviderConfigLoaded(): Promise<void> {
  if (!isElectronRuntime()) return
  if (!listening) {
    listening = true
    subscribeDesktopHostEvents(event => {
      if (event.type === 'modelConfig.changed') void reloadProviderConfig()
    })
  }
  if (!initialized) await reloadProviderConfig()
}
export async function mutateProviderConfig(
  mutation: ProviderConfigMutation,
  expectedRevision: string
): Promise<void> {
  if (pending) await pending
  const revision = ++operationRevision
  const snapshot = await invokeDesktopHost<ProviderConfigSnapshot>('modelConfig.update', {
    mutation,
    expectedRevision,
  })
  if (revision === operationRevision) apply(snapshot)
  else await reloadProviderConfig()
}
export async function bindProviderConfig(): Promise<void> {
  if (pending) await pending
  const revision = ++operationRevision
  const snapshot = await invokeDesktopHost<ProviderConfigSnapshot | null>('modelConfig.bind')
  if (snapshot && revision === operationRevision) apply(snapshot)
  else if (snapshot) await reloadProviderConfig()
}
export async function openProviderConfig(): Promise<void> {
  await invokeDesktopHost('modelConfig.open')
  await reloadProviderConfig()
}
