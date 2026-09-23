import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureValueStore } from './secure-value-store.js'
import { ModelConfigStore, type ModelConfigSnapshot } from './model-config-store.js'
import { parseModelConfig } from './model-config-schema.js'

describe('provider YAML configuration', () => {
  let directory: string
  let store: ModelConfigStore
  let snapshot: ModelConfigSnapshot
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wework-provider-test-'))
    store = new ModelConfigStore(directory, new SecureValueStore(directory))
    snapshot = await store.read()
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
  const createProvider = async (id = 'main', key = 'synthetic-test-key') => {
    snapshot = await store.mutate({ kind: 'provider.save', revision: snapshot.revision, provider: { id, name: 'Main', base_url: 'https://example.test/custom/api', api_format: 'openai-responses', request_path: null }, apiKey: key })
  }
  const addModels = async (count = 20) => {
    snapshot = await store.mutate({ kind: 'models.save', revision: snapshot.revision, providerId: 'main', models: Array.from({ length: count }, (_, i) => ({ id: `model-${i}`, model_id: `upstream-${i}` })) })
  }
  test('stores one credential for twenty models and resolves an exact base path', async () => {
    await createProvider(); await addModels()
    const yaml = await readFile(snapshot.path, 'utf8')
    expect(snapshot.providers[0].models).toHaveLength(20)
    expect(yaml.match(/api_key_ref:/g)).toHaveLength(1)
    expect(yaml).not.toContain('synthetic-test-key')
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-test-key')
    expect(await store.resolveCredential('model-19', snapshot.revision)).toEqual({ apiKey: 'synthetic-test-key', requestUrl: 'https://example.test/custom/api/responses' })
  })
  test('rotates only provider credentials without changing model identities', async () => {
    await createProvider(); await addModels(2)
    const oldRevision = snapshot.revision
    snapshot = await store.mutate({ kind: 'provider.save', providerId: 'main', provider: { name: 'Renamed' }, revision: snapshot.revision, apiKey: 'replacement-test-key' })
    expect(snapshot.providers[0].models.map(model => model.id)).toEqual(['model-0', 'model-1'])
    expect((await store.resolveCredential('model-0', snapshot.revision)).apiKey).toBe('replacement-test-key')
    await expect(store.resolveCredential('model-0', oldRevision)).rejects.toThrow('changed')
  })
  test('rejects stale forms and preserves external comments and file bytes', async () => {
    await createProvider()
    const stale = snapshot.revision
    const source = '# external comment\n' + await readFile(snapshot.path, 'utf8')
    await writeFile(snapshot.path, source)
    await expect(store.mutate({ kind: 'provider.save', providerId: 'main', provider: { name: 'Stale' }, revision: stale })).rejects.toThrow('changed outside')
    expect(await readFile(snapshot.path, 'utf8')).toBe(source)
    snapshot = await store.read()
    snapshot = await store.mutate({ kind: 'provider.save', providerId: 'main', provider: { name: 'Fresh' }, revision: snapshot.revision })
    expect(await readFile(snapshot.path, 'utf8')).toContain('# external comment')
  })
  test('recovers last valid state across restart without accepting invalid YAML', async () => {
    await createProvider(); await addModels(1)
    await writeFile(snapshot.path, 'providers: [\napi_key: hidden-test-value')
    const broken = await store.read()
    expect(broken.providers[0].models).toHaveLength(1)
    expect(broken.error?.message).not.toContain('hidden-test-value')
    expect(broken.error?.code).toBe('model_config_yaml')
    const restarted = new ModelConfigStore(directory, new SecureValueStore(directory))
    const recovered = await restarted.read()
    expect(recovered.revision).toBe(snapshot.revision)
    expect((await restarted.resolveCredential('model-0', recovered.revision)).apiKey).toBe('synthetic-test-key')
    expect(await readFile(snapshot.path, 'utf8')).toContain('providers: [')
  })
  test('invalid model batch commits nothing', async () => {
    await createProvider(); await addModels(1)
    const before = await readFile(snapshot.path, 'utf8')
    await expect(store.mutate({ kind: 'models.save', providerId: 'main', revision: snapshot.revision, models: [{ id: 'new', model_id: 'new' }, { id: 'bad', model_id: '' }] })).rejects.toThrow()
    expect(await readFile(snapshot.path, 'utf8')).toBe(before)
  })
  test('migration groups exact connections, preserves IDs, capabilities and references', async () => {
    const configs = [
      { id: 'old-a', modelId: 'a', baseUrl: 'https://example.test/v1', apiKey: 'key-one', contextWindow: 12345, visionModelConfigId: 'old-b', catalogEntry: { slug: 'retained-slug' } },
      { id: 'old-b', modelId: 'b', baseUrl: 'https://example.test/v1/', apiKey: 'key-one', catalogEntry: { input_modalities: ['text', 'image'] } },
      { id: 'old-c', modelId: 'a', baseUrl: 'https://example.test/v1', apiKey: 'key-two' },
    ]
    snapshot = await store.mutate({ kind: 'migrate', revision: snapshot.revision, configs })
    expect(snapshot.providers).toHaveLength(2)
    expect(snapshot.migratedModelIds).toEqual(['old-a', 'old-b', 'old-c'])
    expect(snapshot.providers[0].models[0]).toMatchObject({ id: 'old-a', context_window: 12345, vision_model_config_id: 'old-b', catalog_entry: { slug: 'retained-slug' } })
    expect((await store.resolveCredential('old-c', snapshot.revision)).apiKey).toBe('key-two')
    const again = await store.mutate({ kind: 'migrate', revision: snapshot.revision, configs })
    expect(again.providers).toHaveLength(2)
  })
  test('binding a different file never rewrites that file', async () => {
    const external = join(directory, 'external.yml')
    const source = 'version: 1\nproviders: []\n# preserve me\n'
    await writeFile(external, source)
    const result = await store.bind(external)
    expect(result.path).toBe(external)
    expect(await readFile(external, 'utf8')).toBe(source)
  })
  test('model-specific protocol paths inherit only compatible provider defaults', async () => {
    await createProvider()
    snapshot = await store.mutate({ kind: 'models.save', revision: snapshot.revision, providerId: 'main', models: [{ id: 'messages', model_id: 'model', api_format: 'anthropic-messages' }] })
    expect((await store.resolveCredential('messages', snapshot.revision)).requestUrl).toBe('https://example.test/custom/api/v1/messages')
  })
  test('disabled models cannot resolve credentials', async () => {
    await createProvider(); await addModels(1)
    snapshot = await store.mutate({ kind: 'models.save', revision: snapshot.revision, providerId: 'main', models: [{ id: 'model-0', enabled: false }] })
    await expect(store.resolveCredential('model-0', snapshot.revision)).rejects.toThrow('disabled')
  })
  test.each([
    'version: 2\nproviders: []',
    'version: 1\nproviders: []\nproviders: []',
    'version: 1\nproviders: []\ncloud_models: []',
    'version: 1\nproviders: &p []\nmigrated_model_ids: *p',
  ])('rejects unsupported, duplicate and cloud-owned fields: %#', source => {
    expect(() => parseModelConfig(source)).toThrow()
  })
})
