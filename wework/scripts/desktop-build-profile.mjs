#!/usr/bin/env node

import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASE_TARGETS = [
  {
    name: 'macOS arm64',
    runner: 'macos-14',
    platform: 'macos',
    arch: 'arm64',
    node_arch: 'arm64',
    cargo_target: 'aarch64-apple-darwin',
    codex_target: 'aarch64-apple-darwin',
  },
  {
    name: 'macOS x64',
    runner: 'macos-14',
    platform: 'macos',
    arch: 'x64',
    node_arch: 'x64',
    cargo_target: 'x86_64-apple-darwin',
    codex_target: 'x86_64-apple-darwin',
  },
  {
    name: 'Windows x64',
    runner: 'windows-latest',
    platform: 'windows',
    arch: 'x64',
    node_arch: 'x64',
    cargo_target: 'x86_64-pc-windows-msvc',
    codex_target: 'x86_64-pc-windows-msvc',
  },
  {
    name: 'Linux x64',
    runner: 'ubuntu-latest',
    platform: 'linux',
    arch: 'x64',
    node_arch: 'x64',
    cargo_target: 'x86_64-unknown-linux-gnu',
    codex_target: 'x86_64-unknown-linux-gnu',
  },
]

export function resolveDesktopBuildProfile(profile = 'release', publishRelease = false) {
  if (!['release', 'macos-arm64-test'].includes(profile)) {
    throw new Error(`Unsupported desktop build profile: ${profile}`)
  }
  const testBuild = profile === 'macos-arm64-test'
  if (testBuild && publishRelease) {
    throw new Error('macos-arm64-test cannot publish releases or update channels')
  }
  const targets = testBuild ? RELEASE_TARGETS.slice(0, 1) : RELEASE_TARGETS
  return { testBuild, matrix: { include: targets.map(target => ({ ...target })) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const profile = resolveDesktopBuildProfile(
    process.env.INPUT_BUILD_PROFILE || 'release',
    process.env.PUBLISH_RELEASE === 'true'
  )
  const output = `test_build=${profile.testBuild}\nbuild_matrix=${JSON.stringify(profile.matrix)}\n`
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
}
