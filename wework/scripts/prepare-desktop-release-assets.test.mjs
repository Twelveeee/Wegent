import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const scriptsRoot = dirname(fileURLToPath(import.meta.url))

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'wework-test-assets-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  await mkdir(join(root, 'electron/release-installer'), { recursive: true })
  await symlink(resolve(scriptsRoot, '../node_modules'), join(root, 'node_modules'), 'junction')
  for (const name of [
    'prepare-desktop-release-assets.mjs',
    'desktop-build-profile.mjs',
    'desktop-component-release.mjs',
    'lib/component-content-hash.mjs',
  ]) {
    await cp(join(scriptsRoot, name), join(root, 'scripts', name))
  }
  return root
}

for (const includeUnusedZip of [false, true]) {
  test(`ARM test assets contain only a DMG and its checksum ${includeUnusedZip ? 'when an unused ZIP exists' : 'without building a ZIP'}`, async context => {
    const root = await createFixture(context)
    const dmg = 'WeWork_1.2.3_macos_arm64.dmg'
    const unusedZip = 'WeWork_1.2.3_macos_arm64.zip'
    for (const name of [dmg, ...(includeUnusedZip ? [unusedZip, `${unusedZip}.blockmap`] : [])]) {
      await writeFile(join(root, 'electron/release-installer', name), `fixture:${name}`)
    }
    const output = join(root, 'artifacts')

    await execute(
      process.execPath,
      [join(root, 'scripts/prepare-desktop-release-assets.mjs'), 'macos', 'arm64', '1.2.3', output],
      {
        env: {
          ...process.env,
          WEWORK_BUILD_PROFILE: 'macos-arm64-test',
          WEWORK_USE_COMPONENTIZED_HOST_UPDATE: 'true',
        },
      }
    )

    assert.deepEqual((await readdir(output)).sort(), ['SHA256SUMS.txt', dmg])
    const checksums = await readFile(join(output, 'SHA256SUMS.txt'), 'utf8')
    const contents = await readFile(join(output, dmg))
    assert.equal(contents.toString(), `fixture:${dmg}`)
    const hash = createHash('sha256').update(contents).digest('hex')
    assert.equal(checksums, `${hash}  ${dmg}\n`)
  })
}

test('ARM test asset preparation rejects other architectures before changing output', async context => {
  const root = await createFixture(context)
  const output = join(root, 'artifacts')
  await mkdir(output)
  await writeFile(join(output, 'keep.txt'), 'existing output')

  await assert.rejects(
    execute(
      process.execPath,
      [join(root, 'scripts/prepare-desktop-release-assets.mjs'), 'macos', 'x64', '1.2.3', output],
      { env: { ...process.env, WEWORK_BUILD_PROFILE: 'macos-arm64-test' } }
    ),
    /macos-arm64-test assets require macOS arm64/
  )
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'existing output')
})
