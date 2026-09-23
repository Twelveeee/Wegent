import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ModelConfigurationSnapshot } from '@/features/model-settings/providerModelConfiguration'
import { ProviderSettingsSection } from './ProviderSettingsSection'
import { reloadProviderConfiguration } from '@/features/model-settings/providerModelConfiguration'
import { replaceProviderModelConfigs } from '@/features/model-settings/providerModelState'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invoke,
  subscribeDesktopHostEvents: vi.fn(() => () => {}),
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

let snapshot: ModelConfigurationSnapshot
beforeEach(async () => {
  localStorage.clear()
  replaceProviderModelConfigs([])
  snapshot = {
    path: '/test/model.yml',
    revision: 'one',
    loadedAt: '',
    providers: [
      {
        id: 'relay',
        name: 'My relay',
        base_url: 'https://relay.example/v1',
        api_format: 'openai-responses',
        api_key_configured: true,
        models: [],
      },
    ],
  }
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    if (method === 'modelConfiguration.read') return snapshot
    if (method === 'modelConfiguration.runtime') return { revision: snapshot.revision, models: [] }
    if (method === 'modelConfiguration.save') {
      snapshot = { ...snapshot, revision: 'two', providers: params.providers }
      return snapshot
    }
    if (method === 'modelConfiguration.discover') return ['upstream-a', 'upstream-b']
    throw new Error(`Unexpected invocation: ${method}`)
  })
  await reloadProviderConfiguration()
})

describe('Provider settings page', () => {
  test('adds multiple models using the existing connection without re-entering a key', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-edit-relay'))
    expect(screen.getByTestId('provider-api-key')).toHaveValue('')
    await user.type(
      screen.getByTestId('provider-batch-models'),
      'upstream-a\nupstream-b\nupstream-a'
    )
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('modelConfiguration.save', expect.anything())
    )
    const saved = invoke.mock.calls.find(call => call[0] === 'modelConfiguration.save')![1]
    expect(saved.providers).toHaveLength(1)
    expect(saved.providers[0].base_url).toBe('https://relay.example/v1')
    expect(saved.providers[0].models.map((model: { model_id: string }) => model.model_id)).toEqual([
      'upstream-a',
      'upstream-b',
    ])
    expect(saved.providers[0].api_key).toBeUndefined()
    expect(invoke.mock.calls.every(call => call[0].startsWith('modelConfiguration.'))).toBe(true)
  })
  test('discovery supports selecting several models before one save', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-edit-relay'))
    await user.click(screen.getByTestId('provider-discover'))
    await user.click(await screen.findByTestId('provider-discovered-upstream-a'))
    await user.click(screen.getByTestId('provider-discovered-upstream-b'))
    await user.click(screen.getByTestId('provider-add-selected'))
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('modelConfiguration.save', expect.anything())
    )
    expect(snapshot.providers[0].models).toHaveLength(2)
  })
  test('a conflicting external edit keeps the unsaved form visible', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-edit-relay'))
    await user.type(screen.getByTestId('provider-name'), ' changed')
    invoke.mockImplementationOnce(async () => {
      throw new Error('model.yml changed externally. Reload before saving.')
    })
    await user.click(screen.getByTestId('provider-editor-save'))
    expect(await screen.findByTestId('provider-editor-error')).toHaveTextContent(
      'changed externally'
    )
    expect(screen.getByTestId('provider-name')).toHaveValue('My relay changed')
  })
})
