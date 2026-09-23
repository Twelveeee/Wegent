import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import { discoverConfiguredProvider } from '@/features/model-settings/providerConfigClient'
import type { ProviderDefinition, ProviderModelDefinition } from '@/features/model-settings/providerConfigTypes'
import type { LocalModelApiFormat } from '@/features/model-settings/localModelSettings'
import { CustomModelCapabilitiesForm } from '../CustomModelCapabilitiesForm'
import { providerButtonClass, providerInputClass } from './ProviderConnectionForm'

export function ProviderModelEditor({ provider, model, revision, pending, onSave, onCancel }: {
  provider: ProviderDefinition
  model?: ProviderModelDefinition
  revision: string
  pending: boolean
  onSave: (models: Record<string, unknown>[]) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation('providers')
  const [draft, setDraft] = useState<ProviderModelDefinition>(model ?? { id: crypto.randomUUID(), model_id: '', enabled: true })
  const [batch, setBatch] = useState('')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const update = (patch: Partial<ProviderModelDefinition>) => setDraft(current => ({ ...current, ...patch }))
  const existing = new Set(provider.models.map(item => item.model_id))
  const format = draft.api_format ?? provider.api_format ?? 'openai-responses'
  const toolProfile = draft.tool_profile ?? provider.tool_profile ?? (format === 'openai-responses' ? 'custom' : 'function')
  const entry = draft.catalog_entry ?? createDefaultLocalModelCatalogEntry({ id: draft.id, displayName: draft.display_name || draft.model_id, toolProfile, contextWindow: draft.context_window })
  const field = (label: string, control: React.ReactNode) => <label className="grid gap-1 text-sm text-text-secondary">{label}{control}</label>
  const loadModels = async () => {
    setLoading(true); setError('')
    try { setDiscovered((await discoverConfiguredProvider(provider.id, revision)).map(item => item.id)) }
    catch (e) { setError(e instanceof Error ? e.message : t('discoveryFailed')) }
    finally { setLoading(false) }
  }
  const save = () => {
    if (model) {
      const cleaned = Object.fromEntries(Object.entries(draft).filter(([,value]) => value !== undefined))
      // Explicitly clear an override when the user selects inheritance.
      for (const key of ['api_format', 'request_path', 'context_window'] as const) if (draft[key] === undefined && model[key] !== undefined) cleaned[key] = null
      cleaned.display_name = draft.display_name?.trim() || draft.model_id.trim()
      void onSave([cleaned]); return
    }
    const ids = [...new Set([draft.model_id.trim(), ...batch.split(/[\n,，]+/).map(value => value.trim()), ...selected].filter(Boolean))].filter(id => !existing.has(id))
    if (!ids.length) { setError(t('noNewModels')); return }
    void onSave(ids.map((id, index) => index === 0 && id === draft.model_id.trim() ? { ...draft, model_id: id, display_name: draft.display_name?.trim() || id } : { id: crypto.randomUUID(), model_id: id, enabled: true }))
  }
  return <form data-testid="provider-model-editor" className="grid gap-3 rounded-lg border border-border p-4" onSubmit={event => { event.preventDefault(); save() }}>
    <h4 className="text-sm font-semibold text-text-primary">{t(model ? 'editModel' : 'addModels')} · {provider.name}</h4>
    <p className="text-xs text-text-secondary">{t('inheritedConnection')}</p>
    {field(t('modelId'), <input data-testid="provider-model-id" className={providerInputClass} value={draft.model_id} spellCheck={false} onChange={e => update({ model_id: e.target.value })} required={Boolean(model)} autoFocus />)}
    {field(t('displayName'), <input data-testid="provider-model-name" className={providerInputClass} value={draft.display_name ?? ''} onChange={e => update({ display_name: e.target.value })} />)}
    {!model && <>
      {field(t('batchHint'), <textarea data-testid="provider-model-batch" className="min-h-24 w-full rounded-md border border-border bg-background p-3 font-mono text-sm" value={batch} onChange={e => setBatch(e.target.value)} spellCheck={false} />)}
      <button data-testid="provider-discover-models" className={providerButtonClass} type="button" disabled={loading || pending} onClick={() => void loadModels()}>{t(loading ? 'loading' : 'discover')}</button>
      {discovered.length > 0 && <div data-testid="provider-discovered-models" className="max-h-48 overflow-y-auto rounded-md border border-border p-2">{discovered.map((id, index) => <label key={id} className="flex min-h-8 items-center gap-2 break-all text-sm"><input data-testid={`provider-discovered-${index}`} type="checkbox" disabled={existing.has(id)} checked={selected.has(id) || existing.has(id)} onChange={e => setSelected(current => { const next = new Set(current); if (e.target.checked) next.add(id); else next.delete(id); return next })} />{id}{existing.has(id) && <span className="text-xs text-text-secondary">{t('alreadyAdded')}</span>}</label>)}</div>}
    </>}
    <label className="flex gap-2 text-sm"><input data-testid="provider-model-enabled" type="checkbox" checked={draft.enabled !== false} onChange={e => update({ enabled: e.target.checked })} />{t('enabled')}</label>
    <button data-testid="provider-model-advanced" className={providerButtonClass} type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t('modelCapabilities')}</button>
    {advanced && <div className="grid gap-3">
      {field(t('protocol'), <select data-testid="provider-model-format" className={providerInputClass} value={draft.api_format ?? ''} onChange={e => update({ api_format: e.target.value ? e.target.value as LocalModelApiFormat : undefined, request_path: undefined })}><option value="">{t('inherit')}</option><option value="openai-responses">OpenAI Responses</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select>)}
      {field(t('requestPath'), <input data-testid="provider-model-path" className={providerInputClass} value={draft.request_path ?? ''} onChange={e => update({ request_path: e.target.value || undefined })} />)}
      <CustomModelCapabilitiesForm entry={entry} contextWindow={draft.context_window?.toString() ?? ''} apiFormat={format} codexToolCompatibility={draft.codex_tool_compatibility ?? 'native'} onContextWindowChange={value => update({ context_window: value ? Number(value) : undefined })} onCodexToolCompatibilityChange={value => update({ codex_tool_compatibility: value })} onChange={catalog => update({ catalog_entry: catalog })} />
    </div>}
    {error && <p role="alert" data-testid="provider-discovery-error" className="text-sm text-red-500">{error}</p>}
    <div className="flex justify-end gap-2"><button data-testid="provider-model-cancel" className={providerButtonClass} type="button" disabled={pending} onClick={onCancel}>{t('cancel')}</button><button data-testid="provider-model-save" className={providerButtonClass} type="submit" disabled={pending || loading}>{t(pending ? 'saving' : 'save')}</button></div>
  </form>
}
