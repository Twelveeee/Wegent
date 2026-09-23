// Personal preview: no publication, no Apple account credentials required.
const base = require('./electron-builder.config.cjs')
module.exports = {
  ...base,
  publish: null,
  extraMetadata: {
    ...base.extraMetadata,
    weworkUpdateBaseUrl:
      'https://github.com/Twelveeee/Wegent/releases/download/wework-provider-preview',
  },
  mac: { ...base.mac, identity: '-', notarize: false },
}
