import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  EMPTY_PROVIDER_YAML,
  MAX_PROVIDER_FILE_BYTES,
  parseProviderDocument,
  type ProviderConnection,
  type ProviderFileSnapshot,
  type ProviderMutation,
} from './model-provider-schema.js'

interface Preferences {
  read(): Promise<Record<string, unknown>>
  update(patch: Record<string, unknown>): Promise<Record<string, unknown>>
}
interface Credentials {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const BINDING = 'modelProviderFile'
const LAST_GOOD = 'wework.model-providers.last-good'
const MIGRATION_BACKUP = 'wework.model-providers.migration-backup'
const conflict = () => new Error('MODEL_CONFIG_CONFLICT: the file changed; reload before saving')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
type Parsed = ReturnType<typeof parseProviderDocument>

/** One serialized writer per desktop host; cloud model data never enters this store. */
export class ModelProviderStore {
  private operation = Promise.resolve()
  private lastGood: { path: string; text: string } | null = null
  private revision = ''

  constructor(
    private readonly dataDirectory: string,
    private readonly preferences: Preferences,
    private readonly secrets: Credentials,
    private readonly changed: (revision: string) => void = () => {}
  ) {}

  filePath(): Promise<string> {
    return this.serial(() => this.boundPath())
  }

  read(): Promise<ProviderFileSnapshot> {
    return this.serial(async () => {
      const path = await this.boundPath()
      try {
        return await this.accept(path, await this.readText(path))
      } catch (error) {
        const cached = this.lastGood ?? (await this.readLastGood())
        if (!cached || cached.path !== path)
          return {
            path,
            revision: 'unavailable',
            providers: [],
            credentials: {},
            error: safeError(error),
          }
        return this.snapshot(path, cached.text, safeError(error))
      }
    })
  }

  bind(
    path: string,
    expectedPath: string,
    _expectedRevision: string,
    legacyIds: string[] = []
  ): Promise<ProviderFileSnapshot> {
    return this.serial(async () => {
      if ((await this.boundPath()) !== expectedPath) throw conflict()
      const resolved = await realpath(path)
      const text = await this.readText(resolved, false)
      const { value } = parseProviderDocument(text)
      const conflicts = new Set(legacyIds)
      if (
        value.providers.some(provider => provider.models.some(model => conflicts.has(model.id)))
      ) {
        throw new Error(
          'Model IDs conflict with existing local models; migrate them or use different IDs'
        )
      }
      await this.snapshot(resolved, text, null)
      await this.preferences.update({ [BINDING]: resolved })
      try {
        return await this.accept(resolved, text)
      } catch (error) {
        await this.preferences.update({ [BINDING]: expectedPath })
        throw error
      }
    })
  }

  update(
    path: string,
    expectedRevision: string,
    mutation: ProviderMutation
  ): Promise<ProviderFileSnapshot> {
    return this.serial(async () => {
      const previous = await this.assertCurrent(path, expectedRevision)
      const parsed = parseProviderDocument(previous)
      if (!mutation || typeof mutation !== 'object')
        throw new Error('Invalid model configuration change')
      const createdSecrets: string[] = []
      try {
        await this.mutate(parsed, mutation, createdSecrets)
        const text = parsed.document.toString({ lineWidth: 0 })
        parseProviderDocument(text)
        if (mutation.kind === 'migrate') {
          await this.secrets.set(
            MIGRATION_BACKUP,
            JSON.stringify({ path, providers: mutation.providers })
          )
        }
        await this.atomicWrite(path, text, expectedRevision)
        return await this.accept(path, text)
      } catch (error) {
        // Keep references after a successful file write even if a later cache write failed.
        const current = await this.readText(path, false).catch(() => '')
        for (const key of createdSecrets) {
          if (!current.includes(key)) await this.secrets.delete(key).catch(() => {})
        }
        throw error
      }
    })
  }

