import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import {
  defaultLocalModelRequestPath,
  defaultLocalModelToolProfile,
} from '@/features/model-settings/localModelSettings'
import { LOCAL_MODEL_PROVIDER_PROFILES } from '@/features/model-settings/localModelProviders'
import type {
  ProviderApiFormat,
  ProviderConnection,
  ProviderModelEntry,
} from '../../../shared/provider-model-config'

const FIELD =
  'min-h-11 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary sm:min-h-8'
const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 sm:min-h-8'
const FORMATS: ProviderApiFormat[] = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
]

export function ProviderConnectionEditor({
  initial,
  keyConfigured,
  existingKey,
  pending,
  onSave,
  onCancel,
}: {
  initial: ProviderConnection
  keyConfigured: boolean
  existingKey: string
  pending: boolean
  onSave: (provider: ProviderConnection, clearKey: boolean) => Promise<void>
  onCancel: (dirty: boolean) => void
}) {
  const { t } = useTranslation('providers')
  const [provider, setProvider] = useState(initial)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [bulk, setBulk] = useState('')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const discoveryController = useRef<AbortController | null>(null)
  useEffect(() => () => discoveryController.current?.abort(), [])
  const [error, setError] = useState<string | null>(null)
  const dirty =
    JSON.stringify(provider) !== JSON.stringify(initial) ||
    Boolean(apiKey) ||
    clearKey ||
    Boolean(bulk.trim())
  const patch = (value: Partial<ProviderConnection>) =>
    setProvider(current => ({ ...current, ...value }))
  const updateModel = (id: string, value: Partial<ProviderModelEntry>) =>
    setProvider(current => ({
      ...current,
      models: current.models.map(model => (model.id === id ? { ...model, ...value } : model)),
    }))
  const addModels = (ids: string[]) => {
    const known = new Set(provider.models.map(model => model.model_id))
    const added = [...new Set(ids.map(id => id.trim()).filter(Boolean))].filter(
      id => !known.has(id)
    )
    patch({
      models: [
        ...provider.models,
        ...added.map(model_id => ({ id: crypto.randomUUID(), model_id, display_name: model_id })),
      ],
    })
    setBulk('')
    setSelected(new Set())
  }
  const move = (index: number, delta: number) => {
    const models = [...provider.models]
    const target = index + delta
    if (target < 0 || target >= models.length) return
    const previous = models[index]
    models[index] = models[target]
    models[target] = previous
    patch({ models })
  }
  const discover = async () => {
    setError(null)
    setDiscovering(true)
    discoveryController.current?.abort()
    const controller = new AbortController()
    discoveryController.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    try {
      const path = provider.models_path || '/models'
      if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path))
        throw new Error(t('invalidPath'))
      const url = new URL(provider.base_url)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(t('invalidUrl'))
      const key = clearKey ? '' : apiKey || existingKey
      const response = await fetch(`${provider.base_url.replace(/\/+$/, '')}${path}`, {
        signal: controller.signal,
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
      if (!Array.isArray(body.data)) throw new Error(t('invalidList'))
      setDiscovered([
        ...new Set(
          body.data.flatMap(model =>
            model && typeof model.id === 'string' && model.id.trim() ? [model.id.trim()] : []
          )
        ),
      ])
    } catch (error) {
      setError(`${t('discoverFailed')} ${error instanceof Error ? error.message : ''}`)
    } finally {
      window.clearTimeout(timeout)
      setDiscovering(false)
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (bulk.trim()) {
      setError(t('bulkUnsaved'))
      return
    }
    const next: ProviderConnection = { ...provider }
    if (apiKey.trim()) {
      delete next.api_key_ref
      next.api_key = apiKey.trim()
    }
    try {
      await onSave(next, clearKey)
    } catch (error) {
      setError(error instanceof Error ? error.message : t('saveFailed'))
    }
  }
  return (
    <form
      data-testid="provider-editor"
      onSubmit={event => void submit(event)}
      className="mt-4 space-y-4 rounded-lg border border-border bg-background p-4"
    >
      <fieldset disabled={pending || discovering} className="grid gap-3">
        <label className="grid gap-1 text-sm">
          {t('template')}
          <select
            data-testid="provider-template"
            className={FIELD}
            defaultValue=""
            onChange={event => {
              const profile = LOCAL_MODEL_PROVIDER_PROFILES.find(
                profile => profile.id === event.target.value
              )
              if (profile)
                patch({
                  base_url: profile.baseUrl,
                  api_format: profile.apiFormat,
                  request_path: profile.requestPath,
                  models_path: profile.modelsPath ?? '/models',
                })
            }}
          >
            <option value="" disabled>
              {t('templateHint')}
            </option>
            {LOCAL_MODEL_PROVIDER_PROFILES.map(profile => (
              <option key={profile.id} value={profile.id}>
                {profile.id === 'custom' ? t('custom') : profile.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            {t('name')}
            <input
              autoFocus
              required
              data-testid="provider-name"
              className={FIELD}
              value={provider.name}
              onChange={event => patch({ name: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('protocol')}
            <select
              data-testid="provider-protocol"
              className={FIELD}
              value={provider.api_format}
              onChange={event =>
                patch({
                  api_format: event.target.value as ProviderApiFormat,
                  request_path: undefined,
                })
              }
            >
              {FORMATS.map(format => (
                <option key={format}>{format}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid gap-1 text-sm">
          Base URL
          <input
            required
            type="url"
            data-testid="provider-base-url"
            className={FIELD}
            value={provider.base_url}
            placeholder="https://gateway.example/v1"
            onChange={event => patch({ base_url: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm">
          API Key
          <input
            type="password"
            autoComplete="new-password"
            data-testid="provider-api-key"
            className={FIELD}
            disabled={clearKey}
            value={apiKey}
            placeholder={keyConfigured ? t('keyKeep') : t('keyOptional')}
            onChange={event => setApiKey(event.target.value)}
          />
        </label>
        <p className="text-xs text-text-secondary">{t('keyStorage')}</p>
        <details className="text-sm">
          <summary
            data-testid="provider-advanced-toggle"
            className="min-h-11 cursor-pointer py-2 sm:min-h-8"
          >
            {t('connectionAdvanced')}
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              {t('requestPath')}
              <input
                data-testid="provider-request-path"
                className={FIELD}
                value={provider.request_path ?? ''}
                placeholder={defaultLocalModelRequestPath(provider.api_format)}
                onChange={event => patch({ request_path: event.target.value || undefined })}
              />
            </label>
            <label className="grid gap-1">
              {t('modelsPath')}
              <input
                data-testid="provider-models-path"
                className={FIELD}
                value={provider.models_path ?? ''}
                placeholder="/models"
                onChange={event => patch({ models_path: event.target.value || undefined })}
              />
            </label>
          </div>
          <p
            data-testid="provider-request-preview"
            className="my-2 break-all font-mono text-xs text-text-secondary"
          >
            {provider.base_url.replace(/\/+$/, '')}
            {provider.request_path || defaultLocalModelRequestPath(provider.api_format)}
          </p>
          <label className="flex min-h-11 items-center gap-2 sm:min-h-8">
            <input
              data-testid="provider-enabled"
              type="checkbox"
              checked={provider.enabled !== false}
              onChange={event => patch({ enabled: event.target.checked })}
            />
            {t('enabled')}
          </label>
          {keyConfigured && (
            <label className="flex min-h-11 items-center gap-2 sm:min-h-8">
              <input
                data-testid="provider-clear-key"
                type="checkbox"
                checked={clearKey}
                onChange={event => setClearKey(event.target.checked)}
              />
              {t('clearKey')}
            </label>
          )}
        </details>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-text-primary">
            {t('modelsCount', { count: provider.models.length })}
          </h3>
          <button
            data-testid="provider-discover"
            className={BUTTON}
            type="button"
            disabled={discovering || !provider.base_url}
            onClick={() => void discover()}
          >
            {discovering ? t('loading') : t('discover')}
          </button>
        </div>
        <p className="text-xs text-text-secondary">{t('discoveryNotice')}</p>
        {discovered.length > 0 && (
          <div
            data-testid="provider-discovered-models"
            className="space-y-2 rounded-md border border-border p-3"
          >
            <input
              data-testid="provider-model-search"
              aria-label={t('search')}
              className={FIELD}
              placeholder={t('search')}
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <div className="max-h-48 overflow-auto">
              {discovered
                .filter(id => id.toLowerCase().includes(search.toLowerCase()))
                .map(id => {
                  const added = provider.models.some(model => model.model_id === id)
                  return (
                    <label key={id} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
                      <input
                        data-testid={`provider-select-model-${id}`}
                        type="checkbox"
                        disabled={added}
                        checked={added || selected.has(id)}
                        onChange={event =>
                          setSelected(current => {
                            const next = new Set(current)
                            if (event.target.checked) next.add(id)
                            else next.delete(id)
                            return next
                          })
                        }
                      />
                      <span className="break-all">{id}</span>
                      {added && (
                        <span className="text-xs text-text-secondary">{t('alreadyAdded')}</span>
                      )}
                    </label>
                  )
                })}
            </div>
            <button
              data-testid="provider-add-selected"
              className={BUTTON}
              type="button"
              disabled={!selected.size}
              onClick={() => addModels([...selected])}
            >
              {t('addSelected', { count: selected.size })}
            </button>
          </div>
        )}
        <div className="space-y-2">
          {provider.models.map((model, index) => {
            const format = model.api_format ?? provider.api_format
            const toolProfile = model.tool_profile ?? defaultLocalModelToolProfile(format)
            const catalog =
              model.catalog ??
              createDefaultLocalModelCatalogEntry({
                id: model.id,
                displayName: model.display_name || model.model_id,
                toolProfile,
                contextWindow: model.context_window,
              })
            return (
              <div
                data-testid={`provider-model-${model.id}`}
                key={model.id}
                className="rounded-md border border-border p-3"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs text-text-secondary">
                    {t('modelId')}
                    <input
                      required
                      data-testid={`provider-model-id-${index}`}
                      className={FIELD}
                      value={model.model_id}
                      onChange={event => updateModel(model.id, { model_id: event.target.value })}
                    />
                  </label>
                  <label className="grid gap-1 text-xs text-text-secondary">
                    {t('displayName')}
                    <input
                      data-testid={`provider-model-name-${index}`}
                      className={FIELD}
                      value={model.display_name ?? ''}
                      placeholder={model.model_id}
                      onChange={event =>
                        updateModel(model.id, { display_name: event.target.value || undefined })
                      }
                    />
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="mr-auto flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
                    <input
                      data-testid={`provider-model-enabled-${index}`}
                      type="checkbox"
                      checked={model.enabled !== false}
                      onChange={event => updateModel(model.id, { enabled: event.target.checked })}
                    />
                    {t('enabled')}
                  </label>
                  <button
                    data-testid={`provider-model-up-${index}`}
                    type="button"
                    className={BUTTON}
                    disabled={index === 0}
                    aria-label={t('moveUp')}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    data-testid={`provider-model-down-${index}`}
                    type="button"
                    className={BUTTON}
                    disabled={index === provider.models.length - 1}
                    aria-label={t('moveDown')}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    data-testid={`provider-model-remove-${index}`}
                    type="button"
                    className={BUTTON}
                    aria-label={t('removeModel')}
                    onClick={() =>
                      patch({ models: provider.models.filter(entry => entry.id !== model.id) })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <details className="mt-1 text-sm">
                  <summary
                    data-testid={`provider-model-advanced-${index}`}
                    className="min-h-11 cursor-pointer py-2 text-text-secondary sm:min-h-8"
                  >
                    {t('modelAdvanced')}
                  </summary>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1">
                      {t('protocol')}
                      <select
                        data-testid={`provider-model-protocol-${index}`}
                        className={FIELD}
                        value={model.api_format ?? ''}
                        onChange={event =>
                          updateModel(model.id, {
                            api_format: (event.target.value ||
                              undefined) as ProviderModelEntry['api_format'],
                          })
                        }
                      >
                        <option value="">{t('inherit')}</option>
                        {FORMATS.map(format => (
                          <option key={format}>{format}</option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1">
                      {t('requestPath')}
                      <input
                        data-testid={`provider-model-path-${index}`}
                        className={FIELD}
                        value={model.request_path ?? ''}
                        placeholder={t('inherit')}
                        onChange={event =>
                          updateModel(model.id, { request_path: event.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      {t('toolProfile')}
                      <select
                        data-testid={`provider-model-tools-${index}`}
                        className={FIELD}
                        value={model.tool_profile ?? ''}
                        onChange={event =>
                          updateModel(model.id, {
                            tool_profile: (event.target.value ||
                              undefined) as ProviderModelEntry['tool_profile'],
                          })
                        }
                      >
                        <option value="">{t('inherit')}</option>
                        {['custom', 'function', 'shell'].map(value => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1">
                      {t('compatibility')}
                      <select
                        data-testid={`provider-model-compatibility-${index}`}
                        className={FIELD}
                        value={model.codex_tool_compatibility ?? 'native'}
                        onChange={event =>
                          updateModel(model.id, {
                            codex_tool_compatibility: event.target
                              .value as ProviderModelEntry['codex_tool_compatibility'],
                          })
                        }
                      >
                        <option value="native">native</option>
                        <option value="standard">standard</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-3">
                    <CustomModelCapabilitiesForm
                      entry={catalog}
                      contextWindow={model.context_window?.toString() ?? ''}
                      onContextWindowChange={value =>
                        updateModel(model.id, {
                          context_window: value ? Number(value) : undefined,
                          catalog: {
                            ...catalog,
                            context_window: value ? Number(value) : null,
                            max_context_window: value ? Number(value) : null,
                          },
                        })
                      }
                      onChange={entry => updateModel(model.id, { catalog: entry })}
                    />
                  </div>
                </details>
              </div>
            )
          })}
        </div>
        <button
          data-testid="provider-add-model"
          className={`${BUTTON} justify-self-start`}
          type="button"
          onClick={() =>
            patch({ models: [...provider.models, { id: crypto.randomUUID(), model_id: '' }] })
          }
        >
          <Plus className="h-4 w-4" />
          {t('addModel')}
        </button>
        <label className="grid gap-1 text-sm">
          {t('bulkLabel')}
          <textarea
            data-testid="provider-bulk-input"
            className={`${FIELD} min-h-24 font-mono`}
            rows={3}
            placeholder={t('bulkHint')}
            value={bulk}
            onChange={event => setBulk(event.target.value)}
          />
        </label>
        <button
          data-testid="provider-add-bulk"
          className={`${BUTTON} justify-self-start`}
          type="button"
          disabled={!bulk.trim()}
          onClick={() => addModels(bulk.split(/[\s,;]+/))}
        >
          {t('addBulk')}
        </button>
      </fieldset>
      {error && (
        <p
          role="alert"
          data-testid="provider-editor-error"
          className="break-words text-sm text-red-500"
        >
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button
          data-testid="provider-editor-cancel"
          type="button"
          className={BUTTON}
          disabled={pending}
          onClick={() => onCancel(dirty)}
        >
          {t('cancel')}
        </button>
        <button
          data-testid="provider-editor-save"
          type="submit"
          className="min-h-11 rounded-md bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-50 sm:min-h-8"
          disabled={pending}
        >
          {pending ? t('saving') : t('save')}
        </button>
      </div>
    </form>
  )
}
