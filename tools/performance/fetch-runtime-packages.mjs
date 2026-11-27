// SPDX-License-Identifier: MIT
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const destination = process.argv[2];
if (!destination) throw new Error('Expected a local NuGet feed directory.');
await mkdir(destination, { recursive: true });
const packages = [
  ['system.threading.overlapped', '4.3.0'],
  ...['microsoft.netcore.app.host.win-x64', 'microsoft.netcore.app.runtime.win-x64', 'microsoft.windowsdesktop.app.runtime.win-x64', 'microsoft.aspnetcore.app.runtime.win-x64'].map(id => [id, '8.0.30']),
  ...['system.diagnostics.debug', 'system.runtime.extensions', 'microsoft.win32.primitives', 'system.net.primitives', 'system.net.sockets', 'system.io.filesystem', 'system.console'].map(id => [`runtime.win.${id}`, '4.3.0'])
];
if (process.argv[3]) {
  try {
    const lock = JSON.parse(await readFile(process.argv[3], 'utf8'));
    for (const dependencies of Object.values(lock.dependencies)) {
      for (const [id, record] of Object.entries(dependencies)) {
        if (record.resolved) packages.push([id.toLowerCase(), record.resolved]);
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const unique = [...new Map(packages.map(pair => [pair.join('/'), pair])).values()];
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function prepare([id, version]) {
  const name = `${id}.${version}.nupkg`;
  if (await exists(path.join(os.homedir(), '.nuget', 'packages', id, version, name)) || await exists(path.join(destination, name))) return;
  const response = await fetch(`https://api.nuget.org/v3-flatcontainer/${id}/${version}/${name}`);
  if (!response.ok) throw new Error(`Official NuGet download failed: ${name} HTTP ${response.status}`);
  const temporary = path.join(destination, name + '.partial');
  await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
  await rename(temporary, path.join(destination, name));
  console.log(`Prepared ${name}`);
}
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < unique.length) await prepare(unique[next++]);
}));
