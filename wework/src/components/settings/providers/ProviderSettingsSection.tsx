import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { listLegacyLocalModelConfigs, LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { bindProviderConfig, ensureProviderModelsLoaded, mutateProviderConfig, openProviderConfig, reloadProviderConfig } from '@/features/model-settings/providerConfigClient'
import { getProviderConfigState, PROVIDER_CONFIG_CHANGED_EVENT } from '@/features/model-settings/providerConfigState'
import type { ProviderDefinition, ProviderModelDefinition } from '@/features/model-settings/providerConfigTypes'
import { ProviderConnectionForm, providerButtonClass } from './ProviderConnectionForm'
import { ProviderModelEditor } from './ProviderModelEditor'

type Editor = { kind: 'provider'; provider?: ProviderDefinition; revision: string } | { kind: 'model'; provider: ProviderDefinition; model?: ProviderModelDefinition; revision: string }
interface Confirmation { title: string; description: string; destructive: boolean; mutation: Record<string, unknown>; revision: string }
function subscribeState(notify: () => void): () => void {
  window.addEventListener(PROVIDER_CONFIG_CHANGED_EVENT, notify)
  window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, notify)
  return () => { window.removeEventListener(PROVIDER_CONFIG_CHANGED_EVENT, notify); window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, notify) }
}

