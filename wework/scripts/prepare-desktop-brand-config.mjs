#!/usr/bin/env node

import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import identityModule from '../electron/scripts/build-identity.cjs'

export async function prepareDesktopBrandConfig(json, temporaryDirectory) {
  if (!json?.trim()) return null
  const config = JSON.parse(json)
  const path = join(temporaryDirectory, 'wework-build-brand.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  identityModule.resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = await prepareDesktopBrandConfig(
    process.env.INPUT_BRAND_CONFIG_JSON,
    process.env.RUNNER_TEMP
  )
  if (path) await appendFile(process.env.GITHUB_ENV, `WEWORK_BRAND_CONFIG=${path}\n`)
}
