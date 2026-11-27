// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const DLL = 'hindsight-realm-wrappers.dll';
const MANIFEST = 'hindsight-realm-policy.json';
const BUILD = 'hindsight-realm-build.json';
const licenses = path.resolve(__dirname, '../../../engine/RewindPerformance/licenses/realm-no-conversion');
function ordinary(file) {
  let current = path.resolve(file);
  while (true) {
    assert(!fs.lstatSync(current).isSymbolicLink(), `Reparse/link input forbidden: ${current}`);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  assert(fs.statSync(file).isFile(), `Ordinary file required: ${file}`);
  return fs.readFileSync(file);
}
function verifySource(root = __dirname) {
  const bytes = ordinary(path.join(root, 'SOURCE-PINS.json'));
  const pins = JSON.parse(bytes);
  assert.equal(pins.version, 1, 'Source manifest version');
  const seen = new Set();
  for (const row of pins.files) {
    assert(typeof row.file === 'string' && !path.isAbsolute(row.file) && !row.file.split(/[\\/]/).includes('..') && !seen.has(row.file), 'Invalid source path');
    seen.add(row.file);
    const actual = ordinary(path.join(root, row.file));
    assert.equal(actual.length, row.bytes, `Source size: ${row.file}`);
    assert.equal(sha(actual), row.sha256, `Source hash: ${row.file}`);
  }
  // Extra compiler inputs must not silently enter CMake's globbed source tree.
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      assert(!entry.isSymbolicLink(), 'Source link forbidden');
      if (entry.isDirectory()) walk(child); else assert(seen.has(child), `Unpinned source: ${child}`);
    }
  }
  if (fs.existsSync(path.join(root, 'vendor'))) walk('vendor');
  return { pins, files: seen.size, sha256: sha(bytes) };
}
function exportsOf(bytes) {
  assert(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Native artifact PE header');
  const pe = bytes.readUInt32LE(0x3c);
  assert(pe + 264 < bytes.length && bytes.toString('ascii', pe, pe + 4) === 'PE\0\0', 'Native artifact PE signature');
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Native artifact must be x64');
  const optional = pe + 24, sections = optional + bytes.readUInt16LE(pe + 20);
  assert.equal(bytes.readUInt16LE(optional), 0x20b, 'Native artifact PE32+');
  function offset(rva) {
    for (let i = 0; i < bytes.readUInt16LE(pe + 6); i++) {
      const section = sections + i * 40, start = bytes.readUInt32LE(section + 12);
      const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= start && rva < start + size) {
        const result = bytes.readUInt32LE(section + 20) + rva - start;
        assert(result < bytes.length, 'Native artifact RVA range'); return result;
      }
    }
    throw Error('Native artifact export RVA missing');
  }
  const table = offset(bytes.readUInt32LE(optional + 112));
  const count = bytes.readUInt32LE(table + 24), names = offset(bytes.readUInt32LE(table + 32));
  assert(count > 0 && count < 10000, 'Native artifact export count');
  return Array.from({ length: count }, (_, i) => {
    const start = offset(bytes.readUInt32LE(names + i * 4)), end = bytes.indexOf(0, start);
    assert(end > start && end - start < 512, 'Native artifact export name');
    return bytes.toString('ascii', start, end);
  }).sort();
}
function verifyArtifact(directory, { notices = true } = {}) {
  const source = verifySource();
  const manifest = JSON.parse(ordinary(path.join(directory, MANIFEST)));
  for (const [key, value] of Object.entries({ version: 1, file: DLL, policyVersion: 1, guarantees: 3, realmDotnetVersion: '20.1.0', realmCoreVersion: '20.1.2', sourceSha256: source.sha256 }))
    assert.equal(manifest[key], value, `Native manifest ${key}`);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/, 'Native artifact SHA256');
  const native = ordinary(path.join(directory, DLL));
  assert.equal(sha(native), manifest.sha256, 'Native artifact hash');
  const original = ordinary(path.join(directory, 'realm-wrappers.dll'));
  assert.equal(sha(original), source.pins.originalDllSha256, 'Original Realm DLL must be preserved');
  const expectedExports = [...exportsOf(original), 'shared_realm_enable_no_conversion_policy_v1'].sort();
  assert.deepEqual(exportsOf(native), expectedExports, 'Native artifact policy export/ABI inventory');
  const build = JSON.parse(ordinary(path.join(directory, BUILD)));
  assert.equal(build.version, 1, 'Native build manifest version');
  assert.equal(build.sourceSha256, source.sha256, 'Native build source hash');
  assert.equal(build.artifactSha256, manifest.sha256, 'Native build artifact hash');
  assert.equal(build.artifactBytes, native.length, 'Native build artifact size');
  assert.equal(build.offline, true, 'Native build must be offline');
  assert.equal(build.msbuildNodeReuse, false, 'Native build node reuse');
  assert.equal(build.parallelProjects, 2, 'Native build project bound');
  assert.equal(build.compilerFanout, 1, 'Native build compiler bound');
  assert.equal(build.toolchain?.compiler, 'MSVC 19.44.35222', 'Native compiler identity');
  assert.equal(build.toolchain?.windowsSdk, '10.0.26100.0', 'Native SDK identity');
  assert.equal(build.toolchain?.architecture, 'x64', 'Native architecture identity');
  assert.equal(build.buildScriptSha256, sha(ordinary(path.join(__dirname, 'build.cjs'))), 'Native build script identity');
  assert.equal(build.packageScriptSha256, sha(ordinary(__filename)), 'Native package script identity');
  if (notices) {
    for (const entry of fs.readdirSync(licenses)) {
      const shipped = ordinary(path.join(directory, 'licenses/realm-no-conversion', entry));
      assert.equal(sha(shipped), sha(ordinary(path.join(licenses, entry))), `Native license/notice: ${entry}`);
    }
    const inventory = read(path.join(directory, 'dependency-licenses.json')).packages;
    const entry = inventory.find(item => item.id === 'Hindsight.Realm.NoConversion');
    assert(entry && entry.modified === true && entry.files.includes(DLL), 'Modified native fork license inventory');
  }
  return { manifest, bytes: native.length, originalSha256: sha(original), exports: expectedExports.length };
}
function stageArtifact(binary, directory, build) {
  const source = verifySource();
  for (const name of [DLL, MANIFEST, BUILD]) assert(!fs.existsSync(path.join(directory, name)), `Fresh native stage required; ${name} exists`);
  assert.equal(sha(ordinary(path.join(directory, 'realm-wrappers.dll'))), source.pins.originalDllSha256, 'Original Realm DLL must be preserved');
  const bytes = ordinary(binary), artifactSha256 = sha(bytes);
  assert(exportsOf(bytes).includes('shared_realm_enable_no_conversion_policy_v1'), 'Native artifact policy export missing');
  const manifest = { version: 1, file: DLL, sha256: artifactSha256, policyVersion: 1, guarantees: 3, realmDotnetVersion: '20.1.0', realmCoreVersion: '20.1.2', sourceSha256: source.sha256 };
  fs.copyFileSync(binary, path.join(directory, DLL), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(directory, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(directory, BUILD), JSON.stringify({ ...build, version: 1, sourceSha256: source.sha256, artifactSha256 }, null, 2) + '\n', { flag: 'wx' });
  return verifyArtifact(directory, { notices: false });
}
module.exports = { DLL, MANIFEST, BUILD, licenses, sha, ordinary, verifySource, exportsOf, verifyArtifact, stageArtifact };
if (require.main === module) {
  const [command, directory] = process.argv.slice(2);
  assert(command === 'source' || command === 'package', 'Expected source or package');
  const result = command === 'source' ? verifySource() : verifyArtifact(path.resolve(directory));
  console.log(JSON.stringify(command === 'source' ? { files: result.files, sha256: result.sha256 } : result));
}