export function ProviderSettingsSection() {
  const { t } = useTranslation('providers')
  const state = useSyncExternalStore(subscribeState, getProviderConfigState, getProviderConfigState)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [search, setSearch] = useState('')
  const [legacyCount, setLegacyCount] = useState(() => listLegacyLocalModelConfigs().length)
  useEffect(() => {
    if (!isDesktopRuntime()) return
    void ensureProviderModelsLoaded()
    const refresh = () => setLegacyCount(listLegacyLocalModelConfigs().length)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
  }, [])
  if (!isDesktopRuntime()) return null
  const snapshot = state.snapshot
  const revision = snapshot?.revision ?? ''
  const editing = Boolean(editor)
  const disabled = pending || editing || !revision || Boolean(snapshot?.error)
  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setPending(true); setError(null)
    try { await operation(); return true }
    catch (e) { setError(e instanceof Error ? e.message : t('operationFailed')); return false }
    finally { setPending(false) }
  }
  const save = async (mutation: Record<string, unknown>, basedOn: string) => {
    if (await run(() => mutateProviderConfig(mutation, basedOn))) setEditor(null)
  }
  const providers = snapshot?.providers ?? []
  return <section data-testid="provider-settings-section" aria-label={t('title')} className="grid gap-3">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-text-primary">{t('title')}</h3><p className="mt-1 text-xs text-text-secondary">{t('description')}</p></div><button data-testid="provider-add" className={providerButtonClass} type="button" disabled={disabled} onClick={() => setEditor({ kind: 'provider', revision })}>{t('addProvider')}</button></div>
    <div className="grid gap-2 rounded-lg border border-border bg-background p-3">
      <p data-testid="provider-config-path" className="break-all font-mono text-xs text-text-secondary">{snapshot?.path || t('loading')}</p>
      <div className="flex flex-wrap gap-2">
        <button data-testid="provider-config-bind" className={providerButtonClass} type="button" disabled={pending || editing} onClick={() => void run(bindProviderConfig)}>{t('chooseFile')}</button>
        <button data-testid="provider-config-open" className={providerButtonClass} type="button" disabled={pending || !snapshot?.path} onClick={() => void run(openProviderConfig)}>{t('openFile')}</button>
        <button data-testid="provider-config-reload" className={providerButtonClass} type="button" disabled={pending || state.loading} onClick={() => void run(reloadProviderConfig)}>{t(state.loading ? 'loading' : 'reload')}</button>
        {legacyCount > 0 && <button data-testid="provider-migrate" className={providerButtonClass} type="button" disabled={disabled} onClick={() => setConfirmation({ title: t('migrate'), description: t('migrationDescription', { count: legacyCount }), destructive: false, mutation: { kind: 'migrate', configs: listLegacyLocalModelConfigs() }, revision })}>{t('migrateCount', { count: legacyCount })}</button>}
      </div>
      <p className="text-xs text-text-secondary">{t('fileHint')}</p>
    </div>
    {(error || state.error) && <p role="alert" data-testid="provider-config-error" className="rounded-md border border-red-500/20 p-3 text-sm text-red-500">{error || state.error}</p>}
    {editor?.kind === 'provider' && <ProviderConnectionForm key={editor.provider?.id ?? 'new-provider'} provider={editor.provider} pending={pending} onCancel={() => setEditor(null)} onSave={(provider, apiKey, clearKey) => save({ kind: 'provider.save', providerId: editor.provider?.id, provider, apiKey, clearKey }, editor.revision)} />}
    {editor?.kind === 'model' && <ProviderModelEditor key={editor.model?.id ?? editor.provider.id} provider={editor.provider} model={editor.model} revision={editor.revision} pending={pending} onCancel={() => setEditor(null)} onSave={models => save({ kind: 'models.save', providerId: editor.provider.id, models }, editor.revision)} />}
    {providers.length > 0 && <input data-testid="provider-search" aria-label={t('search')} placeholder={t('search')} className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={search} onChange={e => setSearch(e.target.value)} />}
    {!state.loading && providers.length === 0 && <p data-testid="provider-empty" className="text-sm text-text-secondary">{t('empty')}</p>}
    {providers.map(provider => {
      const query = search.trim().toLowerCase()
      const matchesProvider = provider.name.toLowerCase().includes(query)
      const models = provider.models.filter(model => matchesProvider || `${model.display_name ?? ''} ${model.model_id}`.toLowerCase().includes(query))
      if (query && !matchesProvider && models.length === 0) return null
      return <div key={provider.id} data-testid={`provider-row-${provider.id}`} className="rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3"><div className="min-w-0"><h4 className="break-all text-sm font-semibold text-text-primary">{provider.name} <span className="font-normal text-text-secondary">{t('modelCount', { count: provider.models.length })}</span></h4><p className="break-all text-xs text-text-secondary">{provider.base_url} · {t(provider.api_key_configured ? 'keyConfigured' : 'keyNotConfigured')} · {t(provider.enabled === false ? 'disabled' : 'enabled')}</p></div><div className="flex gap-2">
          <button data-testid={`provider-edit-${provider.id}`} className={providerButtonClass} disabled={disabled} onClick={() => setEditor({ kind: 'provider', provider, revision })}>{t('edit')}</button>
          <button data-testid={`provider-model-add-${provider.id}`} className={providerButtonClass} disabled={disabled} onClick={() => setEditor({ kind: 'model', provider, revision })}>{t('addModels')}</button>
          <button data-testid={`provider-delete-${provider.id}`} className={providerButtonClass} disabled={disabled} onClick={() => setConfirmation({ title: t('deleteProvider'), description: t('deleteProviderDescription', { name: provider.name, count: provider.models.length }), destructive: true, mutation: { kind: 'provider.delete', providerId: provider.id }, revision })}>{t('delete')}</button>
        </div></div>
        <div className="divide-y divide-border border-t border-border">{models.map(model => <div key={model.id} data-testid={`provider-model-row-${model.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><div className="min-w-0"><p className="break-all text-sm text-text-primary">{model.display_name || model.model_id}</p><p className="break-all font-mono text-xs text-text-secondary">{model.model_id} · {t(model.enabled === false ? 'disabled' : 'enabled')}</p></div><div className="flex gap-2">
          <button data-testid={`provider-model-edit-${model.id}`} className={providerButtonClass} disabled={disabled} onClick={() => setEditor({ kind: 'model', provider, model, revision })}>{t('edit')}</button>
          <button data-testid={`provider-model-delete-${model.id}`} className={providerButtonClass} disabled={disabled} onClick={() => setConfirmation({ title: t('deleteModel'), description: t('deleteModelDescription', { name: model.display_name || model.model_id }), destructive: true, mutation: { kind: 'model.delete', providerId: provider.id, modelId: model.id }, revision })}>{t('delete')}</button>
        </div></div>)}</div>
      </div>
    })}
    <p className="text-xs text-text-secondary">{t('catalogHint')}</p>
    <ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} description={confirmation?.description ?? ''} cancelLabel={t('cancel')} confirmLabel={t('confirm')} confirmTestId="provider-confirm" cancelTestId="provider-confirm-cancel" dialogTestId="provider-confirm-dialog" destructive={confirmation?.destructive} pending={pending} onClose={() => setConfirmation(null)} onConfirm={() => {
      if (!confirmation) return
      void run(() => mutateProviderConfig(confirmation.mutation, confirmation.revision)).then(success => { if (success) setConfirmation(null) })
    }} />
  </section>
}
