import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { Document } from 'yaml'
import { HostCapabilityError } from './capability-router.js'
import {
  parseProviderFile,
  MAX_PROVIDER_FILE_BYTES,
  validateProviderDocument,
} from './provider-config-schema.js'
import type {
  ProviderConnection,
  ProviderDocument,
  ProviderFileMutation,
  ProviderFileSnapshot,
} from './provider-config-types.js'

interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

interface AcceptedFile {
  path: string
  source: string
  config: ProviderDocument
  revision: string
}

const EMPTY_CONFIG =
  '# Local connections only. Cloud-delivered models are managed separately.\nversion: 1\nproviders: []\n'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const conflict = () =>
  new HostCapabilityError(
    'provider_config_conflict',
    'The configuration changed outside this editor. Reload before saving.'
  )
const invalid = () =>
  new HostCapabilityError('invalid_params', 'Invalid provider configuration operation')

/** Serializes GUI writes, preserves YAML comments, and never overwrites a failed reload. */
export class ProviderConfigStore {
  private operation: Promise<unknown> = Promise.resolve()
  private path: string | null = null
  private accepted: AcceptedFile | null = null

  constructor(
    private readonly directory: string,
    private readonly secrets: SecretStore
  ) {}

  read(): Promise<ProviderFileSnapshot> {
    return this.serial(() => this.reload())
  }

  bind(path: string): Promise<ProviderFileSnapshot> {
    return this.serial(async () => {
      if (!['.yml', '.yaml'].includes(extname(path).toLowerCase())) throw invalid()
      const target = await realpath(path)
      const candidate = await this.readCandidate(target)
      await this.assertCredentials(candidate.config)
      await atomicWrite(join(this.directory, 'binding.json'), JSON.stringify({ path: target }))
      this.path = target
      await this.accept(candidate)
      return this.snapshot()
    })
  }

  credentials(revision: string): Promise<Record<string, string>> {
    return this.serial(async () => {
      if (!this.accepted || this.accepted.revision !== revision) throw conflict()
      const entries = await Promise.all(
        this.accepted.config.providers.map(
          async provider => [provider.id, await this.key(provider)] as const
        )
      )
      return Object.fromEntries(entries)
    })
  }

  mutate(revision: string, mutation: ProviderFileMutation): Promise<ProviderFileSnapshot> {
    return this.serial(async () => {
      const path = await this.boundPath()
      const current = await this.readCandidate(path)
      if (current.revision !== revision) throw conflict()
      const { yaml } = parseProviderFile(current.source)
      applyMutation(yaml, current.config, mutation)
      let nextConfig = validateProviderDocument(yaml.toJS({ maxAliasCount: 0 }))
      const secretWrites: Array<{ ref: string; value: string }> = []
      // Only explicitly supplied keys are moved into the existing encrypted local store.
      const keyedIds =
        mutation.kind === 'save-provider' && mutation.provider.api_key !== undefined
          ? [mutation.provider.id]
          : mutation.kind === 'import-providers'
            ? mutation.providers.filter(item => item.api_key !== undefined).map(item => item.id)
            : []
      for (const [index, provider] of nextConfig.providers.entries()) {
        if (!keyedIds.includes(provider.id)) continue
        yaml.deleteIn(['providers', index, 'api_key'])
        yaml.deleteIn(['providers', index, 'api_key_ref'])
        if (provider.api_key?.trim()) {
          const ref = `model-provider.${randomUUID()}`
          yaml.setIn(['providers', index, 'api_key_ref'], ref)
          secretWrites.push({ ref, value: provider.api_key.trim() })
        }
      }
      const source = yaml.toString({ lineWidth: 0 })
      nextConfig = parseProviderFile(source).config
      try {
        for (const write of secretWrites) await this.secrets.set(write.ref, write.value)
        await this.assertCredentials(nextConfig)
        await atomicWrite(path, source, async () => {
          if (hash(`${path}\0${await readFile(path, 'utf8')}`) !== revision) throw conflict()
        })
      } catch (error) {
        await Promise.all(secretWrites.map(write => this.secrets.delete(write.ref)))
        throw error
      }
      await this.accept({ path, source, config: nextConfig, revision: hash(`${path}\0${source}`) })
      return this.snapshot()
    })
  }

