import { BrowserWindow, dialog, shell } from 'electron'
import { HostCapabilityError, type HostCapabilityRouter } from './capability-router.js'
import type { PreferencesStore } from './preferences-store.js'
import type { SecureValueStore } from './secure-value-store.js'
import { ModelProviderStore } from './model-provider-store.js'
import type { ProviderMutation } from './model-provider-schema.js'

const stores = new WeakMap<PreferencesStore, ModelProviderStore>()

export function registerModelProviderCapabilities(
  router: HostCapabilityRouter,
  options: {
    window: () => BrowserWindow | null
    dataDirectory: string
    preferences: PreferencesStore
    secrets: SecureValueStore
    changed: (revision: string) => void
  }
): void {
  let store = stores.get(options.preferences)
  if (!store) {
    store = new ModelProviderStore(
      options.dataDirectory,
      options.preferences,
      options.secrets,
      options.changed
    )
    stores.set(options.preferences, store)
  }
  const service = store
  const wrap = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null
      const message = code
        ? `Model configuration file error (${code})`
        : error instanceof Error
          ? error.message
          : 'Model configuration error'
      throw new HostCapabilityError('model_configuration_error', message)
    }
  }
  router.register('modelProviders.discover', params =>
    wrap(() =>
      service.discover(
        requiredText(params.providerId),
        requiredText(params.path),
        requiredText(params.revision)
      )
    )
  )
  router.register('modelProviders.read', () => wrap(() => service.read()))
  router.register('modelProviders.update', params =>
    wrap(() =>
      service.update(
        requiredText(params.path),
        requiredText(params.revision),
        params.mutation as ProviderMutation
      )
    )
  )
  router.register('modelProviders.bind', params =>
    wrap(async () => {
      const window = options.window()
      if (!window) throw new Error('The settings window is unavailable')
      const selection = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Model configuration', extensions: ['yml', 'yaml'] }],
      })
      if (selection.canceled || !selection.filePaths[0]) return null
      const ids = params.legacyIds
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
        throw new Error('Invalid legacy model IDs')
      return service.bind(
        selection.filePaths[0],
        requiredText(params.path),
        requiredText(params.revision),
        ids as string[]
      )
    })
  )
  router.register('modelProviders.open', () =>
    wrap(async () => {
      const result = await shell.openPath(await service.filePath())
      if (result)
        throw new Error('The model configuration could not be opened in the default editor')
      return { opened: true }
    })
  )
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing configuration path or revision')
  return value
}
