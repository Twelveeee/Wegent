import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  bindProviderConfig,
  discoverConnectionModels,
  effectiveRequestPath,
  migrateLegacyProviderConfig,
  mutateProviderConfig,
  openProviderFile,
  providerConfigSnapshot,
  reloadProviderConfig,
  subscribeProviderConfig,
  type ProviderConnection,
  type ProviderFileModel,
  type ProviderFileMutation,
  type PublicProviderConnection,
} from '@/features/model-settings/providerConfig'
import {
  listLegacyLocalModelConfigs,
  defaultLocalModelToolProfile,
  type LocalModelApiFormat,
  type LocalModelToolProfile,
} from '@/features/model-settings/localModelSettings'
import {
  createDefaultLocalModelCatalogEntry,
  normalizeLocalModelCatalogEntry,
} from '@/features/model-settings/localModelCatalog'
import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'

const BUTTON =
  'min-h-11 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 md:min-h-8'
const PRIMARY =
  'min-h-11 rounded-md bg-text-primary px-3 text-sm text-background hover:opacity-90 disabled:opacity-50 md:min-h-8'
const INPUT =
  'min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary md:min-h-9'
const FORMATS: LocalModelApiFormat[] = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
]

interface EditorState {
  revision: string
  provider?: PublicProviderConnection
  model?: ProviderFileModel
  kind: 'provider' | 'models' | 'model'
}

