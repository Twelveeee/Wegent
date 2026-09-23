// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProviderConnectionEditor } from './ProviderConnectionEditor'
import type { ProviderConnection } from '../../../shared/provider-model-config'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./CustomModelCapabilitiesForm', () => ({ CustomModelCapabilitiesForm: () => null }))
const initial = (): ProviderConnection => ({
  id: 'relay',
  name: 'Relay',
  base_url: 'https://relay.example/v1',
  api_format: 'openai-responses',
  api_key_ref: 'wework-model-test',
  models: [],
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe('provider editor', () => {
  it('adds twenty models with a single connection and retains its key reference', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <ProviderConnectionEditor
        initial={initial()}
        keyConfigured
        existingKey="test-key"
        pending={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    )
    fireEvent.change(screen.getByTestId('provider-bulk-input'), {
      target: { value: Array.from({ length: 20 }, (_, i) => `model-${i}`).join('\n') },
    })
    fireEvent.click(screen.getByTestId('provider-add-bulk'))
    expect(screen.getAllByTestId(/^provider-model-id-/)).toHaveLength(20)
    expect(screen.getAllByTestId('provider-api-key')).toHaveLength(1)
    fireEvent.submit(screen.getByTestId('provider-editor'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0].models).toHaveLength(20)
    expect(onSave.mock.calls[0][0].api_key_ref).toBe('wework-model-test')
    expect(onSave.mock.calls[0][0].api_key).toBeUndefined()
  })
  it('replaces the shared key without copying it into each model', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <ProviderConnectionEditor
        initial={initial()}
        keyConfigured
        existingKey="test-key"
        pending={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    )
    fireEvent.change(screen.getByTestId('provider-api-key'), { target: { value: 'new-key' } })
    fireEvent.submit(screen.getByTestId('provider-editor'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0].api_key).toBe('new-key')
    expect(onSave.mock.calls[0][0].api_key_ref).toBeUndefined()
  })
  it('handles discovery failure without losing manual entries or disabling save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <ProviderConnectionEditor
        initial={{ ...initial(), models: [{ id: 'keep', model_id: 'manual' }] }}
        keyConfigured
        existingKey="test-key"
        pending={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('provider-discover'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('404'))
    fireEvent.submit(screen.getByTestId('provider-editor'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0].models[0].model_id).toBe('manual')
  })
  it('reports dirty cancellation instead of silently discarding edits', () => {
    const onCancel = vi.fn()
    render(
      <ProviderConnectionEditor
        initial={initial()}
        keyConfigured
        existingKey="test-key"
        pending={false}
        onSave={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.change(screen.getByTestId('provider-name'), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByTestId('provider-editor-cancel'))
    expect(onCancel).toHaveBeenCalledWith(true)
  })
})
