import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  saveProviderMutation,
  type ProviderConnection,
  type ProviderModel,
  type ProviderRevision,
  type PublicProviderConnection,
} from '@/features/model-settings/providerConfigClient'

export const providerInputClass =
  'h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary'
export const providerButtonClass =
  'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50'
export const providerFormats = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
] as const

export function ProviderField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm text-text-secondary">
      {label}
      {children}
    </label>
  )
}

export function ProviderEditorDialog({
  title,
  dirty,
  busy,
  error,
  onClose,
  onSave,
  children,
}: {
  title: string
  dirty: boolean
  busy: boolean
  error: string | null
  onClose: () => void
  onSave: () => void
  children: ReactNode
}) {
  const { t } = useTranslation('providers')
  const [discard, setDiscard] = useState(false)
  const close = () => {
    if (!busy) {
      if (dirty) setDiscard(true)
      else onClose()
    }
  }
  const ref = useDialogKeyboard<HTMLDivElement>(close, !discard, 'input')
  return createPortal(
    <>
      <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-editor-title"
          data-testid="provider-editor"
          className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border bg-popover text-text-primary shadow-lg"
        >
          <h3 id="provider-editor-title" className="heading-small border-b border-border px-5 py-4">
            {title}
          </h3>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={event => {
              event.preventDefault()
              onSave()
            }}
          >
            <div className="grid gap-4 overflow-y-auto p-5">
              {children}
              {error && (
                <p
                  role="alert"
                  data-testid="provider-editor-error"
                  className="break-words text-sm text-red-500"
                >
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border p-4">
              <button
                type="button"
                data-testid="provider-editor-cancel"
                disabled={busy}
                onClick={close}
                className={providerButtonClass}
              >
                {t('cancel')}
              </button>
              <button
                type="submit"
                data-testid="provider-editor-save"
                disabled={busy || !dirty}
                className="min-h-8 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
              >
                {busy ? t('saving') : t('save')}
              </button>
            </div>
          </form>
        </div>
      </div>
      <ConfirmDialog
        open={discard}
        title={t('discardTitle')}
        description={t('discardDescription')}
        cancelLabel={t('keepEditing')}
        confirmLabel={t('discard')}
        confirmTestId="provider-discard-confirm"
        onClose={() => setDiscard(false)}
        onConfirm={onClose}
      />
    </>,
    document.body
  )
}

export function ProviderConnectionEditor({
  provider,
  revision,
  onClose,
}: {
  provider?: PublicProviderConnection
  revision: ProviderRevision
  onClose: () => void
}) {
  const { t } = useTranslation('providers')
  const [initial] = useState(() => ({
    id: provider?.id ?? crypto.randomUUID(),
    name: provider?.name ?? '',
    base_url: provider?.base_url ?? '',
    api_format: provider?.api_format ?? ('openai-responses' as ProviderConnection['api_format']),
    request_path: provider?.request_path ?? '',
    models_path: provider?.models_path ?? '/models',
    enabled: provider?.enabled !== false,
  }))
  const [form, setForm] = useState(initial)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = key !== '' || clearKey || JSON.stringify(form) !== JSON.stringify(initial)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveProviderMutation(
        {
          kind: 'provider',
          provider: {
            ...form,
            name: form.name.trim(),
            base_url: form.base_url.trim().replace(/\/+$/, ''),
            request_path: form.request_path.trim() || undefined,
            models_path: form.models_path.trim() || undefined,
          },
          ...(key.trim() ? { apiKey: key.trim() } : {}),
          clearApiKey: clearKey,
        },
        revision
      )
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ProviderEditorDialog
      title={provider ? t('editProvider') : t('addProvider')}
      dirty={dirty}
      busy={busy}
      error={error}
      onClose={onClose}
      onSave={() => void save()}
    >
      <ProviderField label={t('connectionName')}>
        <input
          autoFocus
          required
          data-testid="provider-name-input"
          className={providerInputClass}
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
        />
      </ProviderField>
      <ProviderField label="Base URL">
        <input
          required
          type="url"
          data-testid="provider-url-input"
          className={providerInputClass}
          value={form.base_url}
          placeholder="https://gateway.example/v1"
          onChange={e => setForm({ ...form, base_url: e.target.value })}
        />
      </ProviderField>
      <ProviderField label={provider?.api_key_configured ? t('keyConfigured') : 'API Key'}>
        <input
          type="password"
          autoComplete="new-password"
          data-testid="provider-key-input"
          className={providerInputClass}
          value={key}
          placeholder={provider?.api_key_configured ? t('keepKey') : t('optionalKey')}
          onChange={e => {
            setKey(e.target.value)
            setClearKey(false)
          }}
        />
      </ProviderField>
      <p className="text-xs text-text-secondary">{t('keyHelp')}</p>
      {provider?.api_key_configured && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="provider-clear-key"
            checked={clearKey}
            onChange={e => {
              setClearKey(e.target.checked)
              setKey('')
            }}
          />
          {t('clearKey')}
        </label>
      )}
      <ProviderField label={t('defaultProtocol')}>
        <select
          data-testid="provider-format-select"
          className={providerInputClass}
          value={form.api_format}
          onChange={e =>
            setForm({
              ...form,
              api_format: e.target.value as ProviderConnection['api_format'],
              request_path: '',
            })
          }
        >
          {providerFormats.map(format => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </ProviderField>
      <details>
        <summary data-testid="provider-advanced" className="cursor-pointer text-sm">
          {t('advanced')}
        </summary>
        <div className="mt-3 grid gap-3">
          <ProviderField label={t('requestPath')}>
            <input
              data-testid="provider-path-input"
              className={providerInputClass}
              value={form.request_path}
              placeholder={t('automatic')}
              onChange={e => setForm({ ...form, request_path: e.target.value })}
            />
          </ProviderField>
          <ProviderField label={t('modelsPath')}>
            <input
              data-testid="provider-models-path"
              className={providerInputClass}
              value={form.models_path}
              onChange={e => setForm({ ...form, models_path: e.target.value })}
            />
          </ProviderField>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="provider-enabled-input"
              checked={form.enabled}
              onChange={e => setForm({ ...form, enabled: e.target.checked })}
            />
            {t('enabled')}
          </label>
        </div>
      </details>
    </ProviderEditorDialog>
  )
}

export function ProviderModelEditor({
  provider,
  model,
  revision,
  onClose,
}: {
  provider: PublicProviderConnection
  model: ProviderModel
  revision: ProviderRevision
  onClose: () => void
}) {
  const { t } = useTranslation('providers')
  const [form, setForm] = useState(model)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveProviderMutation({ kind: 'model', providerId: provider.id, model: form }, revision)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ProviderEditorDialog
      title={t('editModel')}
      dirty={JSON.stringify(model) !== JSON.stringify(form)}
      busy={busy}
      error={error}
      onClose={onClose}
      onSave={() => void save()}
    >
      <p className="text-sm text-text-secondary">{t('inherits', { name: provider.name })}</p>
      <ProviderField label={t('upstreamId')}>
        <input
          required
          data-testid="provider-model-id"
          className={providerInputClass}
          value={form.model_id}
          onChange={e => setForm({ ...form, model_id: e.target.value })}
        />
      </ProviderField>
      <ProviderField label={t('displayName')}>
        <input
          data-testid="provider-model-name"
          className={providerInputClass}
          value={form.display_name ?? ''}
          onChange={e => setForm({ ...form, display_name: e.target.value || undefined })}
        />
      </ProviderField>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="provider-model-enabled"
          checked={form.enabled !== false}
          onChange={e => setForm({ ...form, enabled: e.target.checked })}
        />
        {t('enabled')}
      </label>
      <details>
        <summary data-testid="provider-model-advanced" className="cursor-pointer text-sm">
          {t('advanced')}
        </summary>
        <div className="mt-3 grid gap-3">
          <ProviderField label={t('protocol')}>
            <select
              data-testid="provider-model-format"
              className={providerInputClass}
              value={form.api_format ?? ''}
              onChange={e =>
                setForm({
                  ...form,
                  api_format: e.target.value
                    ? (e.target.value as ProviderModel['api_format'])
                    : undefined,
                  request_path: undefined,
                })
              }
            >
              <option value="">{t('inherit')}</option>
              {providerFormats.map(format => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </ProviderField>
          <ProviderField label={t('requestPath')}>
            <input
              data-testid="provider-model-path"
              className={providerInputClass}
              value={form.request_path ?? ''}
              onChange={e => setForm({ ...form, request_path: e.target.value || undefined })}
            />
          </ProviderField>
          <ProviderField label={t('contextWindow')}>
            <input
              type="number"
              min="1"
              step="1"
              data-testid="provider-model-context"
              className={providerInputClass}
              value={form.context_window ?? ''}
              onChange={e =>
                setForm({
                  ...form,
                  context_window: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </ProviderField>
          <ProviderField label={t('tools')}>
            <select
              data-testid="provider-model-tools"
              className={providerInputClass}
              value={form.tool_profile ?? 'function'}
              onChange={e =>
                setForm({ ...form, tool_profile: e.target.value as ProviderModel['tool_profile'] })
              }
            >
              {['function', 'custom', 'shell'].map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </ProviderField>
          <p className="text-xs text-text-secondary">{t('advancedHelp')}</p>
        </div>
      </details>
    </ProviderEditorDialog>
  )
}
