import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { waitForSnapshot } from './conversation-layout.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

/** Exercise the real desktop host, encrypted credentials and external YAML edits. */
export async function verifyProviderConfiguration(control) {
  const section = '[data-testid="provider-settings-section"]'
  await control.command('navigate', 'body', { value: '/settings/personal/models' })
  await control.command('waitFor', section)
  const filePath = (await control.command('getText', '[data-testid="provider-config-path"]')).trim()
  assert.ok(filePath.endsWith('.yml') || filePath.endsWith('.yaml'))
  const originalSource = await readFile(filePath, 'utf8')
  const click = testId => control.command('clickWhenEnabled', `[data-testid="${testId}"]`)
  const fill = (testId, value) => control.command('fill', `[data-testid="${testId}"]`, { value })
  try {
    await click('provider-add')
    await fill('provider-name', 'Provider configuration E2E')
    await fill('provider-base-url', 'https://example.test/v1')
    await fill('provider-api-key', 'synthetic-provider-e2e-key')
    await click('provider-form-save')
    const state = await waitForSnapshot(control, snapshot => !snapshot.testIds.includes('provider-connection-form') && snapshot.testIds.some(id => id.startsWith('provider-row-')), 'Provider save did not update the real desktop catalog')
    const providerId = state.testIds.find(id => id.startsWith('provider-row-')).slice('provider-row-'.length)
    await click(`provider-model-add-${providerId}`)
    await fill('provider-model-batch', Array.from({ length: 20 }, (_, i) => `synthetic-model-${i}`).join('\n'))
    await click('provider-model-save')
    await waitForSnapshot(control, snapshot => snapshot.testIds.filter(id => id.startsWith('provider-model-row-')).length === 20, 'Batch model add failed')
    const stored = await readFile(filePath, 'utf8')
    assert.equal(stored.includes('synthetic-provider-e2e-key'), false)
    assert.equal(stored.match(/api_key_ref:/g)?.length, 1)
    await captureVerificationScreenshot(control, 'provider-configuration-20-models.png', section)

    await click(`provider-edit-${providerId}`)
    await writeFile(filePath, '# external editor update\n' + stored)
    await fill('provider-name', 'Stale form must not win')
    await click('provider-form-save')
    await control.command('waitFor', '[data-testid="provider-config-error"]', { text: 'changed outside' })
    assert.equal((await readFile(filePath, 'utf8')).includes('Stale form must not win'), false)
    await click('provider-form-cancel')
    await click('provider-config-reload')
    await writeFile(filePath, 'version: 1\nproviders: [')
    await click('provider-config-reload')
    await control.command('waitFor', '[data-testid="provider-config-error"]', { text: 'Invalid YAML' })
    const retained = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(retained.testIds.filter(id => id.startsWith('provider-model-row-')).length, 20)
    await writeFile(filePath, '# external editor update\n' + stored)
    await click('provider-config-reload')
    await waitForSnapshot(control, snapshot => !snapshot.testIds.includes('provider-config-error'), 'Recovery did not clear configuration error')
  } finally {
    await writeFile(filePath, originalSource)
    await click('provider-config-reload')
    await control.command('navigate', 'body', { value: '/' })
  }
}
