import { describe, expect, test, vi } from 'vitest'

import { buildRelease, releaseBuildEnvironments } from './build-release.mjs'

describe('desktop release builds', () => {
  test('builds only an ad-hoc signed ARM DMG in test mode', async () => {
    const runBuild = vi.fn().mockResolvedValue(undefined)
    await buildRelease(
      {
        WEWORK_BUILD_PROFILE: 'macos-arm64-test',
        WEWORK_RELEASE_PLATFORM: 'macos',
        WEWORK_RELEASE_ARCH: 'arm64',
        WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'false',
      },
      runBuild
    )
    expect(runBuild).toHaveBeenCalledTimes(1)
    expect(runBuild.mock.calls[0][1]).toEqual([
      'exec',
      'electron-builder',
      '--config',
      'electron-builder.config.cjs',
      '--mac',
      'dmg',
      '--arm64',
      '--publish',
      'never',
      '--config.mac.identity=-',
      '--config.mac.notarize=false',
    ])
    expect(runBuild.mock.calls[0][3]).toEqual({})
  })

  test('rejects non-ARM targets in test mode before running the builder', async () => {
    const runBuild = vi.fn()
    await expect(
      buildRelease(
        {
          WEWORK_BUILD_PROFILE: 'macos-arm64-test',
          WEWORK_RELEASE_PLATFORM: 'macos',
          WEWORK_RELEASE_ARCH: 'x64',
        },
        runBuild
      )
    ).rejects.toThrow('requires a macOS arm64 build')
    expect(runBuild).not.toHaveBeenCalled()
  })

  test('does not build an unused host update before componentized updates are active', () => {
    expect(
      releaseBuildEnvironments({
        WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'true',
      })
    ).toEqual([{}])
  })

  test('preserves both release artifacts for local builds without workflow planning', () => {
    expect(releaseBuildEnvironments({})).toEqual([{}, { WEWORK_ONLINE_UPDATE_BUILD: 'true' }])
  })

  test('builds installer and componentized host update in parallel', async () => {
    let releaseFirstBuild = () => {}
    const firstBuild = new Promise(resolve => {
      releaseFirstBuild = resolve
    })
    const runBuild = vi.fn().mockReturnValueOnce(firstBuild).mockResolvedValueOnce(undefined)

    const build = buildRelease(
      {
        WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'false',
        WEWORK_RELEASE_ARCH: 'arm64',
        WEWORK_RELEASE_PLATFORM: 'macos',
      },
      runBuild
    )

    await vi.waitFor(() => expect(runBuild).toHaveBeenCalledTimes(2))
    expect(runBuild.mock.calls.map(call => call[3])).toEqual([
      {},
      { WEWORK_ONLINE_UPDATE_BUILD: 'true' },
    ])
    expect(runBuild.mock.calls[0][1]).not.toContain('--config.mac.identity=-')
    expect(runBuild.mock.calls[0][1]).not.toContain('dmg')
    releaseFirstBuild()
    await build
  })
})
