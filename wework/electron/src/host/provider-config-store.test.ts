import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderConfigStore } from './provider-config-store.js'
import { SecureValueStore } from './secure-value-store.js'
import { effectiveProviderPath, parseProviderFile } from './provider-config-schema.js'
import type { ProviderConnection, ProviderFileSnapshot } from './provider-config-types.js'

let directory: string
let store: ProviderConfigStore
let secrets: SecureValueStore
const provider: Omit<ProviderConnection, 'models'> = {
  id: 'relay',
  name: 'Main relay',
  base_url: 'https://example.invalid/v1',
  api_format: 'openai-responses',
  api_key: 'test-secret-do-not-log',
}
async function populated(): Promise<ProviderFileSnapshot> {
  const empty = await store.read()
  const connection = await store.mutate(empty.revision, { kind: 'save-provider', provider })
  return store.mutate(connection.revision, {
    kind: 'save-models',
    providerId: 'relay',
    models: [
      { id: 'primary', model_id: 'upstream-a' },
      { id: 'secondary', model_id: 'upstream-b' },
    ],
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wework-provider-test-'))
  secrets = new SecureValueStore(join(directory, 'secure'))
  store = new ProviderConfigStore(join(directory, 'config'), secrets)
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('ProviderConfigStore real file and encrypted credential integration', () => {
  it('creates one connection with many models and stores only a credential reference', async () => {
    const snapshot = await populated()
    expect(snapshot.providers[0].models).toHaveLength(2)
    expect(JSON.stringify(snapshot)).not.toContain('test-secret-do-not-log')
    const source = await readFile(snapshot.path, 'utf8')
    expect(source).toContain('api_key_ref: model-provider.')
    expect(source).not.toContain('test-secret-do-not-log')
    expect(await store.credentials(snapshot.revision)).toEqual({ relay: 'test-secret-do-not-log' })
    if (process.platform !== 'win32') expect((await stat(snapshot.path)).mode & 0o777).toBe(0o600)
  })
  it('GUI writes and external file edits converge without duplicate models', async () => {
    let snapshot = await populated()
    await writeFile(
      snapshot.path,
      (await readFile(snapshot.path, 'utf8')).replace('upstream-a', 'upstream-a-v2')
    )
    snapshot = await store.read()
    expect(snapshot.providers[0].models[0]).toMatchObject({
      id: 'primary',
      model_id: 'upstream-a-v2',
    })
    snapshot = await store.mutate(snapshot.revision, {
      kind: 'save-models',
      providerId: 'relay',
      models: [{ id: 'primary', model_id: 'upstream-a-v2', display_name: 'My name' }],
    })
    expect(snapshot.providers[0].models).toHaveLength(2)
    expect((await store.read()).revision).toBe(snapshot.revision)
  })
  it('rotates a shared key once without changing model IDs', async () => {
    const snapshot = await populated()
    const next = await store.mutate(snapshot.revision, {
      kind: 'save-provider',
      provider: { ...provider, api_key: 'new-test-key' },
    })
    expect(next.providers[0].models.map(model => model.id)).toEqual(['primary', 'secondary'])
    expect(await store.credentials(next.revision)).toEqual({ relay: 'new-test-key' })
    expect(await readFile(next.path, 'utf8')).not.toContain('new-test-key')
  })
  it('preserves a key on ordinary edits and allows explicit clearing', async () => {
    let snapshot = await populated()
    const { api_key, ...withoutKey } = provider
    expect(api_key).toBeTruthy()
    snapshot = await store.mutate(snapshot.revision, {
      kind: 'save-provider',
      provider: { ...withoutKey, name: 'Renamed' },
    })
    expect(await store.credentials(snapshot.revision)).toEqual({ relay: 'test-secret-do-not-log' })
    snapshot = await store.mutate(snapshot.revision, {
      kind: 'save-provider',
      provider: { ...withoutKey, api_key: '' },
    })
    expect(await store.credentials(snapshot.revision)).toEqual({ relay: '' })
  })
  it('retains the previous snapshot after malformed YAML, including after restart', async () => {
    const snapshot = await populated()
    await writeFile(snapshot.path, 'version: 1\nproviders: [\n api_key: secret-in-bad-file')
    const failed = await store.read()
    expect(failed.revision).toBe(snapshot.revision)
    expect(failed.error).toContain('line')
    expect(failed.error).not.toContain('secret-in-bad-file')
    const restarted = new ProviderConfigStore(join(directory, 'config'), secrets)
    const recovered = await restarted.read()
    expect(recovered.providers).toEqual(snapshot.providers)
    expect(await restarted.credentials(recovered.revision)).toEqual({
      relay: 'test-secret-do-not-log',
    })
  })
  it('does not overwrite an external edit or a concurrently saved GUI revision', async () => {
    const snapshot = await populated()
    const edited = `${await readFile(snapshot.path, 'utf8')}# external comment\n`
    await writeFile(snapshot.path, edited)
    await expect(
      store.mutate(snapshot.revision, { kind: 'delete-provider', providerId: 'relay' })
    ).rejects.toMatchObject({ code: 'provider_config_conflict' })
    expect(await readFile(snapshot.path, 'utf8')).toBe(edited)
    const reloaded = await store.read()
    const results = await Promise.allSettled([
      store.mutate(reloaded.revision, {
        kind: 'save-models',
        providerId: 'relay',
        models: [{ id: 'third', model_id: 'upstream-c' }],
      }),
      store.mutate(reloaded.revision, {
        kind: 'delete-model',
        providerId: 'relay',
        modelId: 'primary',
      }),
    ])
    expect(results.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
  })
  it('preserves comments and validates the complete batch before saving', async () => {
    let snapshot = await populated()
    await writeFile(snapshot.path, `# my important note\n${await readFile(snapshot.path, 'utf8')}`)
    snapshot = await store.read()
    const before = await readFile(snapshot.path, 'utf8')
    await expect(
      store.mutate(snapshot.revision, {
        kind: 'save-models',
        providerId: 'relay',
        models: [
          { id: 'third', model_id: 'upstream-c' },
          { id: 'bad', model_id: '' },
        ],
      })
    ).rejects.toThrow()
    expect(await readFile(snapshot.path, 'utf8')).toBe(before)
    const next = await store.mutate(snapshot.revision, {
      kind: 'delete-model',
      providerId: 'relay',
      modelId: 'secondary',
    })
    expect(await readFile(next.path, 'utf8')).toContain('# my important note')
  })
  it('accepts plaintext keys in user-owned YAML but redacts public responses', async () => {
    const path = join(directory, 'external.yml')
    await writeFile(
      path,
      'version: 1\nproviders:\n  - id: custom\n    name: Custom\n    base_url: https://example.invalid/v1\n    api_format: openai-responses\n    api_key: private-example\n    models: []\n'
    )
    const snapshot = await store.bind(path)
    expect(snapshot.path).toBe(await realpath(path))
    expect(JSON.stringify(snapshot)).not.toContain('private-example')
    expect(await store.credentials(snapshot.revision)).toEqual({ custom: 'private-example' })
    const restarted = new ProviderConfigStore(join(directory, 'config'), secrets)
    expect((await restarted.read()).path).toBe(await realpath(path))
  })
  it('rejects missing credential references without losing the working configuration', async () => {
    const snapshot = await populated()
    await writeFile(
      snapshot.path,
      (await readFile(snapshot.path, 'utf8')).replace(
        /model-provider\.[a-z0-9-]+/,
        'model-provider.missing'
      )
    )
    const failed = await store.read()
    expect(failed.error).toContain('not available')
    expect(failed.revision).toBe(snapshot.revision)
  })
  it('scopes revisions to the bound file, even when two files have identical contents', async () => {
    const first = await populated()
    const other = join(directory, 'other.yml')
    await writeFile(other, await readFile(first.path, 'utf8'))
    const second = await store.bind(other)
    expect(second.revision).not.toBe(first.revision)
    await expect(
      store.mutate(first.revision, { kind: 'delete-provider', providerId: 'relay' })
    ).rejects.toThrow()
  })
  it('discovers model IDs with one connection and never exposes upstream error bodies', async () => {
    const snapshot = await populated()
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }] }), {
        status: 200,
      })
    )
    expect(await store.discover('relay', snapshot.revision, fetcher)).toEqual(['a', 'z'])
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.invalid/v1/models',
      expect.objectContaining({
        redirect: 'error',
        headers: { Authorization: 'Bearer test-secret-do-not-log' },
      })
    )
    fetcher.mockResolvedValue(new Response('private-body', { status: 401 }))
    await expect(store.discover('relay', snapshot.revision, fetcher)).rejects.toThrow('HTTP 401')
    await expect(store.discover('relay', snapshot.revision, fetcher)).rejects.not.toThrow(
      'private-body'
    )
    expect((await store.read()).providers).toEqual(snapshot.providers)
  })
  it('does not delete a model referenced as a vision sidecar', async () => {
    const snapshot = await populated()
    const next = await store.mutate(snapshot.revision, {
      kind: 'save-models',
      providerId: 'relay',
      models: [
        { id: 'primary', model_id: 'upstream-a', settings: { visionModelConfigId: 'secondary' } },
      ],
    })
    await expect(
      store.mutate(next.revision, {
        kind: 'delete-model',
        providerId: 'relay',
        modelId: 'secondary',
      })
    ).rejects.toMatchObject({ code: 'provider_model_referenced' })
  })
})

describe('provider YAML schema', () => {
  it.each([
    'version: 1\nversion: 1\nproviders: []',
    'version: 2\nproviders: []',
    'version: 1\nproviders: []\ncloud_models: []',
    'version: 1\nproviders: !!python/object []',
    'version: 1\nproviders: &x [*x]',
  ])('rejects unsupported or ambiguous YAML', source => {
    expect(() => parseProviderFile(source)).toThrow()
  })
  it('rejects credentials in URLs and preserves protocol-specific request paths', () => {
    const input = {
      version: 1,
      providers: [{ ...provider, base_url: 'https://user:password@example.invalid', models: [] }],
    }
    expect(() => parseProviderFile(JSON.stringify(input))).toThrow('without credentials')
    const connection: ProviderConnection = {
      ...provider,
      request_path: '/custom-responses',
      models: [],
    }
    expect(effectiveProviderPath(connection)).toBe('/custom-responses')
    expect(
      effectiveProviderPath(connection, {
        id: 'm',
        model_id: 'm',
        api_format: 'anthropic-messages',
      })
    ).toBe('/messages')
  })
})
