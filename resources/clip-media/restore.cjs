"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const lockSha256 = "ed9465bb93d3a864e1579a91a4a9fb50e08bd28173716f9bcacc3fc3d723d9fc";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function regularFile(file, expectedSize, expectedHash) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || (expectedSize !== undefined && stat.size !== expectedSize)) {
    throw new Error(`Unexpected type or size: ${path.basename(file)}`);
  }
  const bytes = await fs.readFile(file);
  if (hash(bytes) !== expectedHash) throw new Error(`SHA-256 mismatch: ${path.basename(file)}`);
  return bytes;
}

async function classify(destination, files) {
  let stat;
  try {
    stat = await fs.lstat(destination);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Destination must be a real directory.");
  const entries = await fs.readdir(destination, { withFileTypes: true });
  if (entries.length === 0) return "empty";
  const actual = new Set(entries.map((entry) => entry.name));
  const unexpected = entries.find((entry) => !entry.isFile() || !files.has(entry.name));
  if (unexpected) throw new Error(`Unexpected destination entry: ${unexpected.name}`);
  for (const [name, spec] of files) {
    if (!actual.has(name)) throw new Error(`Missing destination file: ${name}`);
    await regularFile(path.join(destination, name), spec.bytes, spec.sha256);
  }
  return "verified";
}

async function download(url, maxBytes, sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Publisher returned HTTP ${response.status} for ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Download exceeds pinned limit: ${url}`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (hash(bytes) !== sha256) throw new Error(`Download SHA-256 mismatch: ${url}`);
  return bytes;
}

async function restore(destinationArg, cacheArg) {
  if (process.platform !== "win32") throw new Error("This restore kit targets Windows.");
  const lockFile = path.join(__dirname, "runtime-lock.json");
  // Text checkouts may use CRLF. The pin covers the LF form of the public JSON.
  const lockText = (await fs.readFile(lockFile, "utf8")).replace(/\r\n/g, "\n");
  if (hash(lockText) !== lockSha256) throw new Error("Runtime lock SHA-256 mismatch.");
  const lock = JSON.parse(lockText);
  const files = new Map();
  for (const pkg of lock.packages) {
    for (const file of pkg.files) files.set(file.name, file);
  }
  const destination = path.resolve(destinationArg);
  const parent = path.dirname(destination);
  if (destination === parent) throw new Error("Choose a payload directory below a filesystem root.");
  if ((await classify(destination, files)) === "verified") {
    console.log(`Verified ${files.size} existing runtime files.`);
    return;
  }
  // Require an existing parent so a misspelled path cannot create a directory chain.
  const realParent = await fs.realpath(parent);
  const tar = path.join(process.env.SystemRoot, "System32", "tar.exe");
  const version = spawnSync(tar, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (version.status !== 0 || !/libzstd/i.test(version.stdout || "")) {
    throw new Error("Windows System32 tar.exe with libzstd support is required for a cold restore.");
  }
  const cache = cacheArg && path.resolve(cacheArg);
  const stagePrefix = path.join(realParent, ".hindsight-ffmpeg-");
  const stage = await fs.mkdtemp(stagePrefix);
  try {
    for (const pkg of lock.packages) {
      // The signature and archive hashes lock the pair previously verified with the MSYS2 key.
      const signature = pkg.name + ".sig";
      if (cache) await regularFile(path.join(cache, signature), undefined, pkg.signatureSha256);
      else await download(lock.publisher + signature, 16_384, pkg.signatureSha256);
      const archive = cache
        ? await regularFile(path.join(cache, pkg.name), pkg.bytes, pkg.sha256)
        : await download(lock.publisher + pkg.name, pkg.bytes, pkg.sha256);
      if (archive.length !== pkg.bytes) throw new Error(`Archive size mismatch: ${pkg.name}`);
      for (const file of pkg.files) {
        // Send the verified archive bytes through stdin and extract only this exact member to stdout.
        // No archive-controlled filename, symlink or directory can reach the filesystem.
        const extracted = spawnSync(tar, ["-xOf", "-", lock.archiveMemberDirectory + file.name], {
          input: archive, maxBuffer: file.bytes + 65_536, windowsHide: true, timeout: 45_000,
        });
        if (extracted.error || extracted.status !== 0 ||
            extracted.stdout.length !== file.bytes || hash(extracted.stdout) !== file.sha256) {
          throw new Error(`Cannot verify ${pkg.name} member ${file.name}.`);
        }
        await fs.writeFile(path.join(stage, file.name), extracted.stdout, { flag: "wx" });
      }
    }
    if ((await classify(stage, files)) !== "verified") throw new Error("The staged payload is incomplete.");
    // Recheck before publishing. rmdir only ever accepts an empty directory.
    const current = await classify(destination, files);
    if (current !== "verified") {
      if (current === "empty") await fs.rmdir(destination);
      try {
        await fs.rename(stage, destination);
      } catch (error) {
        if (current === "empty") {
          await fs.mkdir(destination).catch((failure) => { if (failure.code !== "EEXIST") throw failure; });
        }
        if ((await classify(destination, files)) !== "verified") throw error;
      }
    }
    console.log(`Restored and verified ${files.size} runtime files from ${lock.packages.length} packages.`);
  } finally {
    // Only the unique sibling this invocation created is eligible for cleanup.
    if (path.dirname(stage) !== realParent || !stage.startsWith(stagePrefix)) throw new Error("Invalid stage path.");
    await fs.rm(stage, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error("Usage: node restore.cjs DESTINATION [OFFLINE-PACKAGE-CACHE]");
  process.exitCode = 2;
} else {
  restore(...args).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
