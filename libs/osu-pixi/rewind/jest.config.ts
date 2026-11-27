/* eslint-disable */
export default {
  displayName: "osu-pixi-rewind",
  preset: "../../../jest.preset.js",
  transform: {
    "^.+\\.[tj]sx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
  coverageDirectory: "../../../coverage/libs/osu-pixi/rewind",
};
