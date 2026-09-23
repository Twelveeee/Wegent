import { app, dialog, net, shell } from 'electron'
import { join } from 'node:path'
import { HostCapabilityRouter, HostCapabilityError } from './capability-router.js'
import { ProviderConfigStore } from './provider-config-store.js'
import type { SecureValueStore } from './secure-value-store.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'
import type { ProviderFileMutation, ProviderFileSnapshot } from './provider-config-types.js'

export function registerProviderConfigCapabilities(
  router: HostCapabilityRouter,
  secrets: SecureValueStore,
  events: DesktopHostEventBroker
): void {
  // One store per desktop process, not per window or project.
  const store = new ProviderConfigStore(join(app.getPath('userData'), 'model-providers'), secrets)
  const publish = (snapshot: ProviderFileSnapshot) => {
    events.publish('modelProviders.changed', { revision: snapshot.revision })
    return snapshot
  }
  router.register('modelProviders.read', () => store.read())
  router.register('modelProviders.reload', async () => publish(await store.read()))
  router.register('modelProviders.resolve', params =>
    store.credentials(requiredString(params.revision))
  )
  router.register('modelProviders.mutate', async params =>
    publish(
      await store.mutate(requiredString(params.revision), params.mutation as ProviderFileMutation)
    )
  )
  router.register('modelProviders.discover', params =>
    store.discover(
      requiredString(params.providerId),
      requiredString(params.revision),
      net.fetch.bind(net) as typeof fetch
    )
  )
  router.register('modelProviders.bind', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }],
    })
    return result.canceled || !result.filePaths[0]
      ? null
      : publish(await store.bind(result.filePaths[0]))
  })
  router.register('modelProviders.open', async () => {
    const snapshot = await store.read()
    const error = await shell.openPath(snapshot.path)
    if (error)
      throw new HostCapabilityError(
        'provider_file_open_failed',
        'The model file could not be opened in the default editor'
      )
    return { opened: true }
  })
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HostCapabilityError(
      'invalid_params',
      'A configuration revision and provider ID are required'
    )
  return value
}
