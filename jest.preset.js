const { pathsToModuleNameMapper } = require("ts-jest");
const { compilerOptions } = require("./tsconfig.base.json");

// Tests run directly with modern Jest; Nx remains responsible for the existing build pipeline.
module.exports = {
  testMatch: ["**/+(*.)+(spec|test).+(ts|js)?(x)"],
  moduleFileExtensions: ["ts", "js", "mjs", "html"],
  coverageReporters: ["html"],
  testEnvironment: "jsdom",
  moduleNameMapper: {
    ...pathsToModuleNameMapper(compilerOptions.paths, { prefix: `${__dirname.replace(/\\/g, "/")}/` }),
    "^electron$": require.resolve("./tools/maintenance/jest-electron-mock.cjs"),
    "\\.(css|scss|sass|less|styl)$": require.resolve("./tools/maintenance/jest-style-mock.cjs"),
  },
};
