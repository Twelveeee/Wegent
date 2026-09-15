import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveReleaseVersion } from './resolve-release-version.mjs'

describe('resolveReleaseVersion', () => {
  test.each(['0.4.6', '0.4.6-beta.4'])(
    'test builds use checked-in version %s without depending on fork release tags',
    sourceVersion => {
      for (const tags of [[], ['wework-v99.0.0']]) {
        expect(
          resolveReleaseVersion({
            tags,
            sourceVersion,
            buildProfile: 'macos-arm64-test',
            githubRef: 'refs/tags/wework-v1.0.0',
            githubRefName: 'wework-v1.0.0',
          })
        ).toEqual({
          version: sourceVersion,
          channel: sourceVersion.includes('-beta.') ? 'beta' : 'stable',
          releaseTag: `wework-v${sourceVersion}`,
          prerelease: sourceVersion.includes('-beta.'),
          publishRelease: false,
        })
      }
    }
  )

  test('test builds accept an explicit version and reject publication or a missing version', () => {
    const options = { tags: [], buildProfile: 'macos-arm64-test' }
    expect(resolveReleaseVersion({ ...options, inputVersion: 'v1.2.3-beta.1' }).version).toBe(
      '1.2.3-beta.1'
    )
    expect(() => resolveReleaseVersion(options)).toThrow('Invalid stable Wework version')
    expect(() => resolveReleaseVersion({ ...options, publishRelease: true })).toThrow(
      'cannot publish'
    )
  })

  test('the test-build CLI reads its version from the checked-in package', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
    const output = execFileSync(
      process.execPath,
      [resolve(process.cwd(), 'scripts/resolve-release-version.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WEWORK_BUILD_PROFILE: 'macos-arm64-test',
          INPUT_VERSION: '',
          PUBLISH_RELEASE: 'false',
          GITHUB_OUTPUT: '',
        },
      }
    )
    expect(output).toContain(`value=${manifest.version}\n`)
    expect(output).toContain('publish_release=false\n')
  })

  test('starts the next patch Beta without a version input', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.3'],
        inputChannel: 'beta',
        inputVersion: '9.9.9',
      })
    ).toMatchObject({
      version: '1.2.4-beta.1',
      channel: 'beta',
      prerelease: true,
    })
  })

  test('increments the latest Beta number', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.3', 'wework-v1.2.4-beta.2', 'wework-v1.2.4-beta.10'],
        inputChannel: 'beta',
      }).version
    ).toBe('1.2.4-beta.11')
  })

  test('starts a new Beta patch after the matching stable release', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.4-beta.3', 'wework-v1.2.4'],
        inputChannel: 'beta',
      }).version
    ).toBe('1.2.5-beta.1')
  })

  test('supports an optional stable override', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.4'],
        inputChannel: 'stable',
        inputVersion: 'v2.0.0',
      }).version
    ).toBe('2.0.0')
  })

  test('derives a Beta channel when rerunning an existing tag', () => {
    expect(
      resolveReleaseVersion({
        tags: [],
        githubRef: 'refs/tags/wework-v1.3.0-beta.4',
        githubRefName: 'wework-v1.3.0-beta.4',
      })
    ).toEqual({
      version: '1.3.0-beta.4',
      channel: 'beta',
      releaseTag: 'wework-v1.3.0-beta.4',
      prerelease: true,
      publishRelease: true,
    })
  })

  test('rejects an unknown release channel', () => {
    expect(() =>
      resolveReleaseVersion({
        tags: [],
        inputChannel: 'nightly',
      })
    ).toThrow('Invalid Wework release channel')
  })

  test('rejects an invalid stable version override', () => {
    expect(() =>
      resolveReleaseVersion({
        tags: [],
        inputChannel: 'stable',
        inputVersion: '1.2',
      })
    ).toThrow('Invalid stable Wework version')
  })
})
