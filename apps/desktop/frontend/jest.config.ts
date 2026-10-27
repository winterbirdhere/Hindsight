/* eslint-disable */
export default {
  displayName: "frontend",
  preset: "../../../jest.preset.js",
  transform: {
    "^(?!.*\\.([cm]?[jt]sx?|css|json)$)": "<rootDir>/../../../tools/maintenance/jest-asset-transformer.cjs",
    "^.+\\.[tj]sx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
  coverageDirectory: "../../../coverage/apps/frontend",
};
