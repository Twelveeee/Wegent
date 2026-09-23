import { app, dialog, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type {
  ProviderConfigMutation,
  ProviderConfigSnapshot,
} from '../../../shared/provider-model-config.js'
import type { HostCapabilityRouter } from './capability-router.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'
import type { SecureValueStore } from './secure-value-store.js'
import { ProviderConfigStore } from './provider-config-store.js'

const stores = new WeakMap<SecureValueStore, ProviderConfigStore>()
export function registerProviderConfigCapabilities(
  router: HostCapabilityRouter,
  window: () => BrowserWindow | null,
  secureStorage: SecureValueStore,
  events: DesktopHostEventBroker
): void {
  let store = stores.get(secureStorage)
  if (!store) {
    store = new ProviderConfigStore(join(app.getPath('userData'), 'model-config'), secureStorage)
    stores.set(secureStorage, store)
  }
  const owner = store
  let lastRevision = ''
  const publish = (snapshot: ProviderConfigSnapshot) => {
    const revision = `${snapshot.path}:${snapshot.revision}:${snapshot.error ?? ''}`
    if (revision !== lastRevision) {
      lastRevision = revision
      events.publish('modelConfig.changed', { revision: snapshot.revision })
    }
    return snapshot
  }
  router.register('modelConfig.read', async () => publish(await owner.read()))
  router.register('modelConfig.update', async params => {
    if (typeof params.expectedRevision !== 'string')
      throw new Error('Configuration revision is required')
    return publish(
      await owner.update(params.mutation as ProviderConfigMutation, params.expectedRevision)
    )
  })
  router.register('modelConfig.bind', async () => {
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'YAML models', extensions: ['yml', 'yaml'] }],
    }
    const parent = window()
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled || !selected.filePaths[0]) return null
    return publish(await owner.bind(selected.filePaths[0]))
  })
  router.register('modelConfig.open', async () => {
    const path = await owner.openPath()
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return { path }
  })
}
