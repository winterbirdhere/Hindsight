// SPDX-License-Identifier: MIT
// Local-only Windows/x64 build. No restore, bootstrap, npx, tool install or download.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { sha, ordinary, verifySource, stageArtifact } = require('./package.cjs');
const options = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, all) => i % 2 ? rows : [...rows, [value, all[i + 1]]], []));
assert(process.platform === 'win32' && process.arch === 'x64', 'Installed Windows x64 toolchain required');
assert(options['--output'] && Object.keys(options).every(key => ['--output', '--stage', '--cmake'].includes(key)), 'Expected --output fresh-directory [--stage publish-directory] [--cmake installed-cmake.exe]');
const root = path.resolve(__dirname, '../../..'), output = path.resolve(options['--output']);
assert(output.startsWith(root + path.sep) && !output.startsWith(__dirname + path.sep), 'Fresh build output must be within workspace, outside maintained sources');
assert(!fs.existsSync(output), 'Fresh build output required; no replacement');
let ancestor = path.dirname(output);
while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
ordinary(path.join(root, 'package.json'));
let probe = ancestor;
while (true) { assert(!fs.lstatSync(probe).isSymbolicLink(), 'Build output reparse point forbidden'); const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
const cmake = options['--cmake'] || path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
const cmakeHash = sha(ordinary(cmake));
const source = verifySource();
const version = spawnSync(cmake, ['--version'], { encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0, 'Installed CMake version check');
assert(version.stdout.startsWith('cmake version 3.31.6-msvc6'), 'Qualified installed CMake 3.31.6-msvc6 required');
assert(!process.env.CL && !process.env._CL_, 'Unexpected compiler overrides; use a clean build environment');
fs.mkdirSync(output, { recursive: true });
const build = path.join(output, 'cmake');
const wrapperSource = path.join(__dirname, 'vendor', 'wrappers');
// MSVC 19.44 requires deterministic mode for /pathmap. Keep assertion file
// names and line numbers, including those produced in included headers.
const compilerOptions = ['/MP1', '/experimental:deterministic', `"/pathmap:${wrapperSource}=realm-src"`, `"/pathmap:${build}=realm-build"`];
const startedUtc = new Date().toISOString(), env = { ...process.env, _CL_: compilerOptions.join(' '), MSBUILDDISABLENODEREUSE: '1', CMAKE_BUILD_PARALLEL_LEVEL: '2' };
function run(name, args) {
  const fd = fs.openSync(path.join(output, `${name}.log`), 'wx');
  console.log(`${name}: ${path.join(output, `${name}.log`)}`);
  const result = spawnSync(cmake, args, { env, windowsHide: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  fs.writeFileSync(path.join(output, `${name}-result.json`), JSON.stringify({ exitCode: result.status, error: result.error?.message, endedUtc: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(result.status, 0, `${name} failed; preserved log in ${output}`);
}
run('configure', ['-S', wrapperSource, '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64', '-T', 'v143,host=x64', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_SHARED_LINKER_FLAGS=/PDBALTPATH:realm-wrappers.pdb', '-DCMAKE_SYSTEM_VERSION=10.0.26100.0', '-DREALM_DOTNET_BUILD_CORE_FROM_SOURCE=ON', '-DREALM_VERSION=20.1.2', '-DREALM_NEEDS_OPENSSL=OFF', '-DREALM_FORCE_OPENSSL=OFF', '-DREALM_BUILD_TEST_CLIENT=OFF', '-DFETCHCONTENT_FULLY_DISCONNECTED=ON']);
const compilerFile = path.join(build, 'CMakeFiles/3.31.6-msvc6/CMakeCXXCompiler.cmake');
const compilerText = ordinary(compilerFile).toString();
assert(compilerText.includes('set(CMAKE_CXX_COMPILER_VERSION "19.44.35222.0")'), 'Qualified installed MSVC 19.44.35222.0 required');
const compiler = compilerText.match(/set\(CMAKE_CXX_COMPILER "([^"]+)"\)/)?.[1];
assert(compiler, 'Configured compiler identity required');
// Admit only the reviewed native target graph. Optional bindgen/download targets
// must never become a dependency of the artifact we compile.
const closure = new Set();
function inspect(relative) {
  const project = path.resolve(build, relative);
  assert(project.startsWith(build + path.sep), 'Native project escapes build output');
  if (closure.has(project)) return;
  closure.add(project);
  const xml = ordinary(project).toString();
  for (const command of xml.matchAll(/<Command\b[^>]*>([\s\S]*?)<\/Command>/g)) {
    assert(!/\b(npx|curl|wget|powershell|download|bootstrap)\b/i.test(command[1]), 'Offline native closure contains acquisition/bootstrap command');
    assert(command[1].includes('cmake.exe') && /--check-stamp|VerifyGlobs\.cmake/.test(command[1]), 'Unexpected native custom command');
  }
  for (const reference of xml.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) inspect(path.relative(build, path.resolve(path.dirname(project), reference[1])));
}
inspect('src/realm-wrappers.vcxproj');
assert.deepEqual([...closure].map(file => path.basename(file)).sort(), ['realm-wrappers.vcxproj', 'ZERO_CHECK.vcxproj', 'ObjectStore.vcxproj', 'QueryParser.vcxproj', 'Storage.vcxproj', 'Bid.vcxproj', 's2geometry.vcxproj', 'sha2.vcxproj'].sort(), 'Qualified native project closure changed');
const projectClosure = [...closure].map(file => path.relative(build, file).replaceAll('\\', '/')).sort();
fs.writeFileSync(path.join(output, 'project-closure.json'), JSON.stringify(projectClosure, null, 2) + '\n', { flag: 'wx' });
run('compile', ['--build', build, '--config', 'Release', '--target', 'realm-wrappers', '--parallel', '2', '--', '/nodeReuse:false']);
assert.equal(verifySource().sha256, source.sha256, 'Maintained source changed during build');
const binary = path.join(build, 'src/Release/realm-wrappers.dll');
const binaryBytes = ordinary(binary);
const checkoutPrefix = root.toLowerCase().replaceAll('\\', '/') + '/';
for (const text of [binaryBytes.toString('utf8'), binaryBytes.toString('utf16le'), binaryBytes.subarray(1).toString('utf16le')]) {
  assert(!text.toLowerCase().replaceAll('\\', '/').includes(checkoutPrefix), 'Native artifact embeds the build checkout path');
}
assert(binaryBytes.includes(Buffer.from('realm-src\\')), 'Relative Realm source diagnostics missing');
const codeView = binaryBytes.indexOf(Buffer.from('RSDS'));
assert(codeView >= 0 && binaryBytes.subarray(codeView + 24, codeView + 43).equals(Buffer.from('realm-wrappers.pdb\0')), 'Native artifact must name only its PDB basename');
const receipt = { version: 1, startedUtc, endedUtc: new Date().toISOString(), sourceSha256: source.sha256, artifactSha256: sha(ordinary(binary)), artifactBytes: fs.statSync(binary).size, artifact: 'cmake/src/Release/realm-wrappers.dll', upstream: source.pins.upstream, toolchain: { cmake: version.stdout.split(/\r?\n/)[0], cmakeSha256: cmakeHash, compiler: 'MSVC 19.44.35222', compilerSha256: sha(ordinary(compiler)), windowsSdk: '10.0.26100.0', generator: 'Visual Studio 17 2022', architecture: 'x64' }, offline: true, projectClosure, parallelProjects: 2, compilerFanout: 1, msbuildNodeReuse: false, buildScriptSha256: sha(ordinary(__filename)), packageScriptSha256: sha(ordinary(path.join(__dirname, 'package.cjs'))) };
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
if (options['--stage']) stageArtifact(binary, path.resolve(options['--stage']), receipt);
console.log(JSON.stringify({ output, artifactSha256: receipt.artifactSha256, artifactBytes: receipt.artifactBytes, staged: options['--stage'] || null }));
