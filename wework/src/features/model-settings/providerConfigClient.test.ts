import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { listLocalModelConfigs, saveLocalModelConfig, markLocalModelCatalogReady } from './localModelSettings'
import { getProviderModelConfigs, resetProviderConfigStateForTests } from './providerConfigState'
import { ensureProviderModelsLoaded, providerModelToLocalConfig, reloadProviderConfig, resetProviderConfigClientForTests, resolveProviderRuntimeConfig } from './providerConfigClient'
import type { ProviderConfigSnapshot, ProviderDefinition } from './providerConfigTypes'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn(), subscribeDesktopHostEvents: vi.fn(() => () => undefined) }))
vi.mock('@/lib/runtime-environment', () => ({ isDesktopRuntime: () => true }))
const provider: ProviderDefinition = { id: 'relay', name: 'Relay', base_url: 'https://example.test/custom/api', api_key_configured: true, models: [{ id: 'stable-id', model_id: 'same-upstream' }] }
const snapshot: ProviderConfigSnapshot = { path: '/test/model.yml', revision: 'v1', providers: [provider], migratedModelIds: [], error: null }

describe('provider runtime integration', () => {
  beforeEach(() => {
    localStorage.clear(); resetProviderConfigClientForTests(); resetProviderConfigStateForTests(); vi.mocked(invokeDesktopHost).mockReset()
  })
  test('keeps legacy and file identities independent, with no keys in model listings', async () => {
    saveLocalModelConfig({ id: 'legacy', modelId: 'same-upstream', baseUrl: 'https://other.test/v1', apiKey: 'legacy-test-key' })
    vi.mocked(invokeDesktopHost).mockResolvedValue(snapshot)
    await ensureProviderModelsLoaded()
    expect(listLocalModelConfigs().map(model => model.id)).toEqual(['legacy', 'stable-id'])
    expect(getProviderModelConfigs()[0]).toMatchObject({ apiKeyConfigured: true, providerConnectionId: 'relay', catalogReady: false })
    expect(getProviderModelConfigs()[0].apiKey).toBeUndefined()
    expect(invokeDesktopHost).toHaveBeenCalledTimes(1)
    expect(invokeDesktopHost).toHaveBeenCalledWith('modelConfig.read')
  })
  test('resolves only the selected model credential, without mutating catalog objects', async () => {
    vi.mocked(invokeDesktopHost).mockResolvedValueOnce(snapshot)
    await ensureProviderModelsLoaded()
    const config = getProviderModelConfigs()[0]
    vi.mocked(invokeDesktopHost).mockResolvedValueOnce({ apiKey: 'execution-only-key', requestUrl: 'https://example.test/custom/api/responses' })
    const resolved = await resolveProviderRuntimeConfig(config)
    expect(resolved.apiKey).toBe('execution-only-key')
    expect(config.apiKey).toBeUndefined()
    expect(invokeDesktopHost).toHaveBeenLastCalledWith('modelConfig.resolve', { modelId: 'stable-id', revision: 'v1' })
  })
  test('retires legacy credentials only after successful migration and preserves readiness', async () => {
    saveLocalModelConfig({ id: 'stable-id', modelId: 'same-upstream', baseUrl: 'https://example.test/custom/api', apiKey: 'old-key' })
    vi.mocked(invokeDesktopHost).mockResolvedValue({ ...snapshot, migratedModelIds: ['stable-id'] })
    await ensureProviderModelsLoaded()
    expect(listLocalModelConfigs()).toHaveLength(1)
    expect(localStorage.getItem('wework.localModelSettings.v1')).not.toContain('old-key')
    markLocalModelCatalogReady(getProviderModelConfigs())
    await reloadProviderConfig()
    expect(getProviderModelConfigs()[0].catalogReady).toBe(true)
  })
  test('a provider read failure does not reject the directory loader or erase legacy models', async () => {
    saveLocalModelConfig({ id: 'legacy', modelId: 'a', baseUrl: 'https://example.test' })
    vi.mocked(invokeDesktopHost).mockRejectedValue(new Error('invalid file'))
    await expect(ensureProviderModelsLoaded()).resolves.toBeUndefined()
    expect(listLocalModelConfigs().map(model => model.id)).toEqual(['legacy'])
  })
  test('protocol override does not inherit an incompatible request path', () => {
    expect(providerModelToLocalConfig({ ...provider, request_path: '/responses' }, { id: 'm', model_id: 'm', api_format: 'openai-chat-completions' }).requestPath).toBe('/chat/completions')
  })
})