export function ProviderSettingsSection() {
  const { t } = useTranslation('providers')
  const state = useSyncExternalStore(subscribeProviderConfig, providerConfigSnapshot)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    title: string
    body: string
    action: () => Promise<void>
  } | null>(null)
  const snapshot = state.snapshot
  const revision = snapshot?.revision ?? ''
  const editable = Boolean(revision) && !state.error && !busy
  const legacyCount = listLegacyLocalModelConfigs().length

  const run = async (action: () => Promise<unknown>, closeEditor = false) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (closeEditor) setEditor(null)
      setConfirmation(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }
  const cancelEditor = () =>
    setConfirmation({
      title: t('discard_title'),
      body: t('discard_description'),
      action: async () => {
        setEditor(null)
      },
    })
  const save = (mutation: ProviderFileMutation) =>
    run(() => mutateProviderConfig(mutation, editor?.revision ?? revision), true)
  const confirmDelete = (mutation: ProviderFileMutation, name: string) =>
    setConfirmation({
      title: t('delete_title'),
      body: t('delete_description', { name }),
      action: () => mutateProviderConfig(mutation, revision),
    })

  return (
    <section className="grid gap-3" data-testid="provider-settings-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="heading-small text-text-primary">{t('title')}</h3>
          <p className="mt-1 text-sm text-text-secondary">{t('description')}</p>
        </div>
        <button
          className={PRIMARY}
          data-testid="provider-add"
          disabled={!editable || Boolean(editor)}
          onClick={() => setEditor({ kind: 'provider', revision })}
        >
          {t('add_provider')}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={BUTTON}
          data-testid="provider-bind-file"
          disabled={busy || Boolean(editor)}
          onClick={() =>
            setConfirmation({
              title: t('bind_title'),
              body: t('bind_description'),
              action: bindProviderConfig,
            })
          }
        >
          {t('bind_file')}
        </button>
        <button
          className={BUTTON}
          data-testid="provider-open-file"
          disabled={busy || !snapshot}
          onClick={() => void run(openProviderFile)}
        >
          {t('open_file')}
        </button>
        <button
          className={BUTTON}
          data-testid="provider-reload-file"
          disabled={busy}
          onClick={() => void run(reloadProviderConfig)}
        >
          {busy ? t('working') : t('reload')}
        </button>
        {legacyCount > 0 && (
          <button
            className={BUTTON}
            data-testid="provider-migrate-legacy"
            disabled={!editable || Boolean(editor)}
            onClick={() =>
              setConfirmation({
                title: t('migrate_title'),
                body: t('migrate_description', { count: legacyCount }),
                action: () => migrateLegacyProviderConfig(revision),
              })
            }
          >
            {t('migrate', { count: legacyCount })}
          </button>
        )}
      </div>
      {snapshot && (
        <p className="break-all text-xs text-text-muted" data-testid="provider-file-path">
          {snapshot.path}
        </p>
      )}
      <p className="text-xs text-text-muted">{t('file_hint')}</p>
      {(error || state.error) && (
        <div
          role="alert"
          data-testid="provider-error"
          className="rounded-md border border-red-500/20 p-3 text-sm text-red-500"
        >
          {error || state.error}
        </div>
      )}
      {editor && (
        <fieldset disabled={busy} className="rounded-lg border border-border bg-background p-4">
          {editor.kind === 'provider' && (
            <ProviderEditor
              key={editor.provider?.id ?? 'new'}
              initial={editor.provider}
              busy={busy}
              onCancel={cancelEditor}
              onSave={provider => save({ kind: 'save-provider', provider })}
            />
          )}
          {editor.kind === 'models' && editor.provider && (
            <ProviderModelsEditor
              provider={editor.provider}
              revision={editor.revision}
              busy={busy}
              onCancel={cancelEditor}
              onSave={models =>
                save({ kind: 'save-models', providerId: editor.provider!.id, models })
              }
            />
          )}
          {editor.kind === 'model' && editor.provider && editor.model && (
            <ProviderModelEditor
              provider={editor.provider}
              initial={editor.model}
              busy={busy}
              onCancel={cancelEditor}
              onSave={model =>
                save({ kind: 'save-models', providerId: editor.provider!.id, models: [model] })
              }
            />
          )}
        </fieldset>
      )}
      {!state.loaded && <p className="text-sm text-text-muted">{t('loading')}</p>}
      {state.loaded && !snapshot?.providers.length && (
        <div className="py-4 text-sm text-text-secondary">{t('empty')}</div>
      )}
      <div className="divide-y divide-border">
        {snapshot?.providers.map(provider => (
          <div key={provider.id} data-testid={`provider-row-${provider.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <button
                className="min-h-11 min-w-0 flex-1 text-left md:min-h-8"
                data-testid={`provider-expand-${provider.id}`}
                aria-expanded={expanded === provider.id}
                onClick={() => setExpanded(expanded === provider.id ? null : provider.id)}
              >
                <span className="text-sm font-medium text-text-primary">
                  {expanded === provider.id ? '▾ ' : '▸ '}
                  {provider.name}
                </span>
                <span className="ml-2 text-xs text-text-muted">
                  {t('model_count', { count: provider.models.length })}
                  {provider.enabled === false ? ` · ${t('disabled')}` : ''}
                </span>
                <span className="mt-1 block break-all text-xs text-text-secondary">
                  {provider.base_url} · {provider.api_format}
                </span>
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  className={BUTTON}
                  data-testid={`provider-edit-${provider.id}`}
                  disabled={!editable || Boolean(editor)}
                  onClick={() => setEditor({ kind: 'provider', provider, revision })}
                >
                  {t('edit_connection')}
                </button>
                <button
                  className={BUTTON}
                  data-testid={`provider-add-models-${provider.id}`}
                  disabled={!editable || Boolean(editor)}
                  onClick={() => {
                    setExpanded(provider.id)
                    setEditor({ kind: 'models', provider, revision })
                  }}
                >
                  {t('add_models')}
                </button>
                <button
                  className={BUTTON}
                  data-testid={`provider-delete-${provider.id}`}
                  disabled={!editable || Boolean(editor)}
                  onClick={() =>
                    confirmDelete(
                      { kind: 'delete-provider', providerId: provider.id },
                      provider.name
                    )
                  }
                >
                  {t('delete')}
                </button>
              </div>
            </div>
            {expanded === provider.id && (
              <div className="mb-3 divide-y divide-border pl-4">
                {provider.models.map(model => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 py-2"
                    key={model.id}
                    data-testid={`provider-model-${model.id}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary">
                        {model.display_name || model.model_id}
                      </p>
                      <p className="break-all font-mono text-xs text-text-muted">
                        {model.model_id}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                        <input
                          type="checkbox"
                          data-testid={`provider-model-enabled-${model.id}`}
                          checked={model.enabled !== false}
                          disabled={!editable || Boolean(editor)}
                          onChange={event =>
                            void run(() =>
                              mutateProviderConfig(
                                {
                                  kind: 'save-models',
                                  providerId: provider.id,
                                  models: [{ ...model, enabled: event.target.checked }],
                                },
                                revision
                              )
                            )
                          }
                        />
                        {t('enabled')}
                      </label>
                      <button
                        className={BUTTON}
                        data-testid={`provider-model-edit-${model.id}`}
                        disabled={!editable || Boolean(editor)}
                        onClick={() => setEditor({ kind: 'model', provider, model, revision })}
                      >
                        {t('edit')}
                      </button>
                      <button
                        className={BUTTON}
                        data-testid={`provider-model-delete-${model.id}`}
                        disabled={!editable || Boolean(editor)}
                        onClick={() =>
                          confirmDelete(
                            { kind: 'delete-model', providerId: provider.id, modelId: model.id },
                            model.display_name || model.model_id
                          )
                        }
                      >
                        {t('delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.title ?? ''}
        description={confirmation?.body ?? ''}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        confirmTestId="provider-confirm"
        pending={busy}
        onClose={() => setConfirmation(null)}
        onConfirm={() => confirmation && void run(confirmation.action)}
      />
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm text-text-secondary">
      {label}
      {children}
    </label>
  )
}

function EditorActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  const { t } = useTranslation('providers')
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        className={BUTTON}
        data-testid="provider-editor-cancel"
        disabled={busy}
        onClick={onCancel}
      >
        {t('cancel')}
      </button>
      <button type="submit" className={PRIMARY} data-testid="provider-editor-save" disabled={busy}>
        {busy ? t('working') : t('save')}
      </button>
    </div>
  )
}

function ProviderEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial?: PublicProviderConnection
  busy: boolean
  onCancel: () => void
  onSave: (provider: Omit<ProviderConnection, 'models'>) => Promise<void>
}) {
  const { t } = useTranslation('providers')
  const [form, setForm] = useState(() => ({
    id: initial?.id ?? `provider-${crypto.randomUUID()}`,
    name: initial?.name ?? '',
    base_url: initial?.base_url ?? '',
    api_format: initial?.api_format ?? ('openai-responses' as LocalModelApiFormat),
    request_path: initial?.request_path ?? '',
    models_path: initial?.models_path ?? '/models',
    enabled: initial?.enabled !== false,
  }))
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const { request_path, models_path, ...connection } = form
    void onSave({
      ...connection,
      name: form.name.trim(),
      base_url: form.base_url.trim().replace(/\/+$/, ''),
      ...(request_path ? { request_path } : {}),
      ...(models_path ? { models_path } : {}),
      ...(key.trim() || clearKey ? { api_key: clearKey ? '' : key.trim() } : {}),
    })
  }
  return (
    <form className="grid gap-3" onSubmit={submit} data-testid="provider-editor">
      <h4 className="text-sm font-medium">{initial ? t('edit_connection') : t('add_provider')}</h4>
      <Field label={t('name')}>
        <input
          className={INPUT}
          data-testid="provider-name"
          required
          value={form.name}
          onChange={event => setForm({ ...form, name: event.target.value })}
        />
      </Field>
      <Field label="Base URL">
        <input
          className={INPUT}
          data-testid="provider-base-url"
          type="url"
          required
          placeholder="https://gateway.example/v1"
          value={form.base_url}
          onChange={event => setForm({ ...form, base_url: event.target.value })}
        />
      </Field>
      <Field label={t('api_key')}>
        <input
          className={INPUT}
          data-testid="provider-api-key"
          type="password"
          autoComplete="new-password"
          value={key}
          disabled={clearKey}
          placeholder={initial?.api_key_configured ? t('key_keep') : t('key_optional')}
          onChange={event => setKey(event.target.value)}
        />
      </Field>
      {initial?.api_key_configured && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="provider-clear-key"
            checked={clearKey}
            onChange={event => setClearKey(event.target.checked)}
          />
          {t('clear_key')}
        </label>
      )}
      <p className="text-xs text-text-muted">{t('key_hint')}</p>
      <Field label={t('protocol')}>
        <select
          className={INPUT}
          data-testid="provider-protocol"
          value={form.api_format}
          onChange={event =>
            setForm({
              ...form,
              api_format: event.target.value as LocalModelApiFormat,
              request_path: '',
            })
          }
        >
          {FORMATS.map(format => (
            <option key={format}>{format}</option>
          ))}
        </select>
      </Field>
      <details>
        <summary className="min-h-8 cursor-pointer text-sm text-text-secondary">
          {t('advanced')}
        </summary>
        <div className="mt-2 grid gap-3">
          <Field label={t('request_path')}>
            <input
              className={INPUT}
              data-testid="provider-request-path"
              placeholder={
                form.api_format === 'anthropic-messages'
                  ? '/messages'
                  : form.api_format === 'openai-chat-completions'
                    ? '/chat/completions'
                    : '/responses'
              }
              value={form.request_path}
              onChange={event => setForm({ ...form, request_path: event.target.value })}
            />
          </Field>
          <Field label={t('models_path')}>
            <input
              className={INPUT}
              data-testid="provider-models-path"
              value={form.models_path}
              onChange={event => setForm({ ...form, models_path: event.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="provider-enabled"
              checked={form.enabled}
              onChange={event => setForm({ ...form, enabled: event.target.checked })}
            />
            {t('enabled')}
          </label>
        </div>
      </details>
      <EditorActions busy={busy} onCancel={onCancel} />
    </form>
  )
}

function ProviderModelsEditor({
  provider,
  revision,
  busy,
  onCancel,
  onSave,
}: {
  provider: PublicProviderConnection
  revision: string
  busy: boolean
  onCancel: () => void
  onSave: (models: ProviderFileModel[]) => Promise<void>
}) {
  const { t } = useTranslation('providers')
  const [text, setText] = useState('')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const configured = new Set(provider.models.map(model => model.model_id))
  const discover = async () => {
    setLoading(true)
    setError(null)
    try {
      setDiscovered(await discoverConnectionModels(provider.id, revision))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    } finally {
      setLoading(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const ids = [
      ...new Set([
        ...selected,
        ...text
          .split(/[\n,，]+/)
          .map(id => id.trim())
          .filter(Boolean),
      ]),
    ].filter(id => !configured.has(id))
    if (!ids.length) {
      setError(t('no_new_models'))
      return
    }
    void onSave(
      ids.map(id => ({
        id: `model-${crypto.randomUUID()}`,
        model_id: id,
        display_name: id,
        enabled: true,
      }))
    )
  }
  const filtered = discovered.filter(id => id.toLowerCase().includes(search.toLowerCase()))
  return (
    <form className="grid gap-3" data-testid="provider-models-editor" onSubmit={submit}>
      <h4 className="text-sm font-medium">{t('models_for', { name: provider.name })}</h4>
      <p className="text-xs text-text-muted">{t('inherits_connection')}</p>
      <div>
        <button
          type="button"
          className={BUTTON}
          data-testid="provider-discover"
          disabled={busy || loading}
          onClick={() => void discover()}
        >
          {loading ? t('working') : t('discover')}
        </button>
      </div>
      {discovered.length > 0 && (
        <>
          <input
            className={INPUT}
            aria-label={t('search')}
            data-testid="provider-model-search"
            placeholder={t('search')}
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <button
            type="button"
            className={BUTTON}
            data-testid="provider-model-select-visible"
            onClick={() =>
              setSelected([
                ...new Set([...selected, ...filtered.filter(id => !configured.has(id))]),
              ])
            }
          >
            {t('select_visible')}
          </button>
          <div className="max-h-56 overflow-y-auto rounded-md border border-border p-2">
            {filtered.map(id => (
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8" key={id}>
                <input
                  type="checkbox"
                  data-testid={`provider-discovered-${id}`}
                  checked={selected.includes(id) || configured.has(id)}
                  disabled={configured.has(id)}
                  onChange={event =>
                    setSelected(
                      event.target.checked
                        ? [...selected, id]
                        : selected.filter(value => value !== id)
                    )
                  }
                />
                <span className="break-all">{id}</span>
                {configured.has(id) && (
                  <span className="text-xs text-text-muted">{t('already_added')}</span>
                )}
              </label>
            ))}
          </div>
        </>
      )}
      <Field label={t('paste_models')}>
        <textarea
          className={`${INPUT} min-h-28 py-2 font-mono`}
          data-testid="provider-model-ids"
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder={t('paste_hint')}
        />
      </Field>
      <p className="text-xs text-text-muted">{t('discovery_hint')}</p>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <EditorActions busy={busy || loading} onCancel={onCancel} />
    </form>
  )
}

function ProviderModelEditor({
  provider,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  provider: PublicProviderConnection
  initial: ProviderFileModel
  busy: boolean
  onCancel: () => void
  onSave: (model: ProviderFileModel) => Promise<void>
}) {
  const { t } = useTranslation('providers')
  const [model, setModel] = useState(initial)
  const [settings, setSettings] = useState(initial.settings ?? {})
  const format = model.api_format ?? provider.api_format
  const toolProfile =
    (settings.toolProfile as LocalModelToolProfile) ?? defaultLocalModelToolProfile(format)
  const [contextWindow, setContextWindow] = useState(String(settings.contextWindow ?? ''))
  const [entry, setEntry] = useState(
    () =>
      (initial.settings?.catalogEntry as Record<string, unknown>) ??
      createDefaultLocalModelCatalogEntry({
        id: initial.id,
        displayName: initial.display_name || initial.model_id,
        toolProfile,
        contextWindow: initial.settings?.contextWindow as number | undefined,
      })
  )
  const changeFormat = (apiFormat: string) => {
    setModel({
      ...model,
      api_format: apiFormat ? (apiFormat as LocalModelApiFormat) : undefined,
      request_path: undefined,
    })
    setSettings({
      ...settings,
      toolProfile: defaultLocalModelToolProfile(
        (apiFormat || provider.api_format) as LocalModelApiFormat
      ),
    })
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextSettings = {
      ...settings,
      ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
      catalogEntry: normalizeLocalModelCatalogEntry(entry, {
        id: model.id,
        displayName: model.display_name || model.model_id,
        toolProfile,
        contextWindow: contextWindow ? Number(contextWindow) : undefined,
      }),
    }
    if (!contextWindow) delete nextSettings.contextWindow
    void onSave({ ...model, model_id: model.model_id.trim(), settings: nextSettings })
  }
  return (
    <form className="grid gap-3" data-testid="provider-model-editor" onSubmit={submit}>
      <p className="text-xs text-text-muted">
        {t('model_identity', { id: model.id, name: provider.name })}
      </p>
      <Field label={t('model_id')}>
        <input
          className={INPUT}
          required
          data-testid="provider-edit-model-id"
          value={model.model_id}
          onChange={event => setModel({ ...model, model_id: event.target.value })}
        />
      </Field>
      <Field label={t('display_name')}>
        <input
          className={INPUT}
          data-testid="provider-edit-model-name"
          value={model.display_name ?? ''}
          onChange={event => setModel({ ...model, display_name: event.target.value })}
        />
      </Field>
      <Field label={t('protocol')}>
        <select
          className={INPUT}
          data-testid="provider-model-protocol"
          value={model.api_format ?? ''}
          onChange={event => changeFormat(event.target.value)}
        >
          <option value="">
            {t('inherit')} ({provider.api_format})
          </option>
          {FORMATS.map(value => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </Field>
      <Field label={t('request_path')}>
        <input
          className={INPUT}
          data-testid="provider-model-request-path"
          placeholder={t('inherit')}
          value={model.request_path ?? ''}
          onChange={event => setModel({ ...model, request_path: event.target.value || undefined })}
        />
      </Field>
      <p
        className="break-all font-mono text-xs text-text-muted"
        data-testid="provider-effective-url"
      >
        {provider.base_url.replace(/\/+$/, '')}
        {effectiveRequestPath(provider, model)}
      </p>
      <details>
        <summary className="min-h-8 cursor-pointer text-sm text-text-secondary">
          {t('capabilities')}
        </summary>
        <div className="mt-3 grid gap-3">
          <Field label={t('tool_profile')}>
            <select
              className={INPUT}
              data-testid="provider-model-tool-profile"
              value={toolProfile}
              onChange={event => setSettings({ ...settings, toolProfile: event.target.value })}
            >
              {['custom', 'function', 'shell']
                .filter(value => value !== 'custom' || format === 'openai-responses')
                .map(value => (
                  <option key={value}>{value}</option>
                ))}
            </select>
          </Field>
          <CustomModelCapabilitiesForm
            entry={entry}
            contextWindow={contextWindow}
            apiFormat={format}
            codexToolCompatibility={
              settings.codexToolCompatibility === 'standard' ? 'standard' : 'native'
            }
            onContextWindowChange={value => {
              setContextWindow(value)
              setEntry({
                ...entry,
                context_window: value ? Number(value) : null,
                max_context_window: value ? Number(value) : null,
              })
            }}
            onCodexToolCompatibilityChange={value =>
              setSettings({ ...settings, codexToolCompatibility: value })
            }
            onChange={setEntry}
          />
        </div>
      </details>
      <EditorActions busy={busy} onCancel={onCancel} />
    </form>
  )
}
