import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderSettingsSection } from './ProviderSettingsSection'
import type { ProviderSnapshot } from '@/features/model-settings/providerConfig'

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), reload: vi.fn(), invoke: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: mocks.invoke }))
vi.mock('@/features/model-settings/providerConfig', () => ({
  readProviderFile: mocks.read,
  saveProviderFile: mocks.save,
  reloadProviderFileModels: mocks.reload,
  legacyProviders: () => ({ providers: [], keys: {} }),
}))
vi.mock('./CustomModelCapabilitiesForm', () => ({ CustomModelCapabilitiesForm: () => <div /> }))

const fixture = (): ProviderSnapshot => ({
  path: '/tmp/model.yml',
  revision: 'r1',
  configuredKeys: ['relay'],
  document: {
    version: 1,
    providers: [
      {
        id: 'relay',
        name: 'Existing provider',
        base_url: 'https://example.invalid/v1',
        api_format: 'openai-responses',
        api_key_ref: 'model-provider.key.fixture',
        models: [{ id: 'model-one', model_id: 'upstream-one', settings: { contextWindow: 8000 } }],
      },
    ],
  },
})

beforeEach(() => {
  localStorage.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.read.mockResolvedValue(fixture())
  mocks.reload.mockResolvedValue(undefined)
  mocks.save.mockImplementation(async (_snapshot, document) => ({
    ...fixture(),
    revision: 'r2',
    document,
  }))
})
afterEach(cleanup)

async function loaded() {
  render(<ProviderSettingsSection />)
  await screen.findByTestId('provider-name')
  await waitFor(() =>
    expect((screen.getByTestId('provider-name') as HTMLInputElement).disabled).toBe(false)
  )
}

describe('Provider settings page', () => {
  it('adds 20 model IDs while entering connection credentials once', async () => {
    await loaded()
    await userEvent.click(screen.getByTestId('provider-create'))
    await userEvent.type(screen.getByTestId('provider-name'), 'My relay')
    await userEvent.type(screen.getByTestId('provider-base-url'), 'https://relay.invalid/v1')
    await userEvent.type(screen.getByTestId('provider-api-key'), 'fixture-api-key')
    await userEvent.type(
      screen.getByTestId('provider-batch-input'),
      Array.from({ length: 20 }, (_, i) => `model-${i}`).join('\n')
    )
    await userEvent.click(screen.getByTestId('provider-batch-add'))
    await userEvent.click(screen.getByTestId('provider-save'))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const [, document, keys] = mocks.save.mock.calls[0]
    const provider = document.providers[1]
    expect(provider.models).toHaveLength(20)
    expect(keys).toEqual({ [provider.id]: 'fixture-api-key' })
    expect(
      provider.models.every(
        (model: object) => !Object.hasOwn(model, 'apiKey') && !Object.hasOwn(model, 'baseUrl')
      )
    ).toBe(true)
  })

  it('preserves credential references, stable model IDs and capabilities when renaming a provider', async () => {
    await loaded()
    expect((screen.getByTestId('provider-api-key') as HTMLInputElement).value).toBe('')
    await userEvent.clear(screen.getByTestId('provider-name'))
    await userEvent.type(screen.getByTestId('provider-name'), 'Renamed')
    await userEvent.click(screen.getByTestId('provider-save'))
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    const [, document, keys] = mocks.save.mock.calls[0]
    expect(keys).toEqual({})
    expect(document.providers[0].api_key_ref).toBe('model-provider.key.fixture')
    expect(document.providers[0].models[0]).toEqual(fixture().document.providers[0].models[0])
  })

  it('retains the draft when an external file edit conflicts with saving', async () => {
    mocks.save.mockRejectedValue(new Error('The file changed in another editor'))
    await loaded()
    await userEvent.type(screen.getByTestId('provider-name'), ' unsaved')
    await userEvent.click(screen.getByTestId('provider-save'))
    expect((await screen.findByTestId('provider-error')).textContent).toContain(
      'changed in another editor'
    )
    expect((screen.getByTestId('provider-name') as HTMLInputElement).value).toBe(
      'Existing provider unsaved'
    )
  })

  it('can select another YAML file without copying cloud models into it', async () => {
    const selected = {
      ...fixture(),
      path: '/tmp/selected.yml',
      document: { version: 1, providers: [] },
    }
    mocks.invoke.mockResolvedValue(selected)
    await loaded()
    await userEvent.click(screen.getByTestId('provider-file-choose'))
    await waitFor(() =>
      expect(screen.getByTestId('provider-file-path').textContent).toBe('/tmp/selected.yml')
    )
    expect(mocks.invoke).toHaveBeenCalledWith('modelConfig.choose')
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
