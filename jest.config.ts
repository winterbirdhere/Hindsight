import { readFileSync } from "node:fs";

const workspace = JSON.parse(readFileSync(new URL("./workspace.json", import.meta.url), "utf8"));

export default {
  projects: Object.keys(workspace.projects)
    .map((name) => workspace.projects[name].targets?.test?.options?.jestConfig)
    .filter(Boolean)
    .map((config) => `<rootDir>/${config}`),
};
