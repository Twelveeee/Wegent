import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderConfigStore } from './provider-config-store.js'
import { parseProviderYaml, validateProviderDocument } from './provider-config-schema.js'
import type { ProviderConnection } from '../../../shared/provider-model-config.js'

const provider = (id = 'relay'): ProviderConnection => ({
  id,
  name: 'My relay',
  base_url: 'https://relay.example/v1',
  api_format: 'openai-responses',
  api_key: 'test-secret',
  models: [
    { id: `${id}-a`, model_id: 'shared-upstream' },
    { id: `${id}-b`, model_id: 'fast' },
  ],
})
let root: string
let secrets: Map<string, string>
let store: ProviderConfigStore
const credentials = {
  get: async (key: string) => secrets.get(key) ?? null,
  set: async (key: string, value: string) => {
    secrets.set(key, value)
  },
  delete: async (key: string) => {
    secrets.delete(key)
  },
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'provider-config-'))
  secrets = new Map()
  store = new ProviderConfigStore(root, credentials)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('bound provider file transactions', () => {
  it('saves shared credentials once, redacts the document and survives a restart', async () => {
    const empty = await store.read()
    const saved = await store.update({ kind: 'upsert', provider: provider() }, empty.revision)
    const source = await readFile(saved.path, 'utf8')
    expect(source).not.toContain('test-secret')
    expect(source).toContain('api_key_ref: wework-model-')
    expect(saved.document.providers[0].api_key).toBeUndefined()
    expect(saved.credentials.relay).toBe('test-secret')
    expect(secrets.size).toBe(1)
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600)
    const restarted = await new ProviderConfigStore(root, credentials).read()
    expect(restarted.document).toEqual(saved.document)
    expect(restarted.revision).toBe(saved.revision)
  })
  it('keeps an omitted key, rotates it once and clears it explicitly', async () => {
    let saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    saved = await store.update(
      { kind: 'upsert', provider: { ...saved.document.providers[0], name: 'Renamed' } },
      saved.revision
    )
    expect(saved.credentials.relay).toBe('test-secret')
    const next = { ...saved.document.providers[0], api_key: 'new-secret' }
    delete next.api_key_ref
    saved = await store.update({ kind: 'upsert', provider: next }, saved.revision)
    expect(saved.credentials.relay).toBe('new-secret')
    saved = await store.update(
      { kind: 'upsert', provider: saved.document.providers[0], clearKey: true },
      saved.revision
    )
    expect(saved.credentials.relay).toBeUndefined()
    expect(saved.document.providers[0].api_key_ref).toBeUndefined()
  })
  it('preserves YAML comments and model IDs during UI edits', async () => {
    const path = join(root, 'external.yml')
    await writeFile(
      path,
      '# my providers\nversion: 1\nproviders:\n  - id: relay # stable identity\n    name: Old\n    base_url: https://relay.example/v1\n    api_format: openai-responses\n    api_key: inline-secret\n    models:\n      - id: first # keep this model\n        model_id: upstream\n'
    )
    const loaded = await store.bind(path)
    const saved = await store.update(
      { kind: 'upsert', provider: { ...loaded.document.providers[0], name: 'New' } },
      loaded.revision
    )
    const source = await readFile(path, 'utf8')
    expect(source).toContain('# my providers')
    expect(source).toContain('# stable identity')
    expect(source).toContain('# keep this model')
    expect(saved.document.providers[0].models[0].id).toBe('first')
    expect(saved.credentials.relay).toBe('inline-secret')
  })
  it('rejects external edits instead of overwriting them', async () => {
    const saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    const edited = (await readFile(saved.path, 'utf8')).replace('My relay', 'External name')
    await writeFile(saved.path, edited)
    await expect(
      store.update({ kind: 'delete', providerId: 'relay' }, saved.revision)
    ).rejects.toThrow('CONFIG_CONFLICT')
    expect(await readFile(saved.path, 'utf8')).toBe(edited)
  })
  it('serializes simultaneous saves and rejects the stale writer', async () => {
    const result = await Promise.allSettled([
      store.update({ kind: 'upsert', provider: provider('one') }, 'missing'),
      store.update({ kind: 'upsert', provider: provider('two') }, 'missing'),
    ])
    expect(result.map(entry => entry.status)).toEqual(['fulfilled', 'rejected'])
    expect((await store.read()).document.providers).toHaveLength(1)
  })
  it('does not commit partial import or orphan new keys after validation fails', async () => {
    const invalid = { ...provider('two'), models: provider('one').models }
    await expect(
      store.update({ kind: 'import', providers: [provider('one'), invalid] }, 'missing')
    ).rejects.toThrow('duplicate')
    expect((await store.read()).document.providers).toEqual([])
    expect(secrets.size).toBe(0)
  })
  it('preserves last-good models on malformed YAML and recovers on restart', async () => {
    const saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    await writeFile(saved.path, 'secret: [test-secret')
    const failed = await store.read()
    expect(failed.document).toEqual(saved.document)
    expect(failed.error).toContain('Invalid YAML')
    expect(failed.error).not.toContain('test-secret')
    const restarted = await new ProviderConfigStore(root, credentials).read()
    expect(restarted.document).toEqual(saved.document)
    expect(restarted.error).toContain('Invalid YAML')
  })
  it('does not treat an externally deleted configuration as an empty catalog', async () => {
    const saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    await rm(saved.path)
    expect((await store.read()).document).toEqual(saved.document)
    const restarted = await new ProviderConfigStore(root, credentials).read()
    expect(restarted.document).toEqual(saved.document)
    expect(restarted.error).toContain('missing')
  })
  it('rejects an invalid file binding and keeps the previous file', async () => {
    const saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    const path = join(root, 'bad.yml')
    await writeFile(path, 'version: 99')
    await expect(store.bind(path)).rejects.toThrow('version')
    expect((await store.read()).path).toBe(saved.path)
  })
  it('disallows symlinks and unrelated credential references', async () => {
    const saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    const link = join(root, 'link.yml')
    await symlink(saved.path, link)
    await expect(store.bind(link)).rejects.toThrow('symbolic')
    const other = provider()
    delete other.api_key
    other.api_key_ref = 'unrelated-auth-token'
    expect(() => validateProviderDocument({ version: 1, providers: [other] })).toThrow(
      'credential reference'
    )
  })
  it('reports unavailable credential references without leaking other credentials', async () => {
    const saved = await store.update({ kind: 'upsert', provider: provider() }, 'missing')
    secrets.clear()
    const loaded = await store.read()
    expect(loaded.credentials.relay).toBeUndefined()
    expect(loaded.warnings?.[0]).toContain('unavailable')
    expect(loaded.document).toEqual(saved.document)
  })
  it('does not write the file if credential retrieval fails during a transaction', async () => {
    const broken = new ProviderConfigStore(root, {
      ...credentials,
      get: async () => {
        throw new Error('credential read failed')
      },
    })
    await expect(
      broken.update({ kind: 'upsert', provider: provider() }, 'missing')
    ).rejects.toThrow('credential read failed')
    expect(secrets.size).toBe(0)
    expect((await store.read()).document.providers).toEqual([])
  })
  it('can save an empty provider and later delete it', async () => {
    let saved = await store.update(
      { kind: 'upsert', provider: { ...provider(), models: [] } },
      'missing'
    )
    expect(saved.document.providers).toHaveLength(1)
    saved = await store.update({ kind: 'delete', providerId: 'relay' }, saved.revision)
    expect(saved.document.providers).toEqual([])
  })
})

