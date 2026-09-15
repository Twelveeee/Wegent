import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import identityModule from '../electron/scripts/build-identity.cjs'
import { prepareDesktopBrandConfig } from './prepare-desktop-brand-config.mjs'

test('preserves optional branding using the existing identity parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-brand-test-'))
  try {
    assert.equal(await prepareDesktopBrandConfig('', directory), null)
    const configuration = {
      productName: 'Example WeWork',
      identifier: 'com.example.wework',
      backendUrl: 'https://example.com/api',
    }
    const path = await prepareDesktopBrandConfig(JSON.stringify(configuration), directory)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), configuration)
    const identity = identityModule.resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })
    assert.equal(identity.identifier, configuration.identifier)
    assert.equal(identity.backendUrl, configuration.backendUrl)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects malformed branding and credentials in service URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-brand-test-'))
  try {
    await assert.rejects(prepareDesktopBrandConfig('{', directory), SyntaxError)
    await assert.rejects(prepareDesktopBrandConfig('{}', directory), /missing productName/)
    await assert.rejects(
      prepareDesktopBrandConfig(
        JSON.stringify({
          productName: 'Example',
          identifier: 'com.example',
          backendUrl: 'https://user:password@example.com',
        }),
        directory
      ),
      /may not contain credentials/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
