const rootMain = require("../../../../.storybook/main");

module.exports = {
  ...rootMain,
  core: { builder: "webpack5" },
  // The inherited TypeScript docgen plugin uses compiler APIs removed in TS 5.
  // Babel's docgen parser keeps prop extraction without changing the app compiler.
  typescript: { reactDocgen: "react-docgen" },
  stories: ["../src/**/*.stories.mdx", "../src/**/*.stories.@(js|jsx|ts|tsx)"],
};
