const fs = require("node:fs");
const path = require("node:path");

const workspace = path.resolve(__dirname, "../..");
const output = path.join(workspace, "dist/apps/desktop");
const metadata = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8"));

if (!fs.existsSync(path.join(output, "index.js"))) {
  throw new Error("Desktop main process is not compiled. Run npm run desktop-main:dev.");
}

// Launching a bare JavaScript file makes Electron use its own name and version.
// A local app directory supplies Hindsight's metadata without building an EXE.
fs.writeFileSync(
  path.join(output, "package.json"),
  JSON.stringify({ name: metadata.name, productName: metadata.productName, version: metadata.version, private: true, main: "index.js" }, null, 2) + "\n",
);
console.log(`Prepared ${metadata.name} ${metadata.version} for source development.`);
