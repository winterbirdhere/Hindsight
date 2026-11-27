const { basename, extname } = require("path");

module.exports = {
  process(_source, filename) {
    const assetName = JSON.stringify(basename(filename));
    if (extname(filename).toLowerCase() === ".svg") {
      return {
        code: `const React = require("react");
module.exports = {
  __esModule: true,
  default: ${assetName},
  ReactComponent: React.forwardRef(function SvgAsset(props, ref) {
    return React.createElement("svg", { ...props, ref }, ${assetName});
  }),
};`,
      };
    }
    return { code: `module.exports = ${assetName};` };
  },
};