  discover(
    providerId: string,
    path: string,
    revision: string,
    fetcher: typeof fetch = fetch
  ): Promise<string[]> {
    return this.serial(async () => {
      const text = await this.assertCurrent(path, revision)
      const snapshot = await this.snapshot(path, text, null)
      const provider = snapshot.providers.find(item => item.id === providerId)
      if (!provider || provider.credential_missing)
        throw new Error('Provider or its API credential is unavailable')
      const key = snapshot.credentials[provider.id]
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (key) {
        headers.Authorization = `Bearer ${key}`
        if (provider.api_format === 'anthropic-messages') {
          headers['x-api-key'] = key
          headers['anthropic-version'] = '2023-06-01'
        }
      }
      const url = `${provider.base_url.replace(/\/+$/, '')}${provider.models_path ?? '/models'}`
      let response: Response
      try {
        response = await fetcher(url, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        })
      } catch {
        throw new Error(
          'Model discovery failed or timed out; check the connection and model-list path'
        )
      }
      if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`)
      if (Number(response.headers.get('content-length') ?? '0') > MAX_PROVIDER_FILE_BYTES)
        throw new Error('Model list exceeds 2 MiB')
      const body = await response.text()
      if (new TextEncoder().encode(body).length > MAX_PROVIDER_FILE_BYTES)
        throw new Error('Model list exceeds 2 MiB')
      let data: unknown
      try {
        data = (JSON.parse(body) as { data?: unknown }).data
      } catch {
        throw new Error('Model list is not JSON')
      }
      if (!Array.isArray(data)) throw new Error('Model list must contain a data array')
      return [
        ...new Set(
          data.flatMap(item =>
            item && typeof item.id === 'string' && item.id.trim() ? [item.id.trim() as string] : []
          )
        ),
      ].sort()
    })
  }

  private async mutate(
    parsed: Parsed,
    mutation: ProviderMutation,
    created: string[]
  ): Promise<void> {
    const { document, value } = parsed
    if (mutation.kind === 'migrate') {
      if (!Array.isArray(mutation.providers)) throw new Error('Invalid migration input')
      // Validate before storing any secrets; migration must preserve all model IDs.
      parseProviderDocument(
        JSON.stringify({ version: 1, providers: [...value.providers, ...mutation.providers] })
      )
      for (const provider of mutation.providers) {
        const next = { ...provider }
        if (next.api_key) {
          next.api_key_ref = await this.storeSecret(next.api_key, created)
          delete next.api_key
        }
        document.addIn(['providers'], document.createNode(next))
      }
      return
    }
    if (mutation.kind === 'provider') {
      const patch = mutation.provider
      if (!patch || typeof patch.id !== 'string') throw new Error('Invalid provider')
      const index = value.providers.findIndex(provider => provider.id === patch.id)
      const previous = index >= 0 ? value.providers[index] : null
      const next: ProviderConnection = { ...previous, ...patch, models: previous?.models ?? [] }
      if (mutation.clearApiKey) {
        delete next.api_key
        delete next.api_key_ref
      }
      if (mutation.apiKey !== undefined && mutation.apiKey.trim()) {
        delete next.api_key
        next.api_key_ref = await this.storeSecret(mutation.apiKey.trim(), created)
      }
      if (index < 0) document.addIn(['providers'], document.createNode(next))
      else patchMap(parsed, ['providers', index], next)
      return
    }
    const index = value.providers.findIndex(provider => provider.id === mutation.providerId)
    if (index < 0) throw new Error('Provider no longer exists; reload the configuration')
    const provider = value.providers[index]
    if (mutation.kind === 'delete-provider') {
      document.deleteIn(['providers', index])
    } else if (mutation.kind === 'model') {
      const modelIndex = provider.models.findIndex(model => model.id === mutation.model.id)
      if (modelIndex < 0)
        document.addIn(['providers', index, 'models'], document.createNode(mutation.model))
      else patchMap(parsed, ['providers', index, 'models', modelIndex], mutation.model)
    } else if (mutation.kind === 'delete-model') {
      const modelIndex = provider.models.findIndex(model => model.id === mutation.modelId)
      if (modelIndex < 0) throw new Error('Model no longer exists; reload the configuration')
      document.deleteIn(['providers', index, 'models', modelIndex])
    } else if (mutation.kind === 'add-models') {
      if (!Array.isArray(mutation.modelIds) || mutation.modelIds.length > 1000)
        throw new Error('Invalid model list')
      const existing = new Set(provider.models.map(model => model.model_id))
      for (const id of mutation.modelIds) {
        if (typeof id !== 'string' || !id.trim())
          throw new Error('Model IDs must be non-empty text')
        if (existing.has(id.trim())) continue
        existing.add(id.trim())
        document.addIn(
          ['providers', index, 'models'],
          document.createNode({ id: randomUUID(), model_id: id.trim() })
        )
      }
    } else {
      throw new Error('Unknown model configuration operation')
    }
  }

  private async storeSecret(value: string, created: string[]): Promise<string> {
    const key = `model-provider.${randomUUID()}`
    await this.secrets.set(key, value)
    created.push(key)
    return key
  }

  private async boundPath(): Promise<string> {
    const preferences = await this.preferences.read()
    return typeof preferences[BINDING] === 'string'
      ? preferences[BINDING]
      : join(this.dataDirectory, 'model.yml')
  }

  private async readText(path: string, initialize = true): Promise<string> {
    try {
      const metadata = await stat(path)
      if (!metadata.isFile() || metadata.size > MAX_PROVIDER_FILE_BYTES)
        throw new Error('Model configuration must be a file no larger than 2 MiB')
      return await readFile(path, 'utf8')
    } catch (error) {
      const defaultPath = join(this.dataDirectory, 'model.yml')
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        !initialize ||
        path !== defaultPath ||
        this.lastGood ||
        (await this.readLastGood())
      )
        throw error
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const file = await open(path, 'wx', 0o600)
      try {
        await file.writeFile(EMPTY_PROVIDER_YAML, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      return EMPTY_PROVIDER_YAML
    }
  }

  private async assertCurrent(path: string, revision: string): Promise<string> {
    if ((await this.boundPath()) !== path) throw conflict()
    const text = await this.readText(path, false)
    if (digest(text) !== revision) throw conflict()
    return text
  }

  private async atomicWrite(path: string, text: string, revision: string): Promise<void> {
    const temporary = join(dirname(path), `.model-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(text, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await this.assertCurrent(path, revision)
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async accept(path: string, text: string): Promise<ProviderFileSnapshot> {
    const result = await this.snapshot(path, text, null)
    const identity = `${path}:${result.revision}`
    if (identity !== this.revision) {
      await this.secrets.set(LAST_GOOD, JSON.stringify({ path, text }))
      this.lastGood = { path, text }
      this.revision = identity
      this.changed(result.revision)
    }
    return result
  }

  private async snapshot(
    path: string,
    text: string,
    error: string | null
  ): Promise<ProviderFileSnapshot> {
    const { value } = parseProviderDocument(text)
    const credentials: Record<string, string> = Object.create(null)
    const providers = await Promise.all(
      value.providers.map(async provider => {
        const key = provider.api_key_ref
          ? await this.secrets.get(provider.api_key_ref)
          : provider.api_key
        if (key) credentials[provider.id] = key
        const { api_key: _key, ...publicProvider } = provider
        return {
          ...publicProvider,
          api_key_configured: Boolean(key),
          credential_missing: Boolean(provider.api_key_ref && !key),
        }
      })
    )
    return { path, revision: digest(text), providers, credentials, error }
  }

  private async readLastGood(): Promise<{ path: string; text: string } | null> {
    const text = await this.secrets.get(LAST_GOOD)
    if (!text) return null
    try {
      const value = JSON.parse(text)
      if (typeof value.path === 'string' && typeof value.text === 'string') return value
    } catch {
      /* A corrupt cache must not replace an otherwise valid configuration. */
    }
    return null
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function patchMap(parsed: Parsed, path: Array<string | number>, value: object): void {
  const previous = parsed.document.getIn(path) as { toJSON?: () => Record<string, unknown> }
  const old = previous?.toJSON?.() ?? {}
  const next = value as Record<string, unknown>
  for (const key of Object.keys(old)) {
    if (next[key] === undefined) parsed.document.deleteIn([...path, key])
  }
  for (const [key, item] of Object.entries(next)) {
    if (item !== undefined && JSON.stringify(old[key]) !== JSON.stringify(item)) {
      parsed.document.setIn([...path, key], parsed.document.createNode(item))
    }
  }
}

function safeError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error)
    return `Model configuration could not be read (${String(error.code)})`
  return error instanceof Error ? error.message : 'Model configuration could not be loaded'
}
