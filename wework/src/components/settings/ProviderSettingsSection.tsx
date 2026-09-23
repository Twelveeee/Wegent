import { useEffect, useState, useSyncExternalStore } from 'react'
import { FileCode2, FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  bindProviderConfig,
  ensureProviderConfigLoaded,
  getProviderConfigState,
  mutateProviderConfig,
  openProviderConfig,
  reloadProviderConfig,
  subscribeProviderConfig,
} from '@/features/model-settings/providerConfigClient'
import {
  listLegacyLocalModelConfigs,
  listLocalModelConfigs,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  removeMigratedLocalModelConfigs,
} from '@/features/model-settings/localModelSettings'
import { migrateLegacyProviders } from '@/features/model-settings/providerModelConfig'
import { testLocalModelConnection } from '@/features/model-settings/localModelConnectionTest'
import type { ProviderConnection } from '../../../shared/provider-model-config'
import { ProviderConnectionEditor } from './ProviderConnectionEditor'

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 sm:min-h-8'
export function ProviderSettingsSection() {
  const { t } = useTranslation('providers')
  const state = useSyncExternalStore(subscribeProviderConfig, getProviderConfigState)
  const snapshot = state.snapshot
  const [editing, setEditing] = useState<{ provider: ProviderConnection; revision: string } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [legacyCount, setLegacyCount] = useState(() => listLegacyLocalModelConfigs().length)
  const [confirmation, setConfirmation] = useState<
    { kind: 'delete'; provider: ProviderConnection } | { kind: 'migrate' | 'discard' } | null
  >(null)
  useEffect(() => {
    void ensureProviderConfigLoaded()
    const refresh = () => setLegacyCount(listLegacyLocalModelConfigs().length)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
  }, [])
  const action = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await operation()
    } catch (error) {
      setError(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (!confirmation || !snapshot) return
    if (confirmation.kind === 'discard') {
      setEditing(null)
      setConfirmation(null)
      return
    }
    await action(async () => {
      if (confirmation.kind === 'delete')
        await mutateProviderConfig(
          { kind: 'delete', providerId: confirmation.provider.id },
          snapshot.revision
        )
      if (confirmation.kind === 'migrate') {
        const legacy = listLegacyLocalModelConfigs()
        await mutateProviderConfig(
          { kind: 'import', providers: migrateLegacyProviders(legacy) },
          snapshot.revision
        )
        removeMigratedLocalModelConfigs(legacy.map(model => model.id))
      }
      setConfirmation(null)
      setMessage(t('saved'))
    })
  }
  const test = async (id: string) => {
    await action(async () => {
      const config = listLocalModelConfigs().find(model => model.id === id)
      if (!config) throw new Error(t('missingModel'))
      await testLocalModelConnection(config)
      setMessage(t('testPassed'))
    })
  }
  return (
    <section data-testid="provider-settings" className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{t('title')}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t('description')}</p>
        </div>
        <button
          type="button"
          data-testid="provider-add"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50 sm:min-h-8"
          disabled={busy || !snapshot || Boolean(editing)}
          onClick={() =>
            setEditing({
              provider: {
                id: crypto.randomUUID(),
                name: '',
                base_url: '',
                api_format: 'openai-responses',
                models: [],
              },
              revision: snapshot!.revision,
            })
          }
        >
          <Plus className="h-4 w-4" />
          {t('addProvider')}
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="provider-bind-file"
          className={BUTTON}
          disabled={busy || Boolean(editing)}
          onClick={() => void action(bindProviderConfig)}
        >
          <FolderOpen className="h-4 w-4" />
          {t('bindFile')}
        </button>
        <button
          type="button"
          data-testid="provider-open-file"
          className={BUTTON}
          disabled={busy || Boolean(editing)}
          onClick={() => void action(openProviderConfig)}
        >
          <FileCode2 className="h-4 w-4" />
          {t('openFile')}
        </button>
        <button
          type="button"
          data-testid="provider-reload-file"
          className={BUTTON}
          disabled={busy || state.loading}
          onClick={() => void reloadProviderConfig()}
        >
          <RefreshCw className="h-4 w-4" />
          {t('reload')}
        </button>
        {legacyCount > 0 && (
          <button
            type="button"
            data-testid="provider-migrate-legacy"
            className={BUTTON}
            disabled={busy || !snapshot || Boolean(editing)}
            onClick={() => setConfirmation({ kind: 'migrate' })}
          >
            {t('migrate', { count: legacyCount })}
          </button>
        )}
      </div>
      {snapshot && (
        <p
          data-testid="provider-file-source"
          className="mt-2 break-all font-mono text-xs text-text-secondary"
        >
          {snapshot.path}
        </p>
      )}
      {snapshot && (
        <p className="mt-1 text-xs text-text-secondary">
          {t('loadedAt', { time: new Date(snapshot.loadedAt).toLocaleTimeString() })}
        </p>
      )}
      {(state.error || error) && (
        <p
          role="alert"
          data-testid="provider-error"
          className="mt-3 break-words text-sm text-red-500"
        >
          {error || state.error}
        </p>
      )}
      {snapshot?.warnings?.map(warning => (
        <p role="status" className="mt-2 text-sm text-text-secondary" key={warning}>
          {warning}
        </p>
      ))}
      {message && (
        <p role="status" data-testid="provider-notice" className="mt-3 text-sm text-text-secondary">
          {message}
        </p>
      )}
      {editing ? (
        <>
          {snapshot?.revision !== editing.revision && (
            <p className="mt-3 text-sm text-text-secondary">{t('externalChange')}</p>
          )}
          <ProviderConnectionEditor
            key={`${editing.provider.id}:${editing.revision}`}
            initial={editing.provider}
            keyConfigured={Boolean(snapshot?.credentials[editing.provider.id])}
            existingKey={snapshot?.credentials[editing.provider.id] ?? ''}
            pending={busy}
            onCancel={dirty => (dirty ? setConfirmation({ kind: 'discard' }) : setEditing(null))}
            onSave={async (provider, clearKey) => {
              setBusy(true)
              try {
                await mutateProviderConfig({ kind: 'upsert', provider, clearKey }, editing.revision)
                setEditing(null)
                setMessage(t('saved'))
              } finally {
                setBusy(false)
              }
            }}
          />
        </>
      ) : (
        <div className="mt-4 space-y-3">
          {snapshot?.document.providers.map(provider => (
            <details
              key={provider.id}
              open
              data-testid={`provider-connection-${provider.id}`}
              className="rounded-lg border border-border bg-background"
            >
              <summary
                data-testid={`provider-expand-${provider.id}`}
                className="cursor-pointer px-3 py-3 text-sm font-medium text-text-primary"
              >
                {provider.name}
                <span className="ml-2 font-normal text-text-secondary">
                  {t('modelsCount', { count: provider.models.length })} · {provider.api_format}
                  {provider.enabled === false ? ` · ${t('disabled')}` : ''}
                </span>
              </summary>
              <div className="px-3 pb-3">
                <p className="break-all font-mono text-xs text-text-secondary">
                  {provider.base_url}
                </p>
                <div className="my-3 flex gap-2">
                  <button
                    type="button"
                    data-testid={`provider-edit-${provider.id}`}
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => setEditing({ provider, revision: snapshot!.revision })}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    data-testid={`provider-delete-${provider.id}`}
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => setConfirmation({ kind: 'delete', provider })}
                  >
                    {t('delete')}
                  </button>
                </div>
                <div className="divide-y divide-border">
                  {provider.models.map(model => (
                    <div
                      data-testid={`provider-model-summary-${model.id}`}
                      key={model.id}
                      className="flex flex-wrap items-center gap-2 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1 break-all">
                        {model.display_name || model.model_id}
                        <span className="ml-2 text-xs text-text-secondary">{model.model_id}</span>
                      </span>
                      <span className="text-xs text-text-secondary">
                        {provider.enabled === false || model.enabled === false
                          ? t('disabled')
                          : t('configured')}
                      </span>
                      <button
                        type="button"
                        data-testid={`provider-model-test-${model.id}`}
                        title={t('testCost')}
                        className={BUTTON}
                        disabled={busy || provider.enabled === false || model.enabled === false}
                        onClick={() => void test(model.id)}
                      >
                        {t('test')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ))}
          {snapshot && !snapshot.document.providers.length && (
            <p className="py-3 text-sm text-text-secondary">{t('empty')}</p>
          )}
          <p className="text-xs text-text-secondary">{t('testCost')}</p>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={
          confirmation?.kind === 'delete'
            ? t('delete')
            : confirmation?.kind === 'migrate'
              ? t('migrateTitle')
              : t('discardTitle')
        }
        description={
          confirmation?.kind === 'delete'
            ? t('deleteConfirm')
            : confirmation?.kind === 'migrate'
              ? t('migrateConfirm', { count: legacyCount })
              : t('discardConfirm')
        }
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        confirmTestId="provider-confirm"
        dialogTestId="provider-confirm-dialog"
        pending={busy}
        destructive={confirmation?.kind === 'delete'}
        onClose={() => setConfirmation(null)}
        onConfirm={() => void confirm()}
      />
    </section>
  )
}
