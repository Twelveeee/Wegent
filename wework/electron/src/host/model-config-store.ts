import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseDocument, isMap, isSeq, YAMLSeq, LineCounter, type Document } from 'yaml'
import { HostCapabilityError } from './capability-router.js'
import {
  defaultProviderRequestPath,
  validateProviderDocument,
  type ProviderDocument,
  type ProviderSnapshot,
} from './model-config-schema.js'

interface Secrets {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}
interface ParsedFile {
  path: string
  text: string
  revision: string
  document: ProviderDocument
}
const EMPTY_CONFIG = 'version: 1\nproviders: []\n'
const LIMIT = 1024 * 1024

/** The only writer for the bound local model file; it never accesses cloud models. */
export class ModelConfigStore {
  private operation: Promise<unknown> = Promise.resolve()
  private good: ParsedFile | null = null

  constructor(
    private readonly directory: string,
    private readonly secrets: Secrets
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async boundPath(): Promise<string> {
    try {
      const binding = JSON.parse(await readFile(join(this.directory, 'binding.json'), 'utf8'))
      if (typeof binding.path !== 'string') throw new Error('Invalid model file binding')
      return resolve(binding.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const path = join(this.directory, 'model.yml')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      try {
        await writeFile(path, EMPTY_CONFIG, { flag: 'wx', mode: 0o600 })
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      }
      return path
    }
  }

  private async parseFile(path: string): Promise<ParsedFile> {
    if ((await stat(path)).size > LIMIT) throw new Error('Model YAML exceeds the 1 MiB limit')
    const text = await readFile(path, 'utf8')
    const ast = parseModelYaml(text)
    const document = validateProviderDocument(ast.toJS({ maxAliasCount: 20 }))
    return { path, text, document, revision: digest(`${path}\0${text}`) }
  }

  private async remember(file: ParsedFile): Promise<void> {
    if (file.revision === this.good?.revision) return
    // Recovery snapshots may include inline keys: keep them encrypted, never in localStorage.
    await this.secrets.set(
      'model-provider.last-good',
      JSON.stringify({ path: file.path, text: file.text })
    )
    this.good = file
  }

  private async publicSnapshot(file: ParsedFile): Promise<ProviderSnapshot> {
    const document = structuredClone(file.document)
    const configuredKeys: string[] = []
    for (const provider of document.providers) {
      const key =
        provider.api_key ??
        (provider.api_key_ref ? await this.secrets.get(provider.api_key_ref) : null)
      if (key) configuredKeys.push(provider.id)
      delete provider.api_key
    }
    return { path: file.path, revision: file.revision, document, configuredKeys }
  }

  read(): Promise<ProviderSnapshot> {
    return this.serial(async () => {
      const file = await this.parseFile(await this.boundPath())
      await this.remember(file)
      return this.publicSnapshot(file)
    })
  }

  bind(path: string): Promise<ProviderSnapshot> {
    return this.serial(async () => {
      const file = await this.parseFile(resolve(path))
      await atomicWrite(join(this.directory, 'binding.json'), JSON.stringify({ path: file.path }))
      await this.remember(file)
      return this.publicSnapshot(file)
    })
  }

  save(input: {
    revision: string
    document: unknown
    keys?: Record<string, string | null>
  }): Promise<ProviderSnapshot> {
    return this.serial(async () => {
      const current = await this.parseFile(await this.boundPath())
      if (current.revision !== input.revision) throw conflict()
      const next = validateProviderDocument(input.document)
      const known = new Map(current.document.providers.map(provider => [provider.id, provider]))
      for (const provider of next.providers) {
        const old = known.get(provider.id)
        // A redacted editor snapshot does not mean the existing inline secret was cleared.
        if (
          provider.api_key === undefined &&
          provider.api_key_ref === undefined &&
          old?.api_key !== undefined
        ) {
          provider.api_key = old.api_key
        }
        if (input.keys && Object.hasOwn(input.keys, provider.id)) {
          const key = input.keys[provider.id]
          delete provider.api_key
          delete provider.api_key_ref
          if (typeof key === 'string' && key.trim()) {
            // Immutable references make a failed/conflicting write leave old credentials intact.
            const ref = `model-provider.key.${randomUUID()}`
            await this.secrets.set(ref, key.trim())
            provider.api_key_ref = ref
          }
        }
      }
      validateProviderDocument(next)
      const ast = parseModelYaml(current.text)
      updateDocumentAst(ast, next)
      const output = ast.toString({ lineWidth: 0 })
      if (Buffer.byteLength(output) > LIMIT) throw new Error('Model YAML exceeds the 1 MiB limit')
      validateProviderDocument(parseModelYaml(output).toJS({ maxAliasCount: 20 }))
      await atomicWrite(current.path, output, async () => {
        if ((await this.parseFile(current.path)).revision !== current.revision) throw conflict()
      })
      const saved = await this.parseFile(current.path)
      await this.remember(saved)
      return this.publicSnapshot(saved)
    })
  }

  runtime(): Promise<{
    revision: string
    models: Record<string, unknown>[]
    error: string | null
  }> {
    return this.serial(async () => {
      const path = await this.boundPath()
      let file: ParsedFile
      let error: string | null = null
      try {
        file = await this.parseFile(path)
        await this.remember(file)
      } catch (cause) {
        error = safeModelConfigError(cause)
        if (this.good?.path !== path) {
          const backup = await this.secrets.get('model-provider.last-good')
          const parsed = backup ? JSON.parse(backup) : null
          if (parsed?.path === path && typeof parsed.text === 'string') {
            this.good = {
              path,
              text: parsed.text,
              revision: digest(`${path}\0${parsed.text}`),
              document: validateProviderDocument(
                parseModelYaml(parsed.text).toJS({ maxAliasCount: 20 })
              ),
            }
          }
        }
        if (this.good?.path !== path) return { revision: '', models: [], error }
        file = this.good
      }
      const models: Record<string, unknown>[] = []
      const credentialStates: boolean[] = []
      for (const provider of file.document.providers) {
        const key =
          provider.api_key ??
          (provider.api_key_ref ? await this.secrets.get(provider.api_key_ref) : undefined)
        const missingCredential = Boolean(provider.api_key_ref && !key)
        credentialStates.push(Boolean(key))
        if (missingCredential)
          error = 'A provider credential is missing on this device; configure its API key.'
        for (const model of provider.models) {
          const apiFormat = model.api_format ?? provider.api_format
          models.push({
            ...model.settings,
            id: model.id,
            providerProfileId: model.settings?.providerProfileId ?? 'custom',
            displayName: model.display_name || model.model_id,
            group: model.settings?.group ?? provider.name,
            modelId: model.model_id,
            baseUrl: provider.base_url,
            apiFormat,
            requestPath:
              model.request_path ??
              (model.api_format && model.api_format !== provider.api_format
                ? defaultProviderRequestPath(apiFormat)
                : (provider.request_path ?? defaultProviderRequestPath(apiFormat))),
            apiKey: key || undefined,
            apiKeyConfigured: Boolean(key),
            toolProfile:
              model.settings?.toolProfile ??
              (apiFormat === 'openai-responses' ? 'custom' : 'function'),
            contextWindow: model.context_window ?? model.settings?.contextWindow,
            webSearchMode: model.settings?.webSearchMode ?? 'disabled',
            imageGenerationEnabled: model.settings?.imageGenerationEnabled ?? false,
            enabled: provider.enabled !== false && model.enabled !== false && !missingCredential,
            catalogReady: false,
            updatedAt: new Date().toISOString(),
          })
        }
      }
      return { revision: digest(`${file.revision}:${credentialStates.join()}`), models, error }
    })
  }

  async discover(providerId: string): Promise<string[]> {
    const file = await this.parseFile(await this.boundPath())
    const provider = file.document.providers.find(item => item.id === providerId)
    if (!provider) throw new Error('Provider was not found')
    const key =
      provider.api_key ??
      (provider.api_key_ref ? await this.secrets.get(provider.api_key_ref) : null)
    const base = (provider.models_base_url ?? provider.base_url).replace(/\/+$/, '')
    const path = provider.models_path ?? '/models'
    const headers: Record<string, string> = {}
    if (key) {
      if (provider.api_format === 'anthropic-messages') {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      } else headers.Authorization = `Bearer ${key}`
    }
    // No redirects carrying a user credential to an unapproved endpoint.
    const response = await fetch(`${base}${path}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok)
      throw new Error(
        `Model list request failed (HTTP ${response.status}); manual addition is still available.`
      )
    const body = await response.text()
    if (body.length > LIMIT) throw new Error('Model list is too large')
    let parsed: { data?: unknown }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error('Provider returned a non-JSON model list')
    }
    const data = parsed?.data
    if (!Array.isArray(data))
      throw new Error('Provider did not return a model list; use manual addition.')
    return [
      ...new Set(
        data.flatMap((item: unknown) => {
          const id = item && typeof item === 'object' ? (item as Record<string, unknown>).id : null
          return typeof id === 'string' && id.trim() ? [id.trim()] : []
        })
      ),
    ].sort()
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function conflict(): HostCapabilityError {
  return new HostCapabilityError(
    'model_config_conflict',
    'The file changed in another editor. Reload it before saving; your changes have not been written.'
  )
}

export function safeModelConfigError(error: unknown): string {
  if (error instanceof HostCapabilityError) return error.message
  if (error instanceof Error && !('code' in error)) return error.message
  return 'Unable to read or write the model file. Check the selected path and file permissions.'
}

function parseModelYaml(text: string): Document {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true, lineCounter })
  const issue = doc.errors[0] ?? doc.warnings[0]
  if (issue) {
    const position = issue.linePos?.[0] ?? lineCounter.linePos(issue.pos[0])
    // Do not include source snippets: parser errors may otherwise expose inline API keys.
    throw new Error(
      `Invalid YAML${position ? ` at line ${position.line}, column ${position.col}` : ''} (${issue.code})`
    )
  }
  return doc
}

async function atomicWrite(
  path: string,
  text: string,
  beforeCommit?: () => Promise<void>
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await beforeCommit?.()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Update existing nodes by stable ID, retaining comments and field ordering. */
function updateDocumentAst(doc: Document, next: ProviderDocument): void {
  const oldProviders = doc.get('providers', true)
  const nodes = isSeq(oldProviders) ? oldProviders.items : []
  const nextProviders = new YAMLSeq<unknown>(doc.schema)
  if (!isSeq(nextProviders)) throw new Error('Unable to construct provider sequence')
  for (const provider of next.providers) {
    const node = nodes.find(item => isMap(item) && item.get('id') === provider.id)
    const result = isMap(node) ? node : doc.createNode(provider)
    if (!isMap(result)) throw new Error('Unable to construct provider node')
    const oldModels = result.get('models', true)
    const modelNodes = isSeq(oldModels) ? oldModels.items : []
    const models = new YAMLSeq<unknown>(doc.schema)
    if (!isSeq(models)) throw new Error('Unable to construct model sequence')
    for (const model of provider.models) {
      const existing = modelNodes.find(item => isMap(item) && item.get('id') === model.id)
      const modelNode = isMap(existing) ? existing : doc.createNode(model)
      if (!isMap(modelNode)) throw new Error('Unable to construct model node')
      for (const pair of [...modelNode.items]) {
        const key = String(pair.key)
        if (!(key in model)) modelNode.delete(key)
      }
      for (const [key, value] of Object.entries(model)) {
        if (
          JSON.stringify((modelNode.toJSON() as Record<string, unknown>)[key]) !==
          JSON.stringify(value)
        )
          modelNode.set(key, doc.createNode(value))
      }
      models.items.push(modelNode)
    }
    for (const pair of [...result.items]) {
      const key = String(pair.key)
      if (!(key in provider)) result.delete(key)
    }
    for (const [key, value] of Object.entries(provider)) {
      if (key === 'models') continue
      if (result.get(key) !== value) result.set(key, doc.createNode(value))
    }
    result.set('models', models)
    nextProviders.items.push(result)
  }
  doc.set('version', 1)
  doc.set('providers', nextProviders)
}
