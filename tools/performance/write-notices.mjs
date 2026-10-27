// SPDX-License-Identifier: MIT
import { readFile, readdir, writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [output, assetsFile] = process.argv.slice(2);
if (!output || !assetsFile) throw new Error('Expected publish directory and project.assets.json.');
const assets = JSON.parse(await readFile(assetsFile, 'utf8'));
const dependencies = JSON.parse(await readFile(path.join(output, 'RewindPerformance.deps.json'), 'utf8'));
const files = new Set(await readdir(output));
const target = dependencies.targets[dependencies.runtimeTarget.name];
const packageRoots = Object.keys(assets.packageFolders);
const inventory = [];
const licensesDirectory = path.join(output, 'licenses');
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(licensesDirectory, { recursive: true });
await copyFile(path.join(workspace, 'LICENSE.md'), path.join(output, 'LICENSE.md'));
const decode = value => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1] ?? '');

for (const [name, definition] of Object.entries(target)) {
  const published = [...Object.keys(definition.runtime ?? {}), ...Object.keys(definition.native ?? {})]
    .map(asset => path.basename(asset)).filter(file => files.has(file));
  if (!published.length || name.startsWith('RewindPerformance/')) continue;
  const metadata = assets.libraries[name];
  const slash = name.lastIndexOf('/');
  const id = name.slice(0, slash), version = name.slice(slash + 1);
  let folder;
  let nuspec;
  for (const packageRoot of packageRoots) {
    try {
      folder = metadata?.path ? path.join(packageRoot, metadata.path) : path.join(packageRoot, id.replace(/^runtimepack\./, '').toLowerCase(), version);
      const entry = (await readdir(folder)).find(file => file.endsWith('.nuspec'));
      nuspec = await readFile(path.join(folder, entry), 'utf8');
      break;
    } catch { /* A resolved package may be in the read-only fallback cache. */ }
  }
  if (!nuspec) throw new Error(`Cannot identify license metadata for published dependency ${name}`);
  const license = tag(nuspec, 'license');
  const licenseType = nuspec.match(/<license\s+type="([^"]+)"/)?.[1] ?? 'url';
  const licenseUrl = licenseType === 'expression' ? `https://licenses.nuget.org/${encodeURIComponent(license)}` : tag(nuspec, 'licenseUrl');
  const entry = { id, version, license, licenseType, licenseUrl, copyright: tag(nuspec, 'copyright'),
    projectUrl: tag(nuspec, 'projectUrl'), sourcePackage: `https://www.nuget.org/packages/${id.replace(/^runtimepack\./, '')}/${version}`, files: published.sort() };
  const repository = nuspec.match(/<repository\b([^>]*)\/?\s*>/)?.[1] ?? '';
  entry.repository = Object.fromEntries(['url', 'commit', 'type'].map(key => [key, decode(repository.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '')]));
  entry.additionalLicenseFiles = [];
  for (const file of await readdir(folder, { withFileTypes: true })) {
    if (!file.isFile() || !/^(licen[cs]e|copying|notice|third.?party.?notice)/i.test(file.name)) continue;
    const destination = `${id}-${version}-${file.name}`;
    await copyFile(path.join(folder, file.name), path.join(licensesDirectory, destination));
    entry.additionalLicenseFiles.push(`licenses/${destination}`);
  }
  if (licenseType === 'file') {
    const destination = `${id}-${version}-LICENSE.txt`;
    await copyFile(path.join(folder, license), path.join(licensesDirectory, destination));
    entry.licenseFile = `licenses/${destination}`;
  }
  for (const notice of ['THIRD-PARTY-NOTICES.TXT', 'ThirdPartyNotices.txt']) {
    try {
      const destination = `${id}-${version}-${notice}`;
      await copyFile(path.join(folder, notice), path.join(licensesDirectory, destination));
      entry.thirdPartyNotices = `licenses/${destination}`;
    } catch { /* Not every NuGet package contains an additional notice file. */ }
  }
  inventory.push(entry);
}
inventory.sort((a, b) => a.id.localeCompare(b.id));
const curated = path.join(workspace, 'engine', 'RewindPerformance', 'licenses');
await cp(curated, licensesDirectory, { recursive: true });
await writeFile(path.join(output, 'dependency-licenses.json'), JSON.stringify({ engineVersion: '2026.730.0-official-pp-v9', packages: inventory }, null, 2) + '\n');
const text = [
  '# Rewind native performance engine dependencies', '',
  'The Rewind host is independently written and licensed under MIT. Official osu! calculator package: 2026.730.0; upstream commit 1032a7c31581513c8be751e46f0940e1c95ed252.',
  'This inventory comes from the published executable dependency manifest and locally restored NuGet metadata. Each dependency retains its own license. Full metadata and shipped file mappings are in dependency-licenses.json.', '',
  'Full license texts, preserved notices and corresponding-source materials are shipped in licenses/. Source provenance is recorded there and in each package repository entry. The host license is LICENSE.md.', '',
  ...inventory.map(entry => `- ${entry.id} ${entry.version}: ${entry.license || entry.licenseUrl}. ${entry.copyright} License: ${entry.licenseFile || entry.licenseUrl}. Source/package: ${entry.projectUrl || entry.sourcePackage}`), ''
].join('\n');
await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.md'), text);
console.log(`Recorded ${inventory.length} published dependency license entries.`);
