'use strict';

const { verifyMedia } = require('./verify-runtime.cjs');
const applyBranding = require('../release/windows-branding.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') verifyMedia(context.appOutDir);
  await applyBranding(context);
};
