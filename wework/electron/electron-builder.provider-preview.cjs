// Personal preview: no publication, no Apple account credentials required.
const base = require('./electron-builder.config.cjs')
module.exports = {
  ...base,
  publish: null,
  beforePack: async context => {
    const { prepareProviderPreview } = await import('./scripts/prepare-provider-preview.mjs')
    await prepareProviderPreview(context)
  },
  afterSign: async context => {
    const { verifyProviderPreview } = await import('./scripts/prepare-provider-preview.mjs')
    await verifyProviderPreview(context)
  },
  extraMetadata: {
    ...base.extraMetadata,
    weworkUpdateBaseUrl:
      'https://github.com/Twelveeee/Wegent/releases/download/wework-provider-preview',
  },
  mac: {
    ...base.mac,
    identity: '-',
    notarize: false,
    // These components were signed and hashed before packing. Do not mutate them again.
    signIgnore: [
      '/Contents/Resources/harness-runtime/',
      '/Contents/Resources/bin/',
      '/Contents/Resources/codex/',
      '/Contents/Resources/wework-core-plugins/',
      '/Contents/Resources/wework-app-static/',
      '/Contents/Resources/bundled-plugins/',
    ],
  },
}
