import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { legacyProviders, loadProviderFileModels, reloadProviderFileModels } from './providerConfig'
import { getProviderFileModels, setProviderFileModels } from './providerConfigState'
import {
  listLocalModelConfigs,
  listLegacyLocalModelConfigs,
  saveLocalModelConfig,
  markLocalModelCatalogReady,
  LOCAL_MODEL_SETTINGS_STORAGE_KEY,
} from './localModelSettings'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: invoke }))

beforeEach(() => {
  localStorage.clear()
  setProviderFileModels([])
  invoke.mockReset()
})
afterEach(() => {
  localStorage.clear()
  setProviderFileModels([])
})

describe('Provider configuration integration', () => {
  it('groups only identical legacy connections, preserving IDs and capability settings', () => {
    for (const [id, key] of [
      ['one', 'same'],
      ['two', 'same'],
      ['three', 'other'],
    ]) {
      saveLocalModelConfig({
        id,
        modelId: `alias-${id}`,
        baseUrl: 'https://example.invalid/v1',
        apiKey: key,
        contextWindow: 8000,
      })
    }
    const migrated = legacyProviders()
    expect(migrated.providers).toHaveLength(2)
    expect(migrated.providers[0].models.map(model => model.id)).toEqual(['one', 'two'])
    expect(migrated.providers[0].models[0].settings?.contextWindow).toBe(8000)
    expect(migrated.providers[0]).not.toHaveProperty('api_key')
  })

  it('makes file models available without copying credentials into localStorage or events', async () => {
    invoke.mockResolvedValue({
      revision: 'managed-secret-case',
      error: null,
      models: [
        {
          id: 'file-model',
          displayName: 'File model',
          modelId: 'alias',
          baseUrl: 'https://example.invalid/v1',
          apiFormat: 'openai-responses',
          apiKey: 'sensitive-fixture-key',
          toolProfile: 'custom',
          webSearchMode: 'disabled',
          imageGenerationEnabled: false,
          enabled: true,
          catalogReady: false,
          updatedAt: new Date().toISOString(),
        },
      ],
    })
    await loadProviderFileModels()
    expect(listLocalModelConfigs()).toHaveLength(1)
    expect(listLegacyLocalModelConfigs()).toEqual([])
    markLocalModelCatalogReady(getProviderFileModels())
    expect(getProviderFileModels()[0].catalogReady).toBe(true)
    expect(localStorage.getItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY)).not.toContain(
      'sensitive-fixture-key'
    )
    expect(() =>
      saveLocalModelConfig({ id: 'file-model', modelId: 'bad', baseUrl: 'https://example.invalid' })
    ).toThrow('managed')
  })

  it('retains a last valid source on load errors and does not delete legacy models', async () => {
    saveLocalModelConfig({
      id: 'legacy',
      modelId: 'local-only',
      baseUrl: 'https://example.invalid/v1',
    })
    invoke.mockRejectedValue(new Error('file is missing'))
    await reloadProviderFileModels()
    expect(listLocalModelConfigs().map(model => model.id)).toContain('legacy')
  })
})
