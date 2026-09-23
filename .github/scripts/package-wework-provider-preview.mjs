import { execFileSync } from 'node:child_process'
import { open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hashComponentPath } from '../../wework/scripts/lib/component-content-hash.mjs'

// Preview builds use ad-hoc signatures, never a release certificate or updater channel.
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This preview must be packaged on a native macOS arm64 runner')
}
const resources = resolve('wework/electron/resources')
const manifestPath = join(resources, 'components.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const magic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])
async function signTree(path) {
  const { stat } = await import('node:fs/promises')
  if ((await stat(path)).isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) await signTree(join(path, entry.name))
    }
    return
  }
  const handle = await open(path, 'r')
  let native = false
  try { const buffer = Buffer.alloc(4); const { bytesRead } = await handle.read(buffer, 0, 4, 0); native = bytesRead === 4 && magic.has(buffer.readUInt32BE(0)) }
  finally { await handle.close() }
  if (native) {
    execFileSync('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', path], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'inherit' })
  }
}
for (const component of Object.values(manifest.components)) {
  if (!component.path) continue
  await signTree(join(resources, component.path))
  component.sha256 = await hashComponentPath(join(resources, component.path))
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
execFileSync('pnpm', ['--dir', 'wework/electron', 'exec', 'electron-builder', '--config', 'electron-builder.config.cjs', '--mac', '--arm64', '--publish', 'never', '--config.mac.identity=-'], {
  stdio: 'inherit',
  env: { ...process.env, APPLE_SIGNING_IDENTITY: '-', CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
})
