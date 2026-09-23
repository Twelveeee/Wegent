import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { LOCAL_MODEL_PROVIDER_PROFILES } from '@/features/model-settings/localModelProviders'
import { providerRequestPath } from '@/features/model-settings/providerConfigClient'
import type { ProviderDefinition } from '@/features/model-settings/providerConfigTypes'
import type { LocalModelApiFormat } from '@/features/model-settings/localModelSettings'

export const providerInputClass = 'h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary'
export const providerButtonClass = 'inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50'

export function ProviderConnectionForm({ provider, pending, onSave, onCancel }: {
  provider?: ProviderDefinition
  pending: boolean
  onSave: (provider: Record<string, unknown>, apiKey: string, clearKey: boolean) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation('providers')
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [format, setFormat] = useState<LocalModelApiFormat>(provider?.api_format ?? 'openai-responses')
  const [path, setPath] = useState(provider?.request_path ?? '')
  const [modelsPath, setModelsPath] = useState(provider?.models_path ?? '')
  const [modelsBaseUrl, setModelsBaseUrl] = useState(provider?.models_base_url ?? '')
  const [header, setHeader] = useState(provider?.models_api_key_header ?? 'Authorization')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [enabled, setEnabled] = useState(provider?.enabled !== false)
  const [id] = useState(provider?.id ?? crypto.randomUUID())
  const field = (label: string, control: React.ReactNode) => <label className="grid gap-1 text-sm text-text-secondary">{label}{control}</label>

  return <form data-testid="provider-connection-form" className="grid gap-3 rounded-lg border border-border p-4" onSubmit={event => {
    event.preventDefault()
    void onSave({ id, name: name.trim(), base_url: baseUrl.trim(), api_format: format, request_path: path.trim() || null, models_path: modelsPath.trim() || null, models_base_url: modelsBaseUrl.trim() || null, models_api_key_header: header, enabled }, apiKey, clearKey)
  }}>
    <h4 className="text-sm font-semibold text-text-primary">{t(provider ? 'editProvider' : 'addProvider')}</h4>
    {!provider && field(t('template'), <select data-testid="provider-template" className={providerInputClass} defaultValue="custom" onChange={event => {
      const profile = LOCAL_MODEL_PROVIDER_PROFILES.find(item => item.id === event.target.value)
      if (!profile) return
      if (profile.id !== 'custom') setName(profile.displayName)
      setBaseUrl(profile.baseUrl); setFormat(profile.apiFormat); setPath(profile.requestPath)
      setModelsPath(profile.modelsPath ?? ''); setModelsBaseUrl(profile.modelsBaseUrl ?? ''); setHeader(profile.modelsApiKeyHeader ?? 'Authorization')
    }}>{LOCAL_MODEL_PROVIDER_PROFILES.map(profile => <option key={profile.id} value={profile.id}>{profile.id === 'custom' ? t('customTemplate') : profile.displayName}</option>)}</select>)}
    {field(t('providerName'), <input data-testid="provider-name" className={providerInputClass} value={name} onChange={e => setName(e.target.value)} required autoFocus />)}
    {field(t('baseUrl'), <input data-testid="provider-base-url" className={providerInputClass} type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required spellCheck={false} />)}
    {field(t('apiKey'), <input data-testid="provider-api-key" className={providerInputClass} type="password" autoComplete="new-password" value={apiKey} placeholder={provider?.api_key_configured ? t('keyUnchanged') : t('optionalKey')} onChange={e => { setApiKey(e.target.value); setClearKey(false) }} />)}
    {provider?.api_key_configured && <label className="flex gap-2 text-sm text-text-secondary"><input data-testid="provider-clear-key" type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); setApiKey('') }} />{t('clearKey')}</label>}
    {field(t('protocol'), <select data-testid="provider-api-format" className={providerInputClass} value={format} onChange={e => { setFormat(e.target.value as LocalModelApiFormat); setPath('') }}><option value="openai-responses">OpenAI Responses</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select>)}
    <p data-testid="provider-request-preview" className="break-all font-mono text-xs text-text-secondary">{baseUrl.replace(/\/+$/, '')}{path || providerRequestPath(format, baseUrl)}</p>
    <details><summary data-testid="provider-advanced" className="cursor-pointer text-sm text-text-secondary">{t('advancedConnection')}</summary><div className="mt-3 grid gap-3">
      {field(t('requestPath'), <input data-testid="provider-request-path" className={providerInputClass} value={path} onChange={e => setPath(e.target.value)} placeholder={providerRequestPath(format, baseUrl)} />)}
      {field(t('modelsPath'), <input data-testid="provider-models-path" className={providerInputClass} value={modelsPath} onChange={e => setModelsPath(e.target.value)} placeholder="/models" />)}
      {field(t('modelsBaseUrl'), <input data-testid="provider-models-base-url" className={providerInputClass} value={modelsBaseUrl} onChange={e => setModelsBaseUrl(e.target.value)} />)}
      {field(t('modelsHeader'), <select data-testid="provider-models-header" className={providerInputClass} value={header} onChange={e => setHeader(e.target.value as typeof header)}><option value="Authorization">Authorization: Bearer</option><option value="X-Api-Key">X-Api-Key</option></select>)}
      <label className="flex gap-2 text-sm"><input data-testid="provider-enabled" type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />{t('enabled')}</label>
    </div></details>
    <p className="text-xs text-text-secondary">{t('keyHint')}</p>
    <div className="flex justify-end gap-2"><button data-testid="provider-form-cancel" className={providerButtonClass} type="button" disabled={pending} onClick={onCancel}>{t('cancel')}</button><button data-testid="provider-form-save" className={providerButtonClass} type="submit" disabled={pending}>{t(pending ? 'saving' : 'save')}</button></div>
  </form>
}
