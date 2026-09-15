import { describe, expect, test } from 'vitest'

import {
  SIGNED_COMPONENT_POLICY_VERSION,
  resolveComponentSigningIdentity,
  signedComponentCodesignArguments,
} from './prepare-signed-components.mjs'

describe('signed component codesign arguments', () => {
  test('test builds use ad-hoc signing before component checksums are finalized', () => {
    expect(
      resolveComponentSigningIdentity({
        WEWORK_BUILD_PROFILE: 'macos-arm64-test',
        APPLE_SIGNING_IDENTITY: 'unused-test-identity',
      })
    ).toBe('-')
    expect(signedComponentCodesignArguments('-', '/tmp/component')).not.toContain('--timestamp')
    expect(signedComponentCodesignArguments('-', '/tmp/component')).toContain('runtime')
  })
  test('preserves entitlements required by nested runtimes', () => {
    expect(
      signedComponentCodesignArguments('Developer ID Application: Example', '/tmp/component')
    ).toEqual([
      '--force',
      '--sign',
      'Developer ID Application: Example',
      '--timestamp',
      '--options',
      'runtime',
      '--preserve-metadata=entitlements',
      '/tmp/component',
    ])
  })

  test('invalidates signed component caches created without preserved entitlements', () => {
    expect(SIGNED_COMPONENT_POLICY_VERSION).toBe(2)
  })
})
