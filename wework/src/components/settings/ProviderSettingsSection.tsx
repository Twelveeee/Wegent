import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, FileCode2, FolderOpen, Trash2, Save } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  legacyProviders,
  readProviderFile,
  reloadProviderFileModels,
  saveProviderFile,
  type ProviderApiFormat,
  type ProviderConnection,
  type ProviderModel,
  type ProviderSnapshot,
} from '@/features/model-settings/providerConfig'
import {
  listLegacyLocalModelConfigs,
  removeMigratedLocalModels,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
} from '@/features/model-settings/localModelSettings'
import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'

const control =
  'h-8 rounded-md border border-border bg-background px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const action = `${control} inline-flex items-center justify-center gap-1.5 hover:bg-muted`
const protocols: ProviderApiFormat[] = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
]

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to update model configuration'
}

export function ProviderSettingsSection() {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderConnection | null>(null)
  const [dirty, setDirty] = useState(false)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [batch, setBatch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<string[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [advancedModel, setAdvancedModel] = useState<string | null>(null)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [migration, setMigration] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [legacyCount, setLegacyCount] = useState(() => listLegacyLocalModelConfigs().length)

  const resetDraft = useCallback((provider: ProviderConnection | null) => {
    setDraft(provider ? structuredClone(provider) : null)
    setSelected(provider?.id ?? null)
    setDirty(false)
    setKey('')
    setClearKey(false)
    setBatch('')
    setDiscovered([])
    setChecked([])
    setAdvancedModel(null)
  }, [])

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await reloadProviderFileModels()
      const next = await readProviderFile()
      setSnapshot(next)
      resetDraft(next.document.providers[0] ?? null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }, [resetDraft])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const refresh = () => setLegacyCount(listLegacyLocalModelConfigs().length)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
  }, [])

  const discardable = (operation: () => void) => {
    if (dirty) setPending(() => operation)
    else operation()
  }
  const patch = (change: Partial<ProviderConnection>) => {
    setDraft(current => (current ? { ...current, ...change } : null))
    setDirty(true)
    setMessage(null)
  }
  const patchModel = (id: string, change: Partial<ProviderModel>) => {
    if (draft)
      patch({
        models: draft.models.map(model => (model.id === id ? { ...model, ...change } : model)),
      })
  }
  const addModels = (ids: string[]) => {
    if (!draft) return
    const existing = new Set(draft.models.map(model => model.model_id))
    const models = ids.flatMap(raw => {
      const id = raw.trim()
      if (!id || existing.has(id)) return []
      existing.add(id)
      return [{ id: crypto.randomUUID(), model_id: id, display_name: id }]
    })
    patch({ models: [...draft.models, ...models] })
    setBatch('')
    setDiscovered([])
    setChecked([])
    setMessage(t('provider_config.added', { count: models.length }))
  }
  const save = async () => {
    if (!snapshot || !draft) return
    setBusy(true)
    setError(null)
    try {
      const exists = snapshot.document.providers.some(provider => provider.id === draft.id)
      const providers = exists
        ? snapshot.document.providers.map(provider => (provider.id === draft.id ? draft : provider))
        : [...snapshot.document.providers, draft]
      const saved = await saveProviderFile(
        snapshot,
        { version: 1, providers },
        clearKey ? { [draft.id]: null } : key.trim() ? { [draft.id]: key } : {}
      )
      setSnapshot(saved)
      resetDraft(saved.document.providers.find(provider => provider.id === draft.id) ?? null)
      setMessage(t('provider_config.saved'))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await invokeDesktopHost<ProviderSnapshot | null>('modelConfig.choose')
      if (next) {
        await reloadProviderFileModels()
        setSnapshot(next)
        resetDraft(next.document.providers[0] ?? null)
      }
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const migrate = async () => {
    if (!snapshot) return
    setMigration(false)
    setBusy(true)
    setError(null)
    try {
      const input = legacyProviders()
      const saved = await saveProviderFile(
        snapshot,
        {
          version: 1,
          providers: [...snapshot.document.providers, ...input.providers],
        },
        input.keys
      )
      removeMigratedLocalModels(
        input.providers.flatMap(provider => provider.models.map(model => model.id))
      )
      setSnapshot(saved)
      resetDraft(saved.document.providers[0] ?? null)
      setLegacyCount(listLegacyLocalModelConfigs().length)
      setMessage(t('provider_config.migrated'))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!snapshot || !draft) return
    setDeleting(false)
    setBusy(true)
    setError(null)
    try {
      const saved = await saveProviderFile(snapshot, {
        version: 1,
        providers: snapshot.document.providers.filter(provider => provider.id !== draft.id),
      })
      setSnapshot(saved)
      resetDraft(saved.document.providers[0] ?? null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const discover = async () => {
    if (!draft || dirty) return
    setBusy(true)
    setError(null)
    try {
      const models = await invokeDesktopHost<string[]>('modelConfig.discover', {
        providerId: draft.id,
      })
      const available = models.filter(id => !draft.models.some(model => model.model_id === id))
      setDiscovered(available)
      setChecked([])
      if (!available.length) setMessage(t('provider_config.no_models'))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const open = async () => {
    try {
      await invokeDesktopHost('modelConfig.open')
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const create = () => {
    resetDraft({
      id: crypto.randomUUID(),
      name: '',
      base_url: '',
      api_format: 'openai-responses',
      models: [],
    })
    setDirty(true)
  }
  const advanced = draft?.models.find(model => model.id === advancedModel)

  return (
    <section data-testid="provider-settings-section" className="grid gap-4">
      <div>
        <h3 className="text-base font-medium text-text-primary">{t('provider_config.title')}</h3>
        <p className="mt-1 text-sm text-text-secondary">{t('provider_config.description')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="provider-create"
          className={action}
          disabled={!snapshot || busy}
          onClick={() => discardable(create)}
        >
          <Plus className="h-4 w-4" />
          {t('provider_config.add_provider')}
        </button>
        <button
          type="button"
          data-testid="provider-file-choose"
          className={action}
          disabled={busy}
          onClick={() => discardable(() => void choose())}
        >
          <FolderOpen className="h-4 w-4" />
          {t('provider_config.choose')}
        </button>
        <button
          type="button"
          data-testid="provider-file-open"
          className={action}
          disabled={busy}
          onClick={() => void open()}
        >
          <FileCode2 className="h-4 w-4" />
          {t('provider_config.open')}
        </button>
        <button
          type="button"
          data-testid="provider-file-reload"
          className={action}
          disabled={busy}
          onClick={() => discardable(() => void load())}
        >
          <RefreshCw className="h-4 w-4" />
          {t('provider_config.reload')}
        </button>
        {legacyCount > 0 && (
          <button
            type="button"
            data-testid="provider-migrate"
            className={action}
            disabled={!snapshot || busy}
            onClick={() => discardable(() => setMigration(true))}
          >
            {t('provider_config.migrate', { count: legacyCount })}
          </button>
        )}
      </div>
      {snapshot && (
        <p
          data-testid="provider-file-path"
          className="break-all font-mono text-xs text-text-secondary"
        >
          {snapshot.path}
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-testid="provider-error"
          className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500"
        >
          {error}
        </p>
      )}
      {message && (
        <p role="status" data-testid="provider-status" className="text-sm text-text-secondary">
          {message}
        </p>
      )}
      <div className="grid min-w-0 gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label={t('provider_config.providers')} className="flex flex-col gap-1">
          {snapshot?.document.providers.map(provider => (
            <button
              type="button"
              key={provider.id}
              data-testid={`provider-select-${provider.id}`}
              disabled={busy}
              aria-pressed={selected === provider.id}
              className={`flex min-h-8 items-center justify-between rounded-md px-2 py-1 text-left text-sm ${selected === provider.id ? 'bg-muted text-text-primary' : 'text-text-secondary hover:bg-muted/50'}`}
              onClick={() => discardable(() => resetDraft(provider))}
            >
              <span className="truncate">{provider.name}</span>
              <span className="ml-2 text-xs">{provider.models.length}</span>
            </button>
          ))}
          {snapshot?.document.providers.length === 0 && (
            <p className="px-2 py-2 text-sm text-text-secondary">{t('provider_config.empty')}</p>
          )}
        </nav>
        {draft && (
          <div className="grid min-w-0 gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                {t('provider_config.name')}
                <input
                  data-testid="provider-name"
                  className={control}
                  value={draft.name}
                  disabled={busy}
                  onChange={event => patch({ name: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('provider_config.protocol')}
                <select
                  data-testid="provider-protocol"
                  className={control}
                  value={draft.api_format}
                  disabled={busy}
                  onChange={event =>
                    patch({
                      api_format: event.target.value as ProviderApiFormat,
                      request_path: undefined,
                    })
                  }
                >
                  {protocols.map(protocol => (
                    <option key={protocol} value={protocol}>
                      {protocol}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm sm:col-span-2">
                Base URL
                <input
                  data-testid="provider-base-url"
                  className={control}
                  value={draft.base_url}
                  disabled={busy}
                  placeholder="https://gateway.example/v1"
                  onChange={event => patch({ base_url: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm sm:col-span-2">
                API Key
                <input
                  data-testid="provider-api-key"
                  type="password"
                  autoComplete="new-password"
                  className={control}
                  value={key}
                  disabled={busy || clearKey}
                  placeholder={
                    snapshot?.configuredKeys.includes(draft.id)
                      ? t('provider_config.keep_key')
                      : t('provider_config.optional_key')
                  }
                  onChange={event => {
                    setKey(event.target.value)
                    setDirty(true)
                  }}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  data-testid="provider-enabled"
                  type="checkbox"
                  checked={draft.enabled !== false}
                  disabled={busy}
                  onChange={event => patch({ enabled: event.target.checked })}
                />
                {t('provider_config.enabled')}
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  data-testid="provider-clear-key"
                  type="checkbox"
                  checked={clearKey}
                  disabled={busy}
                  onChange={event => {
                    setClearKey(event.target.checked)
                    setDirty(true)
                  }}
                />
                {t('provider_config.clear_key')}
              </label>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-text-secondary">
                {t('provider_config.connection_advanced')}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(['request_path', 'models_path', 'models_base_url'] as const).map(field => (
                  <label key={field} className="grid gap-1">
                    {field}
                    <input
                      data-testid={`provider-${field}`}
                      className={control}
                      value={draft[field] ?? ''}
                      disabled={busy}
                      onChange={event => patch({ [field]: event.target.value || undefined })}
                    />
                  </label>
                ))}
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="mr-auto text-sm font-medium">{t('provider_config.models')}</h4>
              <button
                type="button"
                data-testid="provider-discover"
                className={action}
                disabled={
                  busy ||
                  dirty ||
                  !snapshot?.document.providers.some(provider => provider.id === draft.id)
                }
                title={t('provider_config.save_before_discovery')}
                onClick={() => void discover()}
              >
                {t('provider_config.discover')}
              </button>
              <button
                type="button"
                data-testid="provider-add-model"
                className={action}
                disabled={busy}
                onClick={() =>
                  patch({ models: [...draft.models, { id: crypto.randomUUID(), model_id: '' }] })
                }
              >
                {t('provider_config.add_model')}
              </button>
            </div>
            <div className="grid gap-2">
              {draft.models.map(model => (
                <div
                  key={model.id}
                  data-testid={`provider-model-${model.id}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
                >
                  <input
                    type="checkbox"
                    data-testid={`provider-model-enabled-${model.id}`}
                    aria-label={t('provider_config.enabled')}
                    checked={model.enabled !== false}
                    disabled={busy}
                    onChange={event => patchModel(model.id, { enabled: event.target.checked })}
                  />
                  <input
                    data-testid={`provider-model-id-${model.id}`}
                    aria-label="Model ID"
                    className={`${control} min-w-0 font-mono`}
                    placeholder="Model ID"
                    value={model.model_id}
                    disabled={busy}
                    onChange={event => patchModel(model.id, { model_id: event.target.value })}
                  />
                  <input
                    data-testid={`provider-model-name-${model.id}`}
                    aria-label={t('provider_config.display_name')}
                    className={`${control} min-w-0`}
                    placeholder={t('provider_config.display_name')}
                    value={model.display_name ?? ''}
                    disabled={busy}
                    onChange={event =>
                      patchModel(model.id, { display_name: event.target.value || undefined })
                    }
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`provider-model-advanced-${model.id}`}
                      className={action}
                      disabled={busy}
                      onClick={() => setAdvancedModel(advancedModel === model.id ? null : model.id)}
                    >
                      {t('provider_config.capabilities')}
                    </button>
                    <button
                      type="button"
                      data-testid={`provider-model-remove-${model.id}`}
                      className={action}
                      disabled={busy}
                      aria-label={t('provider_config.remove_model')}
                      onClick={() =>
                        patch({ models: draft.models.filter(item => item.id !== model.id) })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {advanced && (
              <div
                data-testid="provider-model-capabilities"
                className="grid gap-3 border-t border-border pt-3"
              >
                <label className="grid gap-1 text-sm">
                  {t('provider_config.protocol')}
                  <select
                    className={control}
                    data-testid="provider-model-protocol"
                    value={advanced.api_format ?? ''}
                    disabled={busy}
                    onChange={event =>
                      patchModel(advanced.id, {
                        api_format: (event.target.value as ProviderApiFormat) || undefined,
                      })
                    }
                  >
                    <option value="">{t('provider_config.inherit')}</option>
                    {protocols.map(protocol => (
                      <option key={protocol}>{protocol}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  {t('provider_config.tool_profile')}
                  <select
                    data-testid="provider-model-tool-profile"
                    className={control}
                    disabled={busy}
                    value={String(
                      advanced.settings?.toolProfile ??
                        ((advanced.api_format ?? draft.api_format) === 'openai-responses'
                          ? 'custom'
                          : 'function')
                    )}
                    onChange={event =>
                      patchModel(advanced.id, {
                        settings: { ...advanced.settings, toolProfile: event.target.value },
                      })
                    }
                  >
                    <option value="function">{t('provider_config.function_tools')}</option>
                    <option value="shell">{t('provider_config.shell_tools')}</option>
                    {(advanced.api_format ?? draft.api_format) === 'openai-responses' && (
                      <option value="custom">{t('provider_config.native_tools')}</option>
                    )}
                  </select>
                </label>
                <CustomModelCapabilitiesForm
                  entry={
                    (advanced.settings?.catalogEntry as Record<string, unknown>) ??
                    createDefaultLocalModelCatalogEntry({
                      id: advanced.id,
                      displayName: advanced.display_name ?? advanced.model_id,
                      toolProfile:
                        (advanced.api_format ?? draft.api_format) === 'openai-responses'
                          ? 'custom'
                          : 'function',
                      contextWindow: advanced.context_window,
                    })
                  }
                  contextWindow={String(
                    advanced.context_window ?? advanced.settings?.contextWindow ?? ''
                  )}
                  onContextWindowChange={value => {
                    const contextWindow = value ? Number(value) : undefined
                    const entry = advanced.settings?.catalogEntry as
                      | Record<string, unknown>
                      | undefined
                    patchModel(advanced.id, {
                      context_window: contextWindow,
                      settings: {
                        ...advanced.settings,
                        ...(entry
                          ? {
                              catalogEntry: {
                                ...entry,
                                context_window: contextWindow ?? null,
                                max_context_window: contextWindow ?? null,
                              },
                            }
                          : {}),
                      },
                    })
                  }}
                  onChange={entry =>
                    patchModel(advanced.id, {
                      settings: { ...advanced.settings, catalogEntry: entry },
                    })
                  }
                />
              </div>
            )}
            <label className="grid gap-1 text-sm">
              {t('provider_config.batch')}
              <textarea
                data-testid="provider-batch-input"
                rows={3}
                className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
                value={batch}
                disabled={busy}
                placeholder={t('provider_config.batch_hint')}
                onChange={event => setBatch(event.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="provider-batch-add"
              className={`${action} justify-self-start`}
              disabled={busy || !batch.trim()}
              onClick={() => addModels(batch.split(/[\n,，]+/))}
            >
              {t('provider_config.batch_add')}
            </button>
            {discovered.length > 0 && (
              <div className="grid gap-2">
                <div className="grid max-h-52 gap-1 overflow-auto">
                  {discovered.map(id => (
                    <label key={id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`provider-discovered-${id}`}
                        checked={checked.includes(id)}
                        onChange={event =>
                          setChecked(current =>
                            event.target.checked
                              ? [...current, id]
                              : current.filter(item => item !== id)
                          )
                        }
                      />
                      {id}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  data-testid="provider-discovered-add"
                  className={`${action} justify-self-start`}
                  disabled={!checked.length}
                  onClick={() => addModels(checked)}
                >
                  {t('provider_config.add_selected')}
                </button>
              </div>
            )}
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                data-testid="provider-delete"
                className={action}
                disabled={
                  busy || !snapshot?.document.providers.some(provider => provider.id === draft.id)
                }
                onClick={() => setDeleting(true)}
              >
                {t('provider_config.delete_provider')}
              </button>
              <button
                type="button"
                data-testid="provider-save"
                disabled={busy || !dirty}
                onClick={() => void save()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {t('common.save')}
              </button>
            </div>
          </div>
        )}
      </div>
      {pending && (
        <ConfirmDialog
          open
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.confirm')}
          confirmTestId="provider-confirm"
          title={t('provider_config.discard_title')}
          description={t('provider_config.discard_message')}
          onClose={() => setPending(null)}
          onConfirm={() => {
            const next = pending
            setPending(null)
            next()
          }}
        />
      )}
      {migration && (
        <ConfirmDialog
          open
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.confirm')}
          confirmTestId="provider-confirm"
          title={t('provider_config.migrate_title')}
          description={t('provider_config.migrate_message', { count: legacyCount })}
          onClose={() => setMigration(false)}
          onConfirm={() => void migrate()}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.confirm')}
          confirmTestId="provider-confirm"
          title={t('provider_config.delete_provider')}
          description={t('provider_config.delete_message')}
          onClose={() => setDeleting(false)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  )
}
