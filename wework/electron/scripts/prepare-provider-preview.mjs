import { execFile } from 'node:child_process'
import { open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { hashComponentPath } from '../../scripts/lib/component-content-hash.mjs'

const execute = promisify(execFile)
const electronRoot = fileURLToPath(new URL('../', import.meta.url))
const resources = join(electronRoot, 'resources')
const magicNumbers = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
])

async function machOFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await machOFiles(path)))
    else if (entry.isFile()) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(4)
        const { bytesRead } = await handle.read(buffer, 0, 4, 0)
        if (bytesRead === 4 && magicNumbers.has(buffer.readUInt32BE(0))) files.push(path)
      } finally {
        await handle.close()
      }
    }
  }
  return files
}

// Component hashes must describe the signed bytes copied into the installer.
// Signing is preview-only and never requires an Apple account or timestamp server.
export async function prepareProviderPreview(context) {
  if (context.electronPlatformName !== 'darwin') throw new Error('Provider preview requires macOS')
  for (const path of await machOFiles(resources)) {
    await execute('codesign', [
      '--force',
      '--sign',
      '-',
      '--timestamp=none',
      '--options',
      'runtime',
      '--preserve-metadata=entitlements',
      path,
    ])
    await execute('codesign', ['--verify', '--strict', path])
  }
  const manifestPath = join(resources, 'components.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const component of Object.values(manifest.components)) {
    if (component.path) component.sha256 = await hashComponentPath(join(resources, component.path))
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function verifyProviderPreview(context) {
  const app = resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const packed = join(app, 'Contents', 'Resources')
  const manifest = JSON.parse(await readFile(join(packed, 'components.json'), 'utf8'))
  for (const [id, component] of Object.entries(manifest.components)) {
    if (!component.path) continue
    if (component.sha256 !== (await hashComponentPath(join(packed, component.path)))) {
      throw new Error(`Packaged component integrity mismatch: ${id}`)
    }
  }
  await execute('codesign', ['--verify', '--deep', '--strict', app])
}
