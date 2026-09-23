import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { isMap, isScalar, isSeq, type Document } from 'yaml'
import type {
  ProviderConfigMutation,
  ProviderConfigSnapshot,
  ProviderDocument,
} from '../../../shared/provider-model-config.js'
import {
  MAX_PROVIDER_CONFIG_BYTES,
  parseProviderYaml,
  validateProviderDocument,
} from './provider-config-schema.js'

interface CredentialStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
const EMPTY = 'version: 1\nproviders: []\n'
const digest = (source: string) => createHash('sha256').update(source).digest('hex')

/** One serialized owner for the bound file. Cloud configuration never enters this store. */
export class ProviderConfigStore {
  private operation: Promise<unknown> = Promise.resolve()
  private location: string | null = null
  private lastGood: ProviderConfigSnapshot | null = null
  constructor(
    private readonly directory: string,
    private readonly credentials: CredentialStore
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private async filePath(): Promise<string> {
    if (this.location) return this.location
    try {
      const binding: unknown = JSON.parse(
        await readFile(join(this.directory, 'binding.json'), 'utf8')
      )
      if (
        !binding ||
        typeof binding !== 'object' ||
        typeof (binding as { path?: unknown }).path !== 'string'
      )
        throw new Error('Invalid model configuration binding')
      this.location = resolve((binding as { path: string }).path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.location = join(this.directory, 'model.yml')
    }
    return this.location
  }
  private backupPath(path: string): string {
    return join(this.directory, 'last-good', `${digest(path)}.yml`)
  }
  private async source(path: string): Promise<string | null> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Model configuration must be a regular file, not a symbolic link')
      if (info.size > MAX_PROVIDER_CONFIG_BYTES)
        throw new Error('Model configuration exceeds 2 MiB')
      return await readFile(path, 'utf8')
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        path === join(this.directory, 'model.yml') &&
        (!this.lastGood || this.lastGood.revision === 'missing')
      )
        return null
      throw error
    }
  }
  private async snapshot(path: string, source: string | null): Promise<ProviderConfigSnapshot> {
    const { data } = parseProviderYaml(source ?? EMPTY)
    const document: ProviderDocument = structuredClone(data)
    const credentials: Record<string, string> = Object.create(null)
    const warnings: string[] = []
    for (const provider of document.providers) {
      if (provider.api_key_ref) {
        const key = await this.credentials.get(provider.api_key_ref)
        if (key !== null) credentials[provider.id] = key
        else
          warnings.push(
            `Saved API key is unavailable for connection ${provider.id}; enter a replacement key.`
          )
      } else if (provider.api_key !== undefined) credentials[provider.id] = provider.api_key
      delete provider.api_key
    }
    return {
      path,
      revision: source === null ? 'missing' : digest(source),
      loadedAt: new Date().toISOString(),
      document,
      credentials,
      ...(warnings.length ? { warnings } : {}),
    }
  }
  private async remember(
    snapshot: ProviderConfigSnapshot,
    source: string | null
  ): Promise<ProviderConfigSnapshot> {
    this.lastGood = snapshot
    if (source !== null) {
      try {
        await atomicWrite(this.backupPath(snapshot.path), source)
      } catch {
        snapshot.warnings = [
          ...(snapshot.warnings ?? []),
          'Configuration loaded, but its recovery copy could not be saved.',
        ]
      }
    }
    return snapshot
  }
  read(): Promise<ProviderConfigSnapshot> {
    return this.serial(async () => {
      const path = await this.filePath()
      try {
        const source = await this.source(path)
        // An externally deleted previously valid file must not become an empty catalog.
        if (source === null) {
          try {
            await lstat(this.backupPath(path))
            throw new Error('Configured model file is missing; restore it or select another file')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        return await this.remember(await this.snapshot(path, source), source)
      } catch (error) {
        let fallback = this.lastGood?.path === path ? this.lastGood : null
        if (!fallback) {
          try {
            fallback = await this.snapshot(path, await readFile(this.backupPath(path), 'utf8'))
          } catch {
            /* There may not be a previously valid snapshot on first use. */
          }
        }
        const message = configError(error)
        return { ...(fallback ?? (await this.snapshot(path, null))), error: message }
      }
    })
  }
  bind(path: string): Promise<ProviderConfigSnapshot> {
    return this.serial(async () => {
      const selected = resolve(path)
      if (!['.yml', '.yaml'].includes(extname(selected).toLowerCase()))
        throw new Error('Select a .yml or .yaml model configuration')
      const source = await this.source(selected)
      if (source === null) throw new Error('Selected model file does not exist')
      const snapshot = await this.snapshot(selected, source)
      await atomicWrite(join(this.directory, 'binding.json'), JSON.stringify({ path: selected }))
      this.location = selected
      return this.remember(snapshot, source)
    })
  }
  openPath(): Promise<string> {
    return this.serial(async () => {
      const path = await this.filePath()
      if ((await this.source(path)) === null) await atomicWrite(path, EMPTY)
      return path
    })
  }
  update(
    mutation: ProviderConfigMutation,
    expectedRevision: string
  ): Promise<ProviderConfigSnapshot> {
    return this.serial(async () => {
      const path = await this.filePath()
      const source = await this.source(path)
      if ((source === null ? 'missing' : digest(source)) !== expectedRevision)
        throw new Error(
          'CONFIG_CONFLICT: the file changed. Reload before saving; no changes were overwritten.'
        )
      const { document, data } = parseProviderYaml(source ?? EMPTY)
      const next = structuredClone(data)
      const createdSecrets: string[] = []
      try {
        await this.applyMutation(next, mutation, createdSecrets)
        validateProviderDocument(next)
        document.set(
          'providers',
          reconcileYaml(document.get('providers', true), next.providers, document)
        )
        const content = document.toString({ lineWidth: 0 })
        parseProviderYaml(content)
        const snapshot = await this.snapshot(path, content)
        // Check again after credential processing, immediately before the atomic replace.
        const current = await this.source(path)
        if ((current === null ? 'missing' : digest(current)) !== expectedRevision)
          throw new Error('CONFIG_CONFLICT: the file changed while saving. Reload before saving.')
        await atomicWrite(path, content)
        // Everything that can invalidate the transaction ran before the file commit.
        return await this.remember(snapshot, content)
      } catch (error) {
        for (const key of createdSecrets) await this.credentials.delete(key)
        throw error
      }
    })
  }
  private async applyMutation(
    document: ProviderDocument,
    mutation: ProviderConfigMutation,
    createdSecrets: string[]
  ): Promise<void> {
    if (!mutation || typeof mutation !== 'object')
      throw new Error('Invalid model configuration operation')
    if (mutation.kind === 'delete') {
      if (!document.providers.some(provider => provider.id === mutation.providerId))
        throw new Error('Connection no longer exists; reload before saving')
      document.providers = document.providers.filter(
        provider => provider.id !== mutation.providerId
      )
      return
    }
    if (mutation.kind !== 'upsert' && mutation.kind !== 'import')
      throw new Error('Unsupported model configuration operation')
    const incoming = mutation.kind === 'upsert' ? [mutation.provider] : mutation.providers
    if (!Array.isArray(incoming)) throw new Error('providers: expected an array')
    for (const input of incoming) {
      validateProviderDocument({ version: 1, providers: [input] })
      const index = document.providers.findIndex(provider => provider.id === input.id)
      if (mutation.kind === 'import' && index >= 0)
        throw new Error('Imported connection identity already exists')
      const previous = document.providers[index]
      const provider = JSON.parse(JSON.stringify(input)) as typeof input
      // UI snapshots intentionally omit inline keys. Omission means keep, not erase.
      if (provider.api_key === undefined && provider.api_key_ref === undefined) {
        if (previous?.api_key !== undefined) provider.api_key = previous.api_key
        if (previous?.api_key_ref !== undefined) provider.api_key_ref = previous.api_key_ref
      }
      if (input.api_key !== undefined) {
        const reference = `wework-model-${randomUUID()}`
        createdSecrets.push(reference)
        await this.credentials.set(reference, input.api_key)
        delete provider.api_key
        provider.api_key_ref = reference
      }
      if (mutation.kind === 'upsert' && mutation.clearKey) {
        delete provider.api_key
        delete provider.api_key_ref
      }
      if (index >= 0) document.providers[index] = provider
      else document.providers.push(provider)
    }
  }
}

function reconcileYaml(node: unknown, value: unknown, document: Document): unknown {
  if (isMap(node) && value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    for (const pair of [...node.items]) {
      const key = String(pair.key)
      if (!Object.hasOwn(object, key)) node.delete(key)
    }
    for (const [key, next] of Object.entries(object))
      node.set(key, reconcileYaml(node.get(key, true), next, document))
    return node
  }
  if (isSeq(node) && Array.isArray(value)) {
    const previous = [...node.items]
    node.items = value.map((entry, index) => {
      const matching =
        entry && typeof entry === 'object' && 'id' in entry
          ? previous.find(item => isMap(item) && item.get('id') === entry.id)
          : previous[index]
      return reconcileYaml(matching, entry, document)
    })
    return node
  }
  // Keep scalar comments and formatting even when a UI edit changes the value.
  if (
    isScalar(node) &&
    (value === null || ['string', 'number', 'boolean'].includes(typeof value))
  ) {
    node.value = value
    return node
  }
  return document.createNode(value)
}
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
function configError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT')
    return 'Configured model file is missing; the last valid configuration is still active.'
  if (code === 'EACCES' || code === 'EPERM')
    return 'Model configuration cannot be read: permission denied.'
  return error instanceof Error ? error.message : 'Failed to read model configuration'
}
