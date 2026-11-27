'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash, json, ordinary } = require('../release/common.cjs');
const distribution = require('./distribution-files.json');

const media = 'resources/clip-media/';
const notices = 'resources/third-party-notices/ffmpeg/';

function exactEntries(root, relative, names) {
  const directory = path.join(root, relative);
  ordinary(root, directory);
  assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort(), 'Unexpected or missing file in ' + relative);
}

// Both the source packager and the installed-package checker use the same reviewed bytes.
function verifyMedia(root, source = false) {
  root = path.resolve(root);
  function checked(relative, sha256, bytes) {
    const file = path.join(root, relative);
    ordinary(root, file);
    const stat = fs.lstatSync(file);
    assert(stat.isFile(), 'Expected a regular file: ' + relative);
    if (bytes !== undefined) assert.equal(stat.size, bytes, 'Size mismatch: ' + relative);
    assert.equal(hash(file), sha256, 'SHA-256 mismatch: ' + relative);
    return { file: relative, bytes: stat.size, sha256 };
  }

  const metadataFiles = ['runtime.json', 'runtime-lock.json', 'README.md'];
  exactEntries(root, media, [...metadataFiles, 'win-x64', ...(source ? ['restore.cjs'] : [])]);
  const noticeNames = Object.keys(distribution).filter(name => name.startsWith(notices)).map(name => name.slice(notices.length));
  exactEntries(root, notices, noticeNames);
  const rows = Object.entries(distribution).map(([file, digest]) => checked(file, digest));
  const manifest = json(path.join(root, media, 'runtime.json'));
  const lock = json(path.join(root, media, 'runtime-lock.json'));
  assert.equal(manifest.runtimeLockSha256, distribution[media + 'runtime-lock.json']);
  const binaries = lock.packages.flatMap(pkg => pkg.files);
  exactEntries(root, media + 'win-x64', binaries.map(file => file.name));
  for (const { name, sha256, bytes } of binaries) rows.push(checked(media + 'win-x64/' + name, sha256, bytes));
  const executable = rows.find(row => row.file === media + manifest.executable);
  assert.equal(executable?.sha256, manifest.executableSha256);
  assert.equal(executable.bytes, manifest.executableBytes);
  return { manifest, rows };
}

module.exports = { verifyMedia };

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: node tools/media/verify-runtime.cjs WINDOWS-PACKAGE-DIRECTORY');
    process.exitCode = 2;
  } else {
    try {
      const { rows } = verifyMedia(process.argv[2]);
      console.log('Verified ' + rows.length + ' encoder binaries, metadata and notice files.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