describe('strict model file schema', () => {
  it('rejects aliases, duplicate mapping keys and unknown fields', () => {
    expect(() => parseProviderYaml('version: 1\nproviders: &p []\nextra: *p')).toThrow('aliases')
    expect(() => parseProviderYaml('version: 1\nversion: 1\nproviders: []')).toThrow('Invalid YAML')
    expect(() => parseProviderYaml('version: 1\nproviders: []\nextra: true')).toThrow(
      'unsupported field'
    )
  })
  it('rejects invalid protocol, paths and custom tools on Messages', () => {
    expect(() =>
      validateProviderDocument({ version: 1, providers: [{ ...provider(), api_format: 'auto' }] })
    ).toThrow('protocol')
    expect(() =>
      validateProviderDocument({
        version: 1,
        providers: [{ ...provider(), request_path: '//elsewhere' }],
      })
    ).toThrow('relative API path')
    expect(() =>
      validateProviderDocument({
        version: 1,
        providers: [
          {
            ...provider(),
            models: [
              { id: 'a', model_id: 'a', api_format: 'anthropic-messages', tool_profile: 'custom' },
            ],
          },
        ],
      })
    ).toThrow('custom tools')
  })
  it('rejects colliding generated catalog identities before persistence', () => {
    expect(() =>
      validateProviderDocument({
        version: 1,
        providers: [
          {
            ...provider(),
            models: [
              { id: 'MODEL', model_id: 'a' },
              { id: 'model', model_id: 'b' },
            ],
          },
        ],
      })
    ).toThrow('duplicate catalog')
  })
})