  async discover(
    providerId: string,
    revision: string,
    fetcher: typeof fetch = fetch
  ): Promise<string[]> {
    const selected = await this.serial(async () => {
      if (!this.accepted || this.accepted.revision !== revision) throw conflict()
      const provider = this.accepted.config.providers.find(item => item.id === providerId)
      if (!provider) throw invalid()
      return { provider: { ...provider }, apiKey: await this.key(provider) }
    })
    const { provider, apiKey } = selected
    const url = `${provider.base_url.replace(/\/+$/, '')}${provider.models_path ?? '/models'}`
    const headers: Record<string, string> = {}
    if (apiKey) {
      if (provider.api_format === 'anthropic-messages') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else headers.Authorization = `Bearer ${apiKey}`
    }
    let response: Response
    try {
      response = await fetcher(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new HostCapabilityError(
        'provider_discovery_failed',
        'Model discovery failed or timed out. Manual model entry is still available.'
      )
    }
    if (!response.ok)
      throw new HostCapabilityError(
        'provider_discovery_failed',
        `Model discovery returned HTTP ${response.status}. Manual model entry is still available.`
      )
    const reader = response.body?.getReader()
    if (!reader) throw invalid()
    let length = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_PROVIDER_FILE_BYTES) throw new Error('oversized')
        chunks.push(value)
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        data?: Array<{ id?: unknown }>
      }
      if (!Array.isArray(result.data)) throw new Error('invalid')
      return [
        ...new Set(
          result.data.flatMap(item =>
            typeof item?.id === 'string' && item.id.trim() ? [item.id.trim()] : []
          )
        ),
      ].sort()
    } catch {
      throw new HostCapabilityError(
        'provider_discovery_failed',
        'The provider did not return a supported model list. Use manual entry instead.'
      )
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private async boundPath(): Promise<string> {
    if (this.path) return this.path
    try {
      const binding = JSON.parse(await readFile(join(this.directory, 'binding.json'), 'utf8')) as {
        path?: unknown
      }
      if (typeof binding.path !== 'string') throw invalid()
      this.path = binding.path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const path = join(this.directory, 'model.yml')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      try {
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(EMPTY_CONFIG)
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      }
      await atomicWrite(join(this.directory, 'binding.json'), JSON.stringify({ path }))
      this.path = path
    }
    return this.path
  }

  private async reload(): Promise<ProviderFileSnapshot> {
    const path = await this.boundPath()
    try {
      const candidate = await this.readCandidate(path)
      await this.assertCredentials(candidate.config)
      await this.accept(candidate)
      return this.snapshot()
    } catch (error) {
      if (!this.accepted || this.accepted.path !== path) {
        const previous = await this.secrets.get(`provider-config.last-good.${hash(path)}`)
        if (previous) {
          try {
            this.accepted = {
              path,
              source: previous,
              config: parseProviderFile(previous).config,
              revision: hash(`${path}\0${previous}`),
            }
          } catch {
            /* An invalid recovery snapshot is not applied. */
          }
        }
      }
      const message =
        error instanceof HostCapabilityError
          ? error.message
          : 'The bound model file could not be read. The last valid configuration remains active.'
      return this.snapshot(message)
    }
  }

  private async readCandidate(path: string): Promise<AcceptedFile> {
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_PROVIDER_FILE_BYTES)
        throw new HostCapabilityError(
          'provider_config_invalid',
          'Expected a YAML file of at most 1 MiB'
        )
      const source = await handle.readFile('utf8')
      return {
        path,
        source,
        config: parseProviderFile(source).config,
        revision: hash(`${path}\0${source}`),
      }
    } finally {
      await handle.close()
    }
  }

  private async accept(candidate: AcceptedFile): Promise<void> {
    if (candidate.revision !== this.accepted?.revision || candidate.path !== this.accepted?.path) {
      await this.secrets.set(`provider-config.last-good.${hash(candidate.path)}`, candidate.source)
    }
    this.accepted = candidate
  }

  private snapshot(error?: string): ProviderFileSnapshot {
    return {
      path: this.path ?? '',
      revision: this.accepted?.revision ?? '',
      providers: (this.accepted?.config.providers ?? []).map(provider => {
        const { api_key, ...publicProvider } = provider
        return { ...publicProvider, api_key_configured: Boolean(api_key || provider.api_key_ref) }
      }),
      ...(error ? { error } : {}),
    }
  }

  private async key(provider: ProviderConnection): Promise<string> {
    if (provider.api_key_ref) {
      const key = await this.secrets.get(provider.api_key_ref)
      if (key === null)
        throw new HostCapabilityError(
          'provider_credential_missing',
          'A credential reference is not available on this device. Edit the provider API key locally.'
        )
      return key
    }
    return provider.api_key?.trim() ?? ''
  }

  private async assertCredentials(config: ProviderDocument): Promise<void> {
    for (const provider of config.providers) await this.key(provider)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

async function atomicWrite(
  path: string,
  source: string,
  beforeRename?: () => Promise<void>
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(source)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforeRename?.()
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function patchFields(
  yaml: Document,
  path: (string | number)[],
  values: Record<string, unknown>,
  fields: string[]
): void {
  for (const key of fields) {
    if (Object.hasOwn(values, key)) yaml.setIn([...path, key], values[key])
    else yaml.deleteIn([...path, key])
  }
}

function applyMutation(
  yaml: Document,
  config: ProviderDocument,
  mutation: ProviderFileMutation
): void {
  if (!mutation || typeof mutation !== 'object') throw invalid()
  if (mutation.kind === 'import-providers') {
    if (!Array.isArray(mutation.providers)) throw invalid()
    for (const provider of mutation.providers) yaml.addIn(['providers'], yaml.createNode(provider))
    return
  }
  const providerId = mutation.kind === 'save-provider' ? mutation.provider?.id : mutation.providerId
  const index = config.providers.findIndex(item => item.id === providerId)
  if (mutation.kind === 'save-provider') {
    if (!mutation.provider || typeof mutation.provider !== 'object') throw invalid()
    if (index < 0) yaml.addIn(['providers'], yaml.createNode({ ...mutation.provider, models: [] }))
    else {
      patchFields(
        yaml,
        ['providers', index],
        mutation.provider as unknown as Record<string, unknown>,
        ['name', 'base_url', 'api_format', 'request_path', 'models_path', 'enabled']
      )
      if (mutation.provider.api_key !== undefined) {
        yaml.deleteIn(['providers', index, 'api_key_ref'])
        yaml.setIn(['providers', index, 'api_key'], mutation.provider.api_key)
      }
    }
    return
  }
  if (index < 0) throw invalid()
  if (mutation.kind === 'delete-provider') {
    assertUnreferenced(config, new Set(config.providers[index].models.map(model => model.id)))
    yaml.deleteIn(['providers', index])
  } else if (mutation.kind === 'save-models') {
    if (!Array.isArray(mutation.models)) throw invalid()
    const ids = config.providers[index].models.map(model => model.id)
    for (const model of mutation.models) {
      const modelIndex = ids.indexOf(model.id)
      if (modelIndex < 0) {
        yaml.addIn(['providers', index, 'models'], yaml.createNode(model))
        ids.push(model.id)
      } else
        patchFields(
          yaml,
          ['providers', index, 'models', modelIndex],
          model as unknown as Record<string, unknown>,
          ['model_id', 'display_name', 'enabled', 'api_format', 'request_path', 'settings']
        )
    }
  } else if (mutation.kind === 'delete-model') {
    const modelIndex = config.providers[index].models.findIndex(
      model => model.id === mutation.modelId
    )
    if (modelIndex < 0) throw invalid()
    assertUnreferenced(config, new Set([mutation.modelId]))
    yaml.deleteIn(['providers', index, 'models', modelIndex])
  } else throw invalid()
}

function assertUnreferenced(config: ProviderDocument, ids: Set<string>): void {
  if (
    config.providers.some(provider =>
      provider.models.some(
        model => !ids.has(model.id) && ids.has(String(model.settings?.visionModelConfigId))
      )
    )
  ) {
    throw new HostCapabilityError(
      'provider_model_referenced',
      'Another model still uses this connection as its vision model. Remove that reference first.'
    )
  }
}
