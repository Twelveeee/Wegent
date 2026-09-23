import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { ChevronDown, FileCode2, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  chooseProviderConfiguration,
  getProviderConfigurationState,
  initializeProviderModelConfiguration,
  migrateLegacyProviderModels,
  reloadProviderConfiguration,
  saveProviderConfiguration,
  subscribeProviderConfiguration,
  type ModelConfigurationSnapshot,
  type ModelProvider,
  type ProviderModel,
  type PublicModelProvider,
} from '@/features/model-settings/providerModelConfiguration'
import { listLegacyLocalModelConfigs, LOCAL_MODEL_SETTINGS_CHANGED_EVENT, defaultLocalModelToolProfile } from '@/features/model-settings/localModelSettings'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'

const BUTTON = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8'
const INPUT = 'min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 md:min-h-8'
const PRIMARY = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-45 md:min-h-8'
const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const

type ProviderDraft = ModelProvider & { api_key_configured?: boolean }

export function ProviderSettingsSection() {
  const { t } = useTranslation('modelConnections')
  const { snapshot, error: loadError } = useSyncExternalStore(subscribeProviderConfiguration, getProviderConfigurationState)
  const [editor, setEditor] = useState<{ provider: ProviderDraft; snapshot: ModelConfigurationSnapshot } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; run: () => Promise<void> } | null>(null)
  const [legacyCount, setLegacyCount] = useState(() => listLegacyLocalModelConfigs().length)
  const available = isElectronRuntime()

  useEffect(() => {
    if (available) void initializeProviderModelConfiguration()
    const refresh = () => setLegacyCount(listLegacyLocalModelConfigs().length)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
  }, [available])

  if (!available) return null

  async function perform(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : t('failed')) }
    finally { setPending(false) }
  }

  const addProvider = () => {
    if (!snapshot) return
    setEditor({ snapshot, provider: { id: `provider-${crypto.randomUUID()}`, name: t('newProvider'), base_url: '', api_format: 'openai-responses', models: [] } })
  }
  const editProvider = (provider: PublicModelProvider) => {
    if (snapshot) setEditor({ snapshot, provider: structuredClone(provider) })
  }

  return (
    <section data-testid="provider-settings-section" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="heading-small text-text-primary">{t('title')}</h3>
          <p className="mt-1 text-sm text-text-secondary">{t('description')}</p>
        </div>
        <button type="button" data-testid="provider-add" className={PRIMARY} disabled={!snapshot || pending || !!editor || !!loadError} onClick={addProvider}>
          <Plus className="h-4 w-4" />{t('addProvider')}
        </button>
      </div>
      <div className="space-y-2 rounded-lg bg-surface p-3">
        <p className="break-all font-mono text-xs text-text-secondary" data-testid="provider-file-path">{snapshot?.path ?? t('loading')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} data-testid="provider-file-choose" disabled={pending || !!editor} onClick={() => setConfirmation({ title: t('chooseFile'), description: t('chooseDescription'), run: chooseProviderConfiguration })}>
            <FileCode2 className="h-4 w-4" />{t('chooseFile')}
          </button>
          <button type="button" className={BUTTON} data-testid="provider-file-open" disabled={pending || !!editor} onClick={() => void perform(async () => { await invokeDesktopHost('modelConfiguration.open') })}>{t('openFile')}</button>
          <button type="button" className={BUTTON} data-testid="provider-file-reload" disabled={pending || !!editor} onClick={() => void perform(reloadProviderConfiguration)}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{t('reload')}
          </button>
          {legacyCount > 0 && <button type="button" className={BUTTON} data-testid="provider-migrate" disabled={!snapshot || pending || !!editor || !!loadError} onClick={() => setConfirmation({ title: t('migrate'), description: t('migrateDescription', { count: legacyCount }), run: async () => { if (snapshot) await migrateLegacyProviderModels(snapshot) } })}>{t('migrateCount', { count: legacyCount })}</button>}
        </div>
        <p className="text-xs text-text-secondary">{t('fileHint')}</p>
      </div>
      {(error || loadError) && <p role="alert" data-testid="provider-settings-error" className="break-words text-sm text-red-500">{error || loadError}</p>}
      {editor ? (
        <ProviderEditor key={editor.provider.id} initial={editor.provider} snapshot={editor.snapshot} onClose={() => setEditor(null)} />
      ) : (
        <div className="divide-y divide-border">
          {snapshot?.providers.map(provider => (
            <details key={provider.id} data-testid={`provider-row-${provider.id}`} className="py-3" open>
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <ChevronDown className="h-4 w-4 shrink-0" />
                  <span className="truncate text-sm font-medium text-text-primary">{provider.name}</span>
                  <span className="text-xs text-text-secondary">{t('modelCount', { count: provider.models.length })}</span>
                  {provider.enabled === false && <span className="text-xs text-text-secondary">{t('disabled')}</span>}
                </div>
                <div className="flex gap-2">
                  <button type="button" className={BUTTON} data-testid={`provider-edit-${provider.id}`} disabled={pending || !!loadError} onClick={event => { event.preventDefault(); editProvider(provider) }}>{t('edit')}</button>
                  <button type="button" className={BUTTON} data-testid={`provider-delete-${provider.id}`} disabled={pending || !!loadError} onClick={event => {
                    event.preventDefault()
                    if (snapshot) setConfirmation({ title: t('deleteProvider'), description: t('deleteDescription', { name: provider.name, count: provider.models.length }), run: () => saveProviderConfiguration(snapshot.revision, snapshot.providers.filter(item => item.id !== provider.id)) })
                  }}>{t('delete')}</button>
                </div>
              </summary>
              <div className="mt-2 space-y-1 pl-6">
                <p className="break-all text-xs text-text-secondary">{provider.base_url} · {provider.api_format} · {provider.api_key_configured ? t('keyConfigured') : t('noKey')}</p>
                {provider.models.map(model => <div key={model.id} className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-sm" data-testid={`provider-model-${model.id}`}>
                  <span className="text-text-primary">{model.display_name || model.model_id}</span>
                  <span className="break-all font-mono text-xs text-text-secondary">{model.model_id}{model.enabled === false ? ` · ${t('disabled')}` : ''}</span>
                </div>)}
                {provider.models.length === 0 && <p className="text-sm text-text-secondary">{t('emptyModels')}</p>}
              </div>
            </details>
          ))}
          {snapshot?.providers.length === 0 && <p className="py-4 text-sm text-text-secondary">{t('empty')}</p>}
        </div>
      )}
      <ConfirmDialog open={!!confirmation} title={confirmation?.title ?? ''} description={confirmation?.description ?? ''} cancelLabel={t('cancel')} confirmLabel={t('confirm')} confirmTestId="provider-action-confirm" pending={pending} onClose={() => setConfirmation(null)} onConfirm={() => {
        if (confirmation) void perform(async () => { await confirmation.run(); setConfirmation(null) })
      }} />
    </section>
  )
}

