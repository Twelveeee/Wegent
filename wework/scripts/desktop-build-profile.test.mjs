import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDesktopBuildProfile } from './desktop-build-profile.mjs'

test('release profile preserves the four native build targets', () => {
  const profile = resolveDesktopBuildProfile()
  assert.equal(profile.testBuild, false)
  assert.deepEqual(
    profile.matrix.include.map(({ platform, arch }) => `${platform}-${arch}`),
    ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64']
  )
  assert.deepEqual(resolveDesktopBuildProfile('release', true), profile)
})

test('ARM test profile includes only the native macOS ARM runner', () => {
  const profile = resolveDesktopBuildProfile('macos-arm64-test')
  assert.equal(profile.testBuild, true)
  assert.equal(profile.matrix.include.length, 1)
  assert.deepEqual(profile.matrix.include[0], {
    name: 'macOS arm64',
    runner: 'macos-14',
    platform: 'macos',
    arch: 'arm64',
    node_arch: 'arm64',
    cargo_target: 'aarch64-apple-darwin',
    codex_target: 'aarch64-apple-darwin',
  })
})

test('test builds cannot publish and unknown profiles are rejected', () => {
  assert.throws(() => resolveDesktopBuildProfile('macos-arm64-test', true), /cannot publish/)
  assert.throws(() => resolveDesktopBuildProfile('other'), /Unsupported/)
})
