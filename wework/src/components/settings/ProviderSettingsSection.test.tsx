import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderSettingsSection } from './ProviderSettingsSection'
import * as config from '@/features/model-settings/providerConfig'

vi.mock('@/features/model-settings/providerConfig', () => ({
  providerConfigSnapshot: vi.fn(),
  subscribeProviderConfig: vi.fn(() => () => {}),
  mutateProviderConfig: vi.fn().mockResolvedValue(undefined),
  reloadProviderConfig: vi.fn().mockResolvedValue(undefined),
  bindProviderConfig: vi.fn(),
  openProviderFile: vi.fn(),
  migrateLegacyProviderConfig: vi.fn(),
  discoverConnectionModels: vi.fn(),
  effectiveRequestPath: vi.fn(() => '/responses'),
}))
vi.mock('@/components/settings/CustomModelCapabilitiesForm', () => ({
  CustomModelCapabilitiesForm: () => null,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(config.providerConfigSnapshot).mockReturnValue({
    loaded: true,
    error: null,
    snapshot: {
      path: '/tmp/model.yml',
      revision: 'revision-1',
      providers: [
        {
          id: 'relay',
          name: 'Relay',
          base_url: 'https://example.invalid/v1',
          api_format: 'openai-responses',
          api_key_configured: true,
          models: [],
        },
      ],
    },
  })
})

describe('ProviderSettingsSection', () => {
  it('adds a connection without creating per-model copies of its URL or key', async () => {
    render(<ProviderSettingsSection />)
    fireEvent.click(screen.getByTestId('provider-add'))
    fireEvent.change(screen.getByTestId('provider-name'), { target: { value: 'New relay' } })
    fireEvent.change(screen.getByTestId('provider-base-url'), {
      target: { value: 'https://example.invalid/v1' },
    })
    fireEvent.change(screen.getByTestId('provider-api-key'), { target: { value: 'test-key' } })
    fireEvent.submit(screen.getByTestId('provider-editor'))
    await waitFor(() =>
      expect(config.mutateProviderConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'save-provider',
          provider: expect.objectContaining({ name: 'New relay', api_key: 'test-key' }),
        }),
        'revision-1'
      )
    )
  })
  it('bulk-adds and deduplicates pasted IDs while inheriting the connection', async () => {
    render(<ProviderSettingsSection />)
    fireEvent.click(screen.getByTestId('provider-add-models-relay'))
    fireEvent.change(screen.getByTestId('provider-model-ids'), {
      target: { value: 'one\ntwo,one' },
    })
    fireEvent.submit(screen.getByTestId('provider-models-editor'))
    await waitFor(() => expect(config.mutateProviderConfig).toHaveBeenCalled())
    const [mutation, revision] = vi.mocked(config.mutateProviderConfig).mock.calls[0]
    expect(revision).toBe('revision-1')
    expect(mutation.kind).toBe('save-models')
    if (mutation.kind === 'save-models') {
      expect(mutation.models.map(model => model.model_id)).toEqual(['one', 'two'])
      expect(mutation.models[0]).not.toHaveProperty('api_key')
      expect(mutation.models[0]).not.toHaveProperty('base_url')
    }
  })
  it('allows manual addition when discovery fails', async () => {
    vi.mocked(config.discoverConnectionModels).mockRejectedValue(
      new Error('Model discovery returned HTTP 404')
    )
    render(<ProviderSettingsSection />)
    fireEvent.click(screen.getByTestId('provider-add-models-relay'))
    fireEvent.click(screen.getByTestId('provider-discover'))
    await screen.findByText('Model discovery returned HTTP 404')
    fireEvent.change(screen.getByTestId('provider-model-ids'), {
      target: { value: 'manual-model' },
    })
    fireEvent.submit(screen.getByTestId('provider-models-editor'))
    await waitFor(() => expect(config.mutateProviderConfig).toHaveBeenCalled())
  })
  it('shows file errors and disables editing without modifying legacy or cloud sources', () => {
    const state = config.providerConfigSnapshot()
    vi.mocked(config.providerConfigSnapshot).mockReturnValue({
      ...state,
      error: 'line 4: invalid YAML',
    })
    render(<ProviderSettingsSection />)
    expect(screen.getByTestId('provider-add')).toBeDisabled()
    expect(screen.getByTestId('provider-error')).toHaveTextContent('line 4')
    expect(config.mutateProviderConfig).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })
})
