import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ModelConfigurationStore } from './model-configuration-store.js'
import { parseModelConfiguration, validateModelConfiguration } from './model-configuration-schema.js'

const YAML = `# user comment\nversion: 1\nproviders:\n  - id: relay\n    name: My relay\n    base_url: https://relay.example/v1\n    api_format: openai-responses\n    api_key: secret-not-for-output\n    models:\n      - id: first\n        model_id: upstream-a # retain model comment\n      - id: second\n        model_id: upstream-b\n`
let directory: string
let values: Map<string, string>
const secrets = {
  get: async (key: string) => values.get(key) ?? null,
  set: async (key: string, value: string) => { values.set(key, value) },
  delete: async (key: string) => { values.delete(key) },
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'wework-models-')); values = new Map() })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('Provider YAML schema', () => {
  test('accepts shared connections and per-model protocol overrides', () => {
    const config = parseModelConfiguration(YAML).config
    config.providers[0].models[1].api_format = 'anthropic-messages'
    expect(validateModelConfiguration(config).providers[0].models).toHaveLength(2)
  })
  test('rejects unknown fields, duplicate IDs, incompatible tools and unsafe URLs', () => {
    for (const source of [
      YAML.replace('base_url:', 'base_urll:'),
      YAML.replace('id: second', 'id: first'),
      YAML.replace('openai-responses', 'made-up-protocol'),
      YAML.replace('https://relay.example/v1', 'https://user:password@relay.example/v1'),
      YAML.replace('model_id: upstream-b', "model_id: upstream-b\n        api_format: anthropic-messages\n        tool_profile: custom"),
    ]) expect(() => parseModelConfiguration(source)).toThrow()
  })
  test('does not include a secret or YAML source excerpt in syntax errors', () => {
    expect(() => parseModelConfiguration(YAML + 'bad: [secret-not-for-output')).toThrow(/line/)
    try { parseModelConfiguration(YAML + 'bad: [secret-not-for-output') } catch (error) {
      expect(String(error)).not.toContain('secret-not-for-output')
    }
  })
})

describe('Provider configuration file store', () => {
  test('a missing credential reference does not block the settings page or other models', async () => {
    await writeFile(join(directory, 'model.yml'), YAML.replace('api_key: secret-not-for-output', 'api_key_ref: wework-model-key.missing'))
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.providers[0].api_key_configured).toBe(false)
    expect((await store.runtime()).models).toHaveLength(2)
    await store.save(snapshot.revision, snapshot.providers.map(provider => ({ ...provider, api_key: 'replacement' })))
    expect((await store.runtime()).models[0].provider.api_key).toBe('replacement')
  })
  test('creates a fresh configuration and shares one credential across models', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    expect(empty.providers).toEqual([])
    expect((await store.read()).error).toBeUndefined()
    expect((await new ModelConfigurationStore(directory, secrets).read()).error).toBeUndefined()
    const config = parseModelConfiguration(YAML).config
    const snapshot = await store.save(empty.revision, config.providers)
    expect(JSON.stringify(snapshot)).not.toContain('secret-not-for-output')
    const source = await readFile(join(directory, 'model.yml'), 'utf8')
    expect(source).toContain('api_key_ref:')
    expect(source).not.toContain('secret-not-for-output')
    const runtime = await store.runtime()
    expect(runtime.models.map(entry => entry.provider.api_key)).toEqual(['secret-not-for-output', 'secret-not-for-output'])
    expect(runtime.models.map(entry => entry.model.id)).toEqual(['first', 'second'])
  })
  test('page changes preserve model IDs, comments, capabilities and an unchanged key', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    snapshot.providers[0].name = 'Renamed'
    snapshot.providers[0].models[0].catalog_entry = { slug: 'existing-slug', supports_parallel_tool_calls: true }
    await store.save(snapshot.revision, snapshot.providers)
    const source = await readFile(join(directory, 'model.yml'), 'utf8')
    expect(source).toContain('# user comment')
    expect(source).toContain('# retain model comment')
    expect(source).toContain('existing-slug')
    expect((await store.runtime()).models[0].provider.api_key).toBe('secret-not-for-output')
    expect((await store.runtime()).models[0].model.id).toBe('first')
  })
  test('rejects stale page saves after an external edit without overwriting the file', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    const changed = YAML.replace('My relay', 'External rename')
    await writeFile(join(directory, 'model.yml'), changed)
    await expect(store.save(snapshot.revision, snapshot.providers)).rejects.toThrow(/changed externally/)
    expect(await readFile(join(directory, 'model.yml'), 'utf8')).toBe(changed)
    expect((await store.read()).providers[0].name).toBe('External rename')
  })
  test('serializes concurrent page saves; exactly one writer wins', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    const results = await Promise.allSettled([
      store.save(snapshot.revision, parseModelConfiguration(YAML).config.providers),
      store.save(snapshot.revision, parseModelConfiguration(YAML).config.providers),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
  test('malformed files retain the last valid configuration, including after restart', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    await store.read()
    await writeFile(join(directory, 'model.yml'), 'version: [')
    expect((await store.read()).error).toBeTruthy()
    expect((await store.runtime()).models).toHaveLength(2)
    const restarted = new ModelConfigurationStore(directory, secrets)
    const snapshot = await restarted.read()
    expect(snapshot.error).toBeTruthy()
    expect(snapshot.providers).toHaveLength(1)
    expect((await restarted.runtime()).models).toHaveLength(2)
    await expect(restarted.save(snapshot.revision, [])).rejects.toThrow(/Fix and reload/)
  })
  test('missing files retain the saved configuration after restart', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    await store.save(snapshot.revision, parseModelConfiguration(YAML).config.providers)
    await rm(join(directory, 'model.yml'))
    const restarted = new ModelConfigurationStore(directory, secrets)
    expect((await restarted.read()).error).toBeTruthy()
    expect((await restarted.runtime()).models).toHaveLength(2)
  })
  test('rotating a provider key updates all models and never changes their IDs', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    const snapshot = await store.save(empty.revision, parseModelConfiguration(YAML).config.providers)
    await store.save(snapshot.revision, snapshot.providers.map(provider => ({ ...provider, api_key: 'rotated-key' })))
    const runtime = await store.runtime()
    expect(runtime.models.map(entry => entry.provider.api_key)).toEqual(['rotated-key', 'rotated-key'])
    expect(runtime.models.map(entry => entry.model.id)).toEqual(['first', 'second'])
  })
  test('a different binding invalidates a page revision even for identical file contents', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    const before = await store.read()
    const other = join(directory, 'other.yml')
    await writeFile(other, YAML)
    const after = await store.bind(other)
    expect(after.revision).not.toBe(before.revision)
    await expect(store.save(before.revision, before.providers)).rejects.toThrow(/changed externally/)
    expect(await readFile(other, 'utf8')).toBe(YAML)
  })
  test('binding rejects an invalid file and preserves the previous binding', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const before = await store.read()
    const invalid = join(directory, 'invalid.yml')
    await writeFile(invalid, 'version: [')
    await expect(store.bind(invalid)).rejects.toThrow()
    expect((await store.read()).path).toBe(before.path)
  })
})