function ProviderEditor({ initial, snapshot, onClose }: { initial: ProviderDraft; snapshot: ModelConfigurationSnapshot; onClose: () => void }) {
  const { t } = useTranslation('modelConnections')
  const [draft, setDraft] = useState<ProviderDraft>(initial)
  const [batch, setBatch] = useState('')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discard, setDiscard] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || !!batch.trim()
  const patch = (value: Partial<ProviderDraft>) => setDraft(current => ({ ...current, ...value }))
  const patchModel = (id: string, value: Partial<ProviderModel>) => setDraft(current => ({ ...current, models: current.models.map(model => model.id === id ? { ...model, ...value } : model) }))

  function withModels(ids: string[]): ProviderDraft {
    const seen = new Set(draft.models.map(model => model.model_id))
    const additions = ids.map(id => id.trim()).filter(id => id && !seen.has(id) && !!seen.add(id))
    return { ...draft, models: [...draft.models, ...additions.map(model_id => ({ id: crypto.randomUUID(), model_id }))] }
  }
  function appendModels(ids: string[]) { setDraft(withModels(ids)); setBatch(''); setSelected(new Set()) }

  async function save(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const next = batch.trim() ? withModels(batch.split(/[\n,]+/)) : draft
      const found = snapshot.providers.some(provider => provider.id === initial.id)
      const providers = found ? snapshot.providers.map(provider => provider.id === initial.id ? next : provider) : [...snapshot.providers, next]
      await saveProviderConfiguration(snapshot.revision, providers)
      onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('failed')) }
    finally { setPending(false) }
  }

  async function discover() {
    setPending(true)
    setError(null)
    try { setDiscovered(await invokeDesktopHost<string[]>('modelConfiguration.discover', { providerId: initial.id })) }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('failed')) }
    finally { setPending(false) }
  }

  return (
    <form onSubmit={event => void save(event)} className="space-y-4 rounded-lg border border-border p-4" data-testid="provider-editor">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm text-text-secondary">{t('name')}<input data-testid="provider-name" className={INPUT} required value={draft.name} onChange={event => patch({ name: event.target.value })} /></label>
        <label className="space-y-1 text-sm text-text-secondary">{t('protocol')}<select data-testid="provider-protocol" className={INPUT} value={draft.api_format} onChange={event => patch({ api_format: event.target.value as ModelProvider['api_format'], request_path: undefined })}>{FORMATS.map(format => <option key={format}>{format}</option>)}</select></label>
        <label className="space-y-1 text-sm text-text-secondary">Base URL<input data-testid="provider-base-url" className={INPUT} type="url" required placeholder="https://gateway.example/v1" value={draft.base_url} onChange={event => patch({ base_url: event.target.value })} /></label>
        <label className="space-y-1 text-sm text-text-secondary">API Key<input data-testid="provider-api-key" className={INPUT} type="password" autoComplete="new-password" placeholder={draft.api_key_configured ? t('keepKey') : t('optionalKey')} value={draft.api_key ?? ''} onChange={event => patch({ api_key: event.target.value || undefined })} /></label>
      </div>
      <details className="space-y-3"><summary className="cursor-pointer text-sm text-text-secondary">{t('connectionAdvanced')}</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm text-text-secondary">{t('requestPath')}<input data-testid="provider-request-path" className={INPUT} value={draft.request_path ?? ''} placeholder={t('automatic')} onChange={event => patch({ request_path: event.target.value || undefined })} /></label>
          <label className="space-y-1 text-sm text-text-secondary">{t('modelsPath')}<input data-testid="provider-models-path" className={INPUT} value={draft.models_path ?? ''} placeholder="/models" onChange={event => patch({ models_path: event.target.value || undefined })} /></label>
          <label className="space-y-1 text-sm text-text-secondary">{t('listAuth')}<select data-testid="provider-models-auth" className={INPUT} value={draft.models_api_key_header ?? 'Authorization'} onChange={event => patch({ models_api_key_header: event.target.value as 'Authorization' | 'X-Api-Key' })}><option>Authorization</option><option>X-Api-Key</option></select></label>
          <label className="flex items-center gap-2 text-sm text-text-primary"><input data-testid="provider-enabled" type="checkbox" checked={draft.enabled !== false} onChange={event => patch({ enabled: event.target.checked })} />{t('enabled')}</label>
        </div>
        <p className="break-all font-mono text-xs text-text-secondary" data-testid="provider-request-preview">{draft.base_url.replace(/\/+$/, '')}{draft.request_path || (draft.api_format === 'openai-responses' ? '/responses' : draft.api_format === 'openai-chat-completions' ? '/chat/completions' : draft.base_url.endsWith('/v1') ? '/messages' : '/v1/messages')}</p>
      </details>
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-text-primary">{t('models')}</h4>
          <button type="button" className={BUTTON} data-testid="provider-discover" disabled={pending || dirty || !snapshot.providers.some(provider => provider.id === initial.id)} onClick={() => void discover()}>{t('discover')}</button>
        </div>
        <p className="text-xs text-text-secondary">{t('discoveryHint')}</p>
        {discovered.length > 0 && <div className="space-y-2 rounded-md bg-surface p-3" data-testid="provider-discovered-models">
          <div className="max-h-48 overflow-y-auto">{discovered.map(id => {
            const exists = draft.models.some(model => model.model_id === id)
            return <label key={id} className="flex min-h-8 items-center gap-2 text-sm text-text-primary"><input type="checkbox" data-testid={`provider-discovered-${id}`} checked={exists || selected.has(id)} disabled={exists} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(id); else next.delete(id); return next })} /><span className="break-all">{id}</span>{exists && <span className="text-xs text-text-secondary">{t('alreadyAdded')}</span>}</label>
          })}</div>
          <button type="button" className={BUTTON} data-testid="provider-add-selected" disabled={!selected.size} onClick={() => appendModels([...selected])}>{t('addSelected', { count: selected.size })}</button>
        </div>}
        <label className="block space-y-1 text-sm text-text-secondary">{t('batch')}<textarea data-testid="provider-batch-models" className={`${INPUT} font-mono`} rows={3} value={batch} onChange={event => setBatch(event.target.value)} placeholder={t('batchPlaceholder')} /></label>
        <div className="flex gap-2"><button type="button" className={BUTTON} data-testid="provider-append-models" disabled={!batch.trim()} onClick={() => appendModels(batch.split(/[\n,]+/))}>{t('append')}</button><button type="button" className={BUTTON} data-testid="provider-model-add" onClick={() => patch({ models: [...draft.models, { id: crypto.randomUUID(), model_id: '' }] })}>{t('manual')}</button></div>
        <div className="divide-y divide-border">{draft.models.map(model => (
          <div key={model.id} className="space-y-2 py-3" data-testid={`provider-model-editor-${model.id}`}>
            <div className="flex flex-wrap gap-2">
              <input className={`${INPUT} flex-1`} data-testid={`provider-model-id-${model.id}`} aria-label={t('modelId')} value={model.model_id} required placeholder={t('modelId')} onChange={event => patchModel(model.id, { model_id: event.target.value })} />
              <input className={`${INPUT} flex-1`} data-testid={`provider-model-name-${model.id}`} aria-label={t('displayName')} value={model.display_name ?? ''} placeholder={t('displayName')} onChange={event => patchModel(model.id, { display_name: event.target.value || undefined })} />
              <label className="flex items-center gap-1 text-xs text-text-secondary"><input data-testid={`provider-model-enabled-${model.id}`} type="checkbox" checked={model.enabled !== false} onChange={event => patchModel(model.id, { enabled: event.target.checked })} />{t('enabled')}</label>
              <button type="button" className={BUTTON} data-testid={`provider-model-remove-${model.id}`} onClick={() => patch({ models: draft.models.filter(item => item.id !== model.id) })}>{t('remove')}</button>
            </div>
            <ModelAdvancedFields model={model} provider={draft} onChange={value => patchModel(model.id, value)} />
          </div>
        ))}</div>
      </div>
      {error && <p role="alert" data-testid="provider-editor-error" className="text-sm text-red-500">{error}</p>}
      <p className="text-xs text-text-secondary">{t('saveHint')}</p>
      <div className="flex justify-end gap-2"><button type="button" className={BUTTON} data-testid="provider-editor-cancel" disabled={pending} onClick={() => dirty ? setDiscard(true) : onClose()}>{t('cancel')}</button><button type="submit" className={PRIMARY} data-testid="provider-editor-save" disabled={pending}>{pending && <Loader2 className="h-4 w-4 animate-spin" />}{t('save')}</button></div>
      <ConfirmDialog open={discard} title={t('discard')} description={t('discardDescription')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} confirmTestId="provider-discard-confirm" onClose={() => setDiscard(false)} onConfirm={onClose} />
    </form>
  )
}

