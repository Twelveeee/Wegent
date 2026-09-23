import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfigStore } from './model-config-store.js'
import { validateProviderDocument, type ProviderDocument } from './model-config-schema.js'

const fixture = (): ProviderDocument => ({
  version: 1,
  providers: [
    {
      id: 'relay',
      name: 'Relay',
      base_url: 'https://example.invalid/v1',
      api_format: 'openai-responses',
      models: [
        { id: 'primary', model_id: 'shared-model', display_name: 'Main' },
        { id: 'secondary', model_id: 'other-model' },
      ],
    },
  ],
})

describe('Provider YAML store', () => {
  let directory: string
  let values: Map<string, string>
  let secrets: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
  }
  let store: ModelConfigStore
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wework-provider-'))
    values = new Map()
    secrets = {
      get: async key => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value)
      },
    }
    store = new ModelConfigStore(directory, secrets)
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('creates an empty local file, not a cloud model copy', async () => {
    const snapshot = await store.read()
    expect(snapshot.document).toEqual({ version: 1, providers: [] })
    expect(snapshot.path).toBe(join(directory, 'model.yml'))
  })

  it('writes one credential reference shared by many models; public snapshots contain no key', async () => {
    const initial = await store.read()
    const saved = await store.save({
      revision: initial.revision,
      document: fixture(),
      keys: { relay: 'test-secret' },
    })
    expect(saved.configuredKeys).toEqual(['relay'])
    expect(JSON.stringify(saved)).not.toContain('test-secret')
    const text = await readFile(saved.path, 'utf8')
    expect(text).not.toContain('test-secret')
    expect(text.match(/api_key_ref:/g)).toHaveLength(1)
    const runtime = await store.runtime()
    expect(runtime.models.map(model => model.apiKey)).toEqual(['test-secret', 'test-secret'])
    expect(runtime.models.map(model => model.id)).toEqual(['primary', 'secondary'])
  })

  it('retains a key on an ordinary page save, rotates all models once and supports explicit clearing', async () => {
    let saved = await store.save({
      revision: (await store.read()).revision,
      document: fixture(),
      keys: { relay: 'before' },
    })
    saved.document.providers[0].name = 'Renamed'
    saved = await store.save({ revision: saved.revision, document: saved.document })
    expect((await store.runtime()).models[0].apiKey).toBe('before')
    saved = await store.save({
      revision: saved.revision,
      document: saved.document,
      keys: { relay: 'after' },
    })
    expect((await store.runtime()).models.map(model => model.apiKey)).toEqual(['after', 'after'])
    saved = await store.save({
      revision: saved.revision,
      document: saved.document,
      keys: { relay: null },
    })
    expect(saved.configuredKeys).toEqual([])
  })

  it('rejects a stale page save without overwriting an external file edit or rotating a key', async () => {
    const initial = await store.read()
    const saved = await store.save({
      revision: initial.revision,
      document: fixture(),
      keys: { relay: 'original' },
    })
    const edited = (await readFile(saved.path, 'utf8')).replace('name: Relay', 'name: External')
    await writeFile(saved.path, edited)
    await expect(
      store.save({ revision: saved.revision, document: saved.document, keys: { relay: 'wrong' } })
    ).rejects.toThrow('changed in another editor')
    expect(await readFile(saved.path, 'utf8')).toBe(edited)
    expect((await store.runtime()).models[0].apiKey).toBe('original')
  })

  it('retains last valid runtime settings after invalid YAML, including after a process restart', async () => {
    const saved = await store.save({ revision: (await store.read()).revision, document: fixture() })
    await writeFile(saved.path, 'providers: [\n  api_key: sensitive-fixture-key\n')
    await expect(store.read()).rejects.toThrow('Invalid YAML')
    const current = await store.runtime()
    expect(current.models).toHaveLength(2)
    expect(current.error).toContain('Invalid YAML')
    expect(current.error).not.toContain('sensitive-fixture-key')
    const restarted = await new ModelConfigStore(directory, secrets).runtime()
    expect(restarted.models.map(model => model.id)).toEqual(['primary', 'secondary'])
  })

  it('keeps a redacted inline key and comments when editing through the page', async () => {
    const path = join(directory, 'external.yml')
    await writeFile(
      path,
      '# My providers\nversion: 1\nproviders:\n  - id: relay # Stable provider\n    name: Relay\n    base_url: https://example.invalid/v1\n    api_format: openai-responses\n    api_key: inline-fixture-secret\n    models:\n      - id: primary # Stable model\n        model_id: shared-model\n'
    )
    const snapshot = await store.bind(path)
    expect(JSON.stringify(snapshot)).not.toContain('inline-fixture-secret')
    snapshot.document.providers[0].name = 'Edited'
    await store.save({ revision: snapshot.revision, document: snapshot.document })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('# My providers')
    expect(text).toContain('# Stable model')
    expect((await store.runtime()).models[0].apiKey).toBe('inline-fixture-secret')
  })

  it('fails file selection without changing the existing binding', async () => {
    const snapshot = await store.read()
    const path = join(directory, 'invalid.yml')
    await writeFile(path, 'version: 99\nproviders: []\n')
    await expect(store.bind(path)).rejects.toThrow('schema version')
    expect((await store.read()).path).toBe(snapshot.path)
  })

  it('preserves per-model protocol, capabilities, disabled state and literal upstream IDs', async () => {
    const document = fixture()
    document.providers[0].models[1] = {
      id: 'secondary',
      model_id: 'owner/Exact-Alias',
      api_format: 'anthropic-messages',
      enabled: false,
      settings: { toolProfile: 'function', catalogEntry: { input_modalities: ['text', 'image'] } },
    }
    await store.save({ revision: (await store.read()).revision, document })
    const model = (await store.runtime()).models[1]
    expect(model.modelId).toBe('owner/Exact-Alias')
    expect(model.requestPath).toBe('/v1/messages')
    expect(model.enabled).toBe(false)
    expect(model.catalogEntry).toEqual({ input_modalities: ['text', 'image'] })
  })

  it('keeps same upstream model IDs in separate providers', async () => {
    const document = fixture()
    document.providers.push({
      ...document.providers[0],
      id: 'backup',
      models: [{ id: 'backup-primary', model_id: 'shared-model' }],
    })
    await store.save({ revision: (await store.read()).revision, document })
    expect((await store.runtime()).models).toHaveLength(3)
  })

  it('rejects duplicate stable IDs, unknown sources and invalid native tool combinations', () => {
    const duplicate = fixture()
    duplicate.providers[0].models[1].id = 'PRIMARY'
    expect(() => validateProviderDocument(duplicate)).toThrow('unique')
    expect(() => validateProviderDocument({ ...fixture(), cloud: [] })).toThrow('unsupported field')
    const invalid = fixture()
    invalid.providers[0].models[0].api_format = 'anthropic-messages'
    invalid.providers[0].models[0].settings = { toolProfile: 'custom' }
    expect(() => validateProviderDocument(invalid)).toThrow('require Responses')
  })

  it('removes models only on a successfully committed valid file', async () => {
    const saved = await store.save({ revision: (await store.read()).revision, document: fixture() })
    await store.save({ revision: saved.revision, document: { version: 1, providers: [] } })
    expect((await store.runtime()).models).toEqual([])
  })
  it('changes runtime revision when a device-local credential disappears or is restored', async () => {
    const saved = await store.save({
      revision: (await store.read()).revision,
      document: fixture(),
      keys: { relay: 'original' },
    })
    const ref = saved.document.providers[0].api_key_ref!
    const before = await store.runtime()
    values.delete(ref)
    const missing = await store.runtime()
    expect(missing.revision).not.toBe(before.revision)
    expect(missing.models.every(model => model.enabled === false)).toBe(true)
    expect(missing.error).toContain('credential is missing')
    values.set(ref, 'original')
    expect((await store.runtime()).models.every(model => model.enabled === true)).toBe(true)
  })

  it('includes a safe line and column on malformed YAML without exposing secrets', async () => {
    const snapshot = await store.read()
    await writeFile(snapshot.path, 'version: 1\nproviders: [\n api_key: do-not-display-secret\n')
    await expect(store.read()).rejects.toThrow(/Invalid YAML at line \d+, column \d+/)
  })
})
