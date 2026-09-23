import { dialog, shell } from 'electron'
import { resolve } from 'node:path'
import { HostCapabilityRouter } from './capability-router.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'
import type { SecureValueStore } from './secure-value-store.js'
import { ModelConfigStore, type ModelConfigMutation, type ModelConfigSnapshot } from './model-config-store.js'
import { configError, text } from './model-config-schema.js'

export function registerModelConfigCapabilities(
  router: HostCapabilityRouter,
  dataDirectory: string,
  secrets: SecureValueStore,
  events: DesktopHostEventBroker
): void {
  const store = new ModelConfigStore(dataDirectory, secrets)
  const publish = (snapshot: ModelConfigSnapshot) => {
    events.publish('modelConfig.changed', { revision: snapshot.revision })
    return snapshot
  }
  router.register('modelConfig.read', () => store.read())
  router.register('modelConfig.bind', async () => {
    const isolatedPath = process.env.WEWORK_E2E_CONTROL_URL && process.env.WEWORK_E2E_OPEN_DIALOG_PATH
    const result = isolatedPath
      ? { canceled: false, filePaths: [resolve(isolatedPath)] }
      : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return publish(await store.bind(result.filePaths[0]))
  })
  router.register('modelConfig.open', async () => {
    const snapshot = await store.read()
    const error = await shell.openPath(snapshot.path)
    if (error) configError('model_config_open', 'Cannot open the configuration file in an editor')
    return { opened: true }
  })
  router.register('modelConfig.mutate', async params => publish(await store.mutate(params as unknown as ModelConfigMutation)))
  router.register('modelConfig.resolve', params => store.resolveCredential(text(params.modelId, 'modelId')!, text(params.revision, 'revision')!))
  router.register('modelConfig.discover', params => store.discover(text(params.providerId, 'providerId')!, text(params.revision, 'revision')!))
}
