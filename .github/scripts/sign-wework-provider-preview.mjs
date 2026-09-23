import { execFileSync } from 'node:child_process'
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hashComponentPath } from '../../wework/scripts/lib/component-content-hash.mjs'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Provider preview packaging requires native macOS arm64')
}
const resources = resolve('wework/electron/resources')
const path = join(resources, 'components.json')
const manifest = JSON.parse(await readFile(path, 'utf8'))
const magic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])
async function signTree(path) {
  if ((await stat(path)).isDirectory()) {
    for (const name of (await readdir(path)).sort()) await signTree(join(path, name))
    return
  }
  const handle = await open(path, 'r')
  let executable = false
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buffer, 0, 4, 0)
    executable = bytesRead === 4 && magic.has(buffer.readUInt32BE(0))
  } finally {
    await handle.close()
  }
  if (!executable) return
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--preserve-metadata=entitlements', path], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'inherit' })
}
for (const component of Object.values(manifest.components)) {
  if (!component.path) continue
  const directory = join(resources, component.path)
  await signTree(directory)
  component.sha256 = await hashComponentPath(directory)
}
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
console.log('Prepared ad-hoc-signed preview components; this is not a notarized release.')
