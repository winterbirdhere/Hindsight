const { merge } = require("webpack-merge");

// A bit of a hack since nx/web executors use target: 'web'
//https://github.com/nrwl/nx/blob/master/packages/web/src/utils/config.ts
module.exports = (config, context) => {
  return merge(config, {
    // overwrite values here
    target: "electron-renderer",
    // Webpack's worker runtime otherwise defaults its chunk registry to
    // `global`, which is absent in a real browser WorkerGlobalScope.
    output: { globalObject: "globalThis" },
    externals: {
      // https://github.com/yan-foto/electron-reload/issues/71#issuecomment-588988382
      fsevents: "require('fsevents')"
    }
  });
};
