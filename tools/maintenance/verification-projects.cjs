// SPDX-License-Identifier: MIT
const path = require("node:path");
const root = path.resolve(__dirname, "../..");

const desktopProjects = [
  "desktop-frontend",
  "desktop-main",
  "osu-core",
  "osu-math",
  "osu-skin",
  "osu-local-db-reader",
  "osu-local-gosumemory",
  "osu-local-osr-reader",
  "osu-local-skin-reader",
  "osu-local-utils",
  "osu-pixi-classic-components",
  "osu-pixi-rewind",
];
const legacyProjects = ["osu-pp", "tests-game-simulation", "web-backend", "osu-stable-test-generator"];

function jestConfig(projects) {
  const workspace = require(path.join(root, "workspace.json"));
  return {
    rootDir: root,
    projects: projects.map((project) => {
      const config = workspace.projects[project]?.targets?.test?.options?.jestConfig;
      if (!config) throw new Error(`No Jest configuration is registered for ${project}.`);
      return path.join(root, config);
    }),
  };
}

module.exports = { desktopProjects, legacyProjects, jestConfig };
