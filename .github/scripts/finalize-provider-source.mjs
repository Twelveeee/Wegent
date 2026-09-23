import { readFileSync, writeFileSync } from 'node:fs'

function replace(path, before, after) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(before)) throw new Error(`Expected source fragment missing in ${path}`)
  writeFileSync(path, source.replace(before, after))
}
const host = 'wework/electron/src/host/model-configuration-store.ts'
replace(host, "        if (connection.api_key_ref && !key) throw new Error('A model credential is missing on this device; enter the key in Provider settings')\n", '')
const adapter = 'wework/src/features/model-settings/providerModelConfiguration.ts'
replace(adapter, 'enabled: provider.enabled !== false && model.enabled !== false,', 'enabled: provider.enabled !== false && model.enabled !== false && !(provider.api_key_ref && !provider.api_key),')
const router = 'wework/electron/src/host/electron-capabilities.ts'
replace(router, "  registerModelConfigurationCapabilities(router, window, desktopServices.secureStorage, desktopServices.events)\n  registerMicrophoneDiagnostics(router, readMacosMicrophoneChecks)\n  router.grant(WEWORK_WORKBENCH_PRINCIPAL", "  registerMicrophoneDiagnostics(router, readMacosMicrophoneChecks)\n  router.grant(WEWORK_WORKBENCH_PRINCIPAL")
replace('wework/src/features/model-settings/providerModelConfiguration.test.ts', "describe('Provider configuration runtime adapter', () => {", `describe('Provider configuration runtime adapter', () => {
  test('missing machine-local credentials disable only affected models and remain repairable', () => {
    const unavailable = resolveProviderModel({ provider: { ...provider, api_key: undefined, api_key_ref: 'wework-model-key.missing' }, model: { id: 'missing', model_id: 'a' } })
    const available = resolveProviderModel({ provider, model: { id: 'available', model_id: 'a' } })
    expect(unavailable.enabled).toBe(false)
    expect(available.enabled).toBe(true)
    const repaired = resolveProviderModel({ provider, model: { id: 'missing', model_id: 'a' } }, unavailable)
    expect(repaired.enabled).toBe(true)
    expect(repaired.id).toBe(unavailable.id)
  })`)
replace('wework/electron/src/host/model-configuration-store.test.ts', "describe('Provider configuration file store', () => {", `describe('Provider configuration file store', () => {
  test('a missing credential reference does not block the settings page or other models', async () => {
    await writeFile(join(directory, 'model.yml'), YAML.replace('api_key: secret-not-for-output', 'api_key_ref: wework-model-key.missing'))
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.providers[0].api_key_configured).toBe(false)
    expect((await store.runtime()).models).toHaveLength(2)
    await store.save(snapshot.revision, snapshot.providers.map(provider => ({ ...provider, api_key: 'replacement' })))
    expect((await store.runtime()).models[0].provider.api_key).toBe('replacement')
  })`)
console.log('Provider credential recovery and capability boundaries finalized.')
