// SPDX-License-Identifier: MIT
// Keep the default checks focused on the desktop app and its shared libraries.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { desktopProjects, legacyProjects } = require("./verification-projects.cjs");

const root = path.resolve(__dirname, "../..");
const typecheckConfigs = [
  "apps/desktop/frontend/tsconfig.app.json",
  "apps/desktop/frontend/tsconfig.spec.json",
  "apps/desktop/main/tsconfig.app.json",
  "apps/desktop/main/tsconfig.spec.json",
];

const [mode = "all", ...options] = process.argv.slice(2);
const listOnly = options.includes("--list");
const forwarded = options.filter((option) => option !== "--list");
const nx = path.join(root, "node_modules/nx/bin/nx.js");
const jest = path.join(root, "node_modules/jest/bin/jest.js");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const tasks = [];

function projectChecks(target, projects) {
  if (target === "test") {
    const config = path.join(__dirname, projects === legacyProjects ? "jest.legacy.config.cjs" : "jest.desktop.config.cjs");
    tasks.push({
      name: `test: ${projects.join(", ")}`,
      // Do not load the Nx 14 Jest executor, which embeds its own Jest 27 tools.
      // A file also avoids Jest applying CLI inline JSON to every child project.
      args: [jest, "--config", config, "--runInBand", ...forwarded],
    });
    return;
  }
  tasks.push({
    name: `${target}: ${projects.join(", ")}`,
    args: [
      nx,
      "run-many",
      `--target=${target}`,
      `--projects=${projects.join(",")}`,
      "--skip-nx-cache",
      ...forwarded,
    ],
  });
}

if (!["all", "test", "lint", "typecheck", "legacy-tests"].includes(mode)) {
  console.error("Usage: node tools/maintenance/verify-workspace.cjs <all|test|lint|typecheck|legacy-tests> [--list] [tool options]");
  process.exit(2);
}
if (mode === "all" && forwarded.length) {
  console.error("Pass tool-specific options to test, lint, or typecheck, rather than all.");
  process.exit(2);
}
if (mode === "all" || mode === "typecheck") {
  for (const config of typecheckConfigs) {
    tasks.push({ name: `typecheck: ${config}`, args: [tsc, "--noEmit", "--project", config, ...forwarded] });
  }
}
if (mode === "all" || mode === "lint") projectChecks("lint", desktopProjects);
if (mode === "all" || mode === "test") projectChecks("test", desktopProjects);
if (mode === "legacy-tests") projectChecks("test", legacyProjects);

if (listOnly) {
  console.log(JSON.stringify(tasks, null, 2));
  process.exit(0);
}

let failed = false;
for (const task of tasks) {
  console.log(`\n${task.name}`);
  const child = spawnSync(process.execPath, task.args, { cwd: root, stdio: "inherit" });
  if (child.error) console.error(child.error.message);
  if (child.error || child.status !== 0) failed = true;
  if (child.signal) {
    console.error(`Verification interrupted by ${child.signal}.`);
    process.exit(1);
  }
}
process.exit(failed ? 1 : 0);
