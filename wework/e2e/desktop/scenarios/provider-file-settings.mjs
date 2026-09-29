import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Exercise external YAML edits through the real native store in the isolated desktop profile. */
export async function createProviderFileSettingsScenario({ electronUserDataDirectory }) {
  const directory = join(electronUserDataDirectory, 'model-connections')
  const path = join(directory, 'model.yml')
  const source = `version: 1
providers:
  - id: file-provider
    name: File provider
    base_url: https://example.invalid/v1
    api_format: openai-responses
    enabled: false
    models:
      - id: file-model
        model_id: file-model
`
  await mkdir(directory, { recursive: true })
  await writeFile(path, source, { mode: 0o600 })

  return {
    async verify(control) {
      const telemetryConsent = '[data-testid="telemetry-consent-decline"]'
      if (Number(await control.command('getElementCount', telemetryConsent)) > 0) {
        await control.command('click', telemetryConsent)
      }
      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      const card = '[data-testid="provider-settings-card"]'
      const row = `${card} [data-testid="provider-row-file-provider"]`
      const reload = '[data-testid="provider-file-reload"]'
      const open = '[data-testid="provider-file-open"]'
      await control.command('waitFor', row, { text: 'File provider' })
      assert.equal(
        await control.command('getText', `${card} [data-testid="provider-file-path"]`),
        path
      )
      assert.equal(Number(await control.command('getElementCount', `${card} ${open}`)), 1)
      for (const token of ['rounded-lg', 'border-border', 'bg-background', 'p-4']) {
        assert.ok(
          (await control.command('getAttribute', card, { value: 'class' }))
            .split(' ')
            .includes(token),
          `Provider settings lost the shared card style: ${token}`
        )
      }

      try {
        await writeFile(path, source.replace('File provider', 'Externally edited provider'))
        await control.command('clickWhenEnabled', reload)
        await control.command('waitFor', row, { text: 'Externally edited provider' })

        await control.command('clickWhenEnabled', '[data-testid="provider-edit-file-provider"]')
        await control.command('waitFor', '[data-testid="provider-editor"]')
        for (const selector of [open, reload]) {
          assert.equal(
            Number(await control.command('getElementCount', `${selector}:disabled`)),
            1,
            'File operations must be disabled while a connection form is open'
          )
        }
        await control.command('clickWhenEnabled', '[data-testid="provider-editor-cancel"]')

        await writeFile(path, 'version: [')
        await control.command('clickWhenEnabled', reload)
        await control.command('waitFor', '[data-testid="provider-settings-error"]')
        await control.command('waitFor', row, { text: 'Externally edited provider' })
        assert.equal(
          Number(await control.command('getElementCount', `${open}:enabled`)),
          1,
          'The invalid file must remain available for repair'
        )

        await writeFile(path, source.replace('File provider', 'Repaired provider'))
        await control.command('clickWhenEnabled', reload)
        await control.command('waitFor', row, { text: 'Repaired provider' })
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid="provider-settings-error"]')
          ),
          0,
          'Reloading repaired YAML must clear the error'
        )
      } finally {
        await writeFile(path, source)
      }
    },
  }
}
