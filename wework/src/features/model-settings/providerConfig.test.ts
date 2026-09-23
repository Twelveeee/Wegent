import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupLegacyProviders, projectProviderModels } from './providerConfig'
import { listProviderModelConfigs, replaceProviderModelConfigs } from './providerModelCache'
import {
  listLocalModelConfigs,
  saveLocalModelConfig,
  markLocalModelCatalogReady,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
} from './localModelSettings'
import type { ProviderFileSnapshot } from '../../../electron/src/host/provider-config-types'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
  subscribeDesktopHostEvents: vi.fn(() => () => {}),
}))
const snapshot: ProviderFileSnapshot = {
  path: '/test/model.yml',
  revision: 'v1',
  providers: [
    {
      id: 'relay',
      name: 'Relay',
      base_url: 'https://example.invalid/v1',
      api_format: 'openai-responses',
      api_key_configured: true,
      models: [
        { id: 'main-model', model_id: 'same-upstream', display_name: 'Primary' },
        { id: 'fast-model', model_id: 'fast', api_format: 'openai-chat-completions' },
      ],
    },
  ],
}
beforeEach(() => {
  localStorage.clear()
  replaceProviderModelConfigs([])
})
afterEach(() => {
  replaceProviderModelConfigs([])
  localStorage.clear()
})

describe('provider runtime projection and cloud-safe identities', () => {
  it('inherits one key while giving every model a stable independent catalog slug', () => {
    const models = projectProviderModels(snapshot, { relay: 'local-test-secret' })
    expect(models.map(model => model.apiKey)).toEqual(['local-test-secret', 'local-test-secret'])
    expect(models.map(model => model.requestPath)).toEqual(['/responses', '/chat/completions'])
    expect(models.map(model => model.toolProfile)).toEqual(['custom', 'function'])
    expect(new Set(models.map(model => model.catalogEntry?.slug)).size).toBe(2)
    expect(models.every(model => !model.catalogReady)).toBe(true)
  })
  it('keeps the loaded catalog ready across key rotation, but not capability edits', () => {
    const initial = projectProviderModels(snapshot, { relay: 'first' }).map(model => ({
      ...model,
      catalogReady: true,
    }))
    const next = projectProviderModels(snapshot, { relay: 'second' }, initial)
    expect(next.every(model => model.catalogReady)).toBe(true)
    const changed = structuredClone(snapshot)
    changed.providers[0].models[0].settings = { contextWindow: 65536 }
    expect(projectProviderModels(changed, { relay: 'second' }, next)[0].catalogReady).toBe(false)
  })
  it('never persists inherited credentials in localStorage or change events', () => {
    const models = projectProviderModels(snapshot, { relay: 'local-test-secret' })
    replaceProviderModelConfigs(models)
    const spy = vi.fn()
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, spy)
    try {
      markLocalModelCatalogReady(models.map(({ id, updatedAt }) => ({ id, updatedAt })))
      expect(listLocalModelConfigs()).toHaveLength(2)
      expect(listProviderModelConfigs().every(model => model.catalogReady)).toBe(true)
      expect(localStorage.getItem('wework.localModelSettings.v1')).not.toContain(
        'local-test-secret'
      )
      expect(JSON.stringify(spy.mock.calls[0][0].detail)).not.toContain('local-test-secret')
    } finally {
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, spy)
    }
  })
  it('preserves same-name models from separate connections rather than deduplicating by upstream', () => {
    const input = structuredClone(snapshot)
    input.providers.push({
      ...input.providers[0],
      id: 'backup',
      models: [{ id: 'backup-model', model_id: 'same-upstream' }],
    })
    const models = projectProviderModels(input, { relay: 'one', backup: 'two' })
    expect(models).toHaveLength(3)
    expect(
      models.filter(model => model.modelId === 'same-upstream').map(model => model.id)
    ).toEqual(['main-model', 'backup-model'])
  })
  it('retains legacy stable IDs, capability settings and separate keys when migrating', () => {
    const first = saveLocalModelConfig({
      id: 'old-a',
      modelId: 'a',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'one',
      contextWindow: 32768,
      displayName: 'Old A',
    })
    const second = saveLocalModelConfig({
      id: 'old-b',
      modelId: 'b',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'one',
      displayName: 'Old B',
    })
    const third = saveLocalModelConfig({
      id: 'old-c',
      modelId: 'a',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'two',
    })
    const grouped = groupLegacyProviders([first, second, third])
    expect(grouped).toHaveLength(2)
    expect(grouped[0].models.map(model => model.id)).toEqual(['old-a', 'old-b'])
    expect(grouped[0].models[0].settings?.contextWindow).toBe(32768)
    const publicProviders = grouped.map(({ api_key, ...provider }) => ({
      ...provider,
      api_key_configured: Boolean(api_key),
    }))
    const projected = projectProviderModels(
      { ...snapshot, providers: publicProviders },
      Object.fromEntries(grouped.map(provider => [provider.id, provider.api_key!]))
    )
    expect(projected[0].catalogEntry?.slug).toBe(first.catalogEntry?.slug)
    expect(projected[0].id).toBe(first.id)
  })
  it('retains every legacy alias even when connection and upstream IDs are identical', () => {
    const models = ['alias-a', 'alias-b', 'alias-c'].map(id =>
      saveLocalModelConfig({
        id,
        modelId: 'same-upstream',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'same-key',
        displayName: id,
      })
    )
    const providers = groupLegacyProviders(models)
    expect(providers).toHaveLength(3)
    expect(providers.flatMap(provider => provider.models.map(model => model.id))).toEqual([
      'alias-a',
      'alias-b',
      'alias-c',
    ])
  })
  it('does not invent custom catalog identities for migrated built-in profiles', () => {
    const input = structuredClone(snapshot)
    input.providers[0].models[0].settings = {
      providerProfileId: 'deepseek',
      codexCatalogModelId: 'known-catalog-id',
    }
    const model = projectProviderModels(input, {})[0]
    expect(model.catalogEntry).toBeUndefined()
    expect(model.codexCatalogModelId).toBe('known-catalog-id')
    expect(model.catalogReady).toBe(true)
  })
  it('keeps disabled providers unavailable without deleting configuration', () => {
    const input = structuredClone(snapshot)
    input.providers[0].enabled = false
    expect(projectProviderModels(input, {}).every(model => !model.enabled)).toBe(true)
  })
})
