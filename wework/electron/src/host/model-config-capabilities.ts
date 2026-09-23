import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import { HostCapabilityError, type HostCapabilityRouter } from './capability-router.js'
import { ModelConfigStore, safeModelConfigError } from './model-config-store.js'
import type { SecureValueStore } from './secure-value-store.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'

export function registerModelConfigCapabilities(
  router: HostCapabilityRouter,
  secrets: SecureValueStore,
  events: DesktopHostEventBroker
): void {
  const store = new ModelConfigStore(join(app.getPath('userData'), 'model-config'), secrets)
  const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      if (error instanceof HostCapabilityError) throw error
      throw new HostCapabilityError('model_config_invalid', safeModelConfigError(error))
    }
  }
  router.register('modelConfig.read', () => guarded(() => store.read()))
  router.register('modelConfig.runtime', () => guarded(() => store.runtime()))
  router.register('modelConfig.open', () =>
    guarded(async () => {
      const error = await shell.openPath(await store.boundPath())
      if (error) throw new Error('Unable to open the model file in an external editor')
      return { opened: true }
    })
  )
  router.register('modelConfig.choose', () =>
    guarded(async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Model YAML', extensions: ['yml', 'yaml'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const snapshot = await store.bind(result.filePaths[0])
      events.publish('modelConfig.changed', {})
      return snapshot
    })
  )
  router.register('modelConfig.save', params =>
    guarded(async () => {
      if (typeof params.revision !== 'string') throw new Error('Model file revision is required')
      const keys = params.keys
      if (
        keys !== undefined &&
        (!keys ||
          typeof keys !== 'object' ||
          Array.isArray(keys) ||
          Object.values(keys).some(key => key !== null && typeof key !== 'string'))
      ) {
        throw new Error('Invalid model credential changes')
      }
      const snapshot = await store.save({
        revision: params.revision,
        document: params.document,
        keys: keys as Record<string, string | null> | undefined,
      })
      events.publish('modelConfig.changed', {})
      return snapshot
    })
  )
  router.register('modelConfig.discover', params =>
    guarded(() => {
      if (typeof params.providerId !== 'string') throw new Error('Provider ID is required')
      return store.discover(params.providerId)
    })
  )
}