function ModelAdvancedFields({ model, provider, onChange }: { model: ProviderModel; provider: ModelProvider; onChange: (value: Partial<ProviderModel>) => void }) {
  const { t } = useTranslation('modelConnections')
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const format = model.api_format ?? provider.api_format
  const toolProfile = model.tool_profile ?? defaultLocalModelToolProfile(format)
  const entry = model.catalog_entry ?? createDefaultLocalModelCatalogEntry({ id: model.id, displayName: model.display_name || model.model_id, toolProfile, contextWindow: model.context_window })
  return <details><summary className="cursor-pointer text-xs text-text-secondary">{t('modelAdvanced')}</summary>
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      <label className="space-y-1 text-sm text-text-secondary">{t('protocol')}<select className={INPUT} data-testid={`provider-model-protocol-${model.id}`} value={model.api_format ?? ''} onChange={event => onChange({ api_format: event.target.value as ProviderModel['api_format'] || undefined, request_path: undefined, tool_profile: undefined, catalog_entry: undefined })}><option value="">{t('inherit')}</option>{FORMATS.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="space-y-1 text-sm text-text-secondary">{t('requestPath')}<input className={INPUT} data-testid={`provider-model-path-${model.id}`} value={model.request_path ?? ''} placeholder={t('inherit')} onChange={event => onChange({ request_path: event.target.value || undefined })} /></label>
      <label className="space-y-1 text-sm text-text-secondary">{t('contextWindow')}<input className={INPUT} data-testid={`provider-model-context-${model.id}`} type="number" min={1} value={model.context_window ?? ''} placeholder={t('automatic')} onChange={event => onChange({ context_window: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label className="space-y-1 text-sm text-text-secondary">{t('toolProfile')}<select className={INPUT} data-testid={`provider-model-tools-${model.id}`} value={model.tool_profile ?? ''} onChange={event => onChange({ tool_profile: event.target.value as ProviderModel['tool_profile'] || undefined })}><option value="">{t('automatic')}</option>{(format === 'openai-responses' ? ['custom', 'function', 'shell'] : ['function', 'shell']).map(value => <option key={value}>{value}</option>)}</select></label>
      {format === 'openai-responses' && <label className="space-y-1 text-sm text-text-secondary">{t('toolCompatibility')}<select className={INPUT} data-testid={`provider-model-compatibility-${model.id}`} value={model.codex_tool_compatibility ?? 'native'} onChange={event => onChange({ codex_tool_compatibility: event.target.value as ProviderModel['codex_tool_compatibility'] })}><option value="native">native</option><option value="standard">standard</option></select></label>}
    </div>
    <button type="button" className={`${BUTTON} mt-3`} data-testid={`provider-model-capabilities-${model.id}`} onClick={() => setCapabilitiesOpen(value => !value)}>{t('capabilities')}</button>
    {capabilitiesOpen && <div className="mt-3"><CustomModelCapabilitiesForm entry={entry} contextWindow={model.context_window?.toString() ?? ''} onContextWindowChange={value => onChange({ context_window: value ? Number(value) : undefined })} onChange={catalog_entry => onChange({ catalog_entry })} /></div>}
  </details>
}
