// @vitest-environment jsdom
import { buildLocalModelRequestUrl } from './localModelSettings'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyProviders, resolveProviderModels } from './providerModelConfig'
import {
  clearLocalModelConfigs,
  deleteLocalModelConfig,
  findLocalModelConfigByModelName,
  listLocalModelConfigs,
  localModelName,
  markLocalModelCatalogReady,
  removeMigratedLocalModelConfigs,
  replaceProviderLocalModels,
  saveLocalModelConfig,
} from './localModelSettings'
import type { ProviderConfigSnapshot } from '../../../shared/provider-model-config'
const snapshot = (): ProviderConfigSnapshot => ({
  path: '/model.yml',
  revision: 'r1',
  loadedAt: new Date().toISOString(),
  document: {
    version: 1,
    providers: [
      {
        id: 'relay',
        name: 'Relay',
        base_url: 'https://relay.example/v1',
        api_format: 'openai-responses',
        request_path: '/custom-responses',
        models: [
          { id: 'a', model_id: 'upstream' },
          { id: 'b', model_id: 'other', api_format: 'anthropic-messages' },
        ],
      },
    ],
  },
  credentials: { relay: 'test-key' },
})
beforeEach(() => {
  replaceProviderLocalModels([])
  localStorage.clear()
})
describe('provider runtime projection', () => {
  it('inherits connection settings but not the wrong protocol path', () => {
    const models = resolveProviderModels(snapshot())
    expect(models[0]).toMatchObject({
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      requestPath: '/custom-responses',
      apiFormat: 'openai-responses',
    })
    expect(models[1]).toMatchObject({
      requestPath: '/v1/messages',
      apiFormat: 'anthropic-messages',
      toolProfile: 'function',
    })
    expect(models.every(model => model.catalogReady === false)).toBe(true)
  })
  it('retains readiness and timestamps on reload and key rotation', () => {
    const data = snapshot()
    const models = resolveProviderModels(data).map(model => ({ ...model, catalogReady: true }))
    const same = resolveProviderModels(data, models)
    expect(same).toEqual(models)
    data.credentials.relay = 'rotated'
    const rotated = resolveProviderModels(data, models)
    expect(rotated[0].catalogReady).toBe(true)
    expect(rotated[0].apiKey).toBe('rotated')
    expect(rotated[0].updatedAt).not.toBe(models[0].updatedAt)
  })
  it('disables only the connection with an unavailable referenced key', () => {
    const data = snapshot()
    data.document.providers[0].api_key_ref = 'wework-model-missing'
    data.credentials = {}
    expect(resolveProviderModels(data).every(model => !model.enabled)).toBe(true)
  })
  it('does not deduplicate different provider connections by upstream model name', () => {
    const data = snapshot()
    data.document.providers.push({
      ...data.document.providers[0],
      id: 'second',
      models: [{ id: 'c', model_id: 'upstream' }],
    })
    const models = resolveProviderModels(data)
    expect(models.filter(model => model.modelId === 'upstream')).toHaveLength(2)
    expect(new Set(models.map(localModelName)).size).toBe(3)
  })
  it('shares provider data in memory without persisting credentials in localStorage', () => {
    replaceProviderLocalModels(resolveProviderModels(snapshot()))
    expect(listLocalModelConfigs()).toHaveLength(2)
    expect(findLocalModelConfigByModelName('local-model:a')?.modelId).toBe('upstream')
    expect(localStorage.length).toBe(0)
    expect(() => deleteLocalModelConfig('a')).toThrow('Provider')
    markLocalModelCatalogReady(listLocalModelConfigs())
    expect(listLocalModelConfigs().every(model => model.catalogReady)).toBe(true)
    clearLocalModelConfigs()
    expect(listLocalModelConfigs()).toHaveLength(2)
  })
  it('migrates exact connection groups and preserves stable IDs and capability metadata', () => {
    const one = saveLocalModelConfig({
      id: 'old-a',
      group: 'Existing',
      displayName: 'My model',
      modelId: 'a',
      baseUrl: 'https://one.example/v1',
      apiKey: 'one',
      enabled: false,
      contextWindow: 12345,
    })
    const two = saveLocalModelConfig({
      id: 'old-b',
      modelId: 'b',
      baseUrl: one.baseUrl,
      apiKey: 'one',
    })
    const other = saveLocalModelConfig({
      id: 'old-c',
      modelId: 'a',
      baseUrl: one.baseUrl,
      apiKey: 'different',
    })
    const providers = migrateLegacyProviders([one, two, other])
    expect(providers).toHaveLength(2)
    expect(providers[0].models.map(model => model.id)).toEqual(['old-a', 'old-b'])
    expect(providers[0].models[0]).toMatchObject({
      display_name: 'My model',
      enabled: false,
      context_window: 12345,
      catalog: one.catalogEntry,
    })
    const data = snapshot()
    data.document.providers = providers
    data.credentials = Object.fromEntries(
      providers.map(provider => [provider.id, provider.api_key!])
    )
    replaceProviderLocalModels(resolveProviderModels(data, [one, two, other]))
    removeMigratedLocalModelConfigs(['old-a', 'old-b', 'old-c'])
    expect(listLocalModelConfigs().map(model => model.id)).toEqual(['old-a', 'old-b', 'old-c'])
    expect(localStorage.getItem('wework.localModelSettings.v1')).not.toContain('different')
  })
  it('refuses destructive migration cleanup before replacement is active', () => {
    saveLocalModelConfig({ id: 'old', modelId: 'a', baseUrl: 'https://one.example/v1' })
    expect(() => removeMigratedLocalModelConfigs(['old'])).toThrow()
    expect(listLocalModelConfigs()).toHaveLength(1)
  })
})

it('provider connection prefixes are not mistaken for full legacy request URLs', () => {
  expect(
    buildLocalModelRequestUrl(
      'https://relay.example/api/coding/v3',
      '/responses',
      'openai-responses',
      true
    )
  ).toBe('https://relay.example/api/coding/v3/responses')
  expect(
    buildLocalModelRequestUrl(
      'https://relay.example/vendor/anthropic',
      '/v1/messages',
      'anthropic-messages',
      true
    )
  ).toBe('https://relay.example/vendor/anthropic/v1/messages')
})
