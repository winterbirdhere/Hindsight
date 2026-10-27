const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const tool = fs.existsSync(__dirname + '/incident-semantic-identity.cjs') ? require('./incident-semantic-identity.cjs') : {};

test('status-only activity is classified without cutting Store admission or shared evidence', () => {
  const store = 'apps/desktop/main/src/app/library/library-store.ts';
  const activity = 'apps/desktop/main/src/app/library/library-analysis-activity.ts';
  const evidence = 'apps/desktop/main/src/app/library/library-recorded-evidence.ts';
  const initial = tool.identity(), query = tool.queryIdentity();
  assert.equal(initial.sources[activity], undefined, 'connection-local display counts do not produce metrics');
  assert.match(initial.storeBoundary.excludedEdges['./library-analysis-activity'], /status|display/i);
  const displayOnly = { [activity]: fs.readFileSync(tool.root + '/' + activity, 'utf8') + '\n// display count fixture\n' };
  assert.equal(tool.identity({ overlays: displayOnly }).digest, initial.digest);
  assert.equal(tool.queryIdentity({ overlays: displayOnly }).digest, query.digest);
  const source = fs.readFileSync(tool.root + '/' + store, 'utf8');
  const changedAdmission = source.replace('if(!this.numericalAdmission||this.metrics.analysisSettings().mode!=="bg")return;',
    'if(!this.numericalAdmission||this.metrics.analysisSettings().mode==="off")return;');
  assert.notEqual(changedAdmission, source, 'fixture changes the actual admission predicate');
  assert.notEqual(tool.identity({ overlays: { [store]: changedAdmission } }).digest, initial.digest);
  assert.ok(initial.sources[evidence], 'the activity helper does not cut the independently traversed recorded evidence');
  assert.ok(query.sources[evidence]);
  assert.throws(() => tool.identity({ overlays: { [store]: source.replace('import { LibraryAnalysisActivityStore }',
    'import { LibraryAnalysisActivityStore as UnclassifiedActivity }') + '\nvoid UnclassifiedActivity;\n' } }), /binding\/callback inventory/i);
});

test('dedicated retained library semantic identity follows its audited source graph', () => {
  assert.equal(typeof tool.identity, 'function', 'dedicated semantic source-graph identity is missing');
  const initial = tool.identity();
  for (const name of ['apps/desktop/main/src/app/api.ts', 'apps/desktop/main/src/app/library/library-query.ts',
    'apps/desktop/main/src/app/library/library-query-projection.ts','apps/desktop/main/src/app/library/library-query-readiness.ts']) {
    assert.equal(tool.identity({ overlays: { [name]: '// unrelated change\n' } }).digest, initial.digest, name);
  }
  for (const name of ['apps/desktop/frontend/src/app/services/library/library-numerical.ts',
    'apps/desktop/frontend/src/app/services/library/library-replay-parser.ts',
    'apps/desktop/main/src/app/saved-score-source.ts']) {
    assert.ok(initial.sources[name], name + ' is in the semantic closure');
    assert.notEqual(tool.identity({ overlays: { [name]: fs.readFileSync(tool.root + '/' + name, 'utf8') + '\n// semantic mutation fixture\n' } }).digest, initial.digest, name);
  }
  const producer = 'apps/desktop/frontend/src/app/services/library/library-replay-parser.ts';
  const original = fs.readFileSync(tool.root + '/' + producer, 'utf8');
  const leaf = 'apps/desktop/frontend/src/app/services/library/identity-fixture-leaf.ts';
  const barrel = 'apps/desktop/frontend/src/app/services/library/identity-fixture-barrel.ts';
  const overlays = { [producer]: original + '\nimport "./identity-fixture-barrel";\n',
    [barrel]: 'export * from "./identity-fixture-leaf";', [leaf]: 'export const added = 1;' };
  const added = tool.identity({ overlays });
  assert.ok(added.sources[leaf]); assert.ok(added.sources[barrel]); assert.notEqual(added.digest, initial.digest);
  assert.notEqual(tool.identity({ overlays: { ...overlays, [leaf]: 'export const added = 2;' } }).digest, added.digest);
  assert.throws(() => tool.identity({ overlays: { [producer]: original + '\nimport(someRuntimePath);' } }), /dynamic|runtime/i);
  assert.throws(() => tool.identity({ overlays: { [producer]: original + '\nimport "./unresolved-semantic-dependency";' } }), /resolve|dependency/i);
  for (const name of tool.generatedExclusions) {
    const source = fs.readFileSync(tool.root + '/' + name, 'utf8');
    assert.equal(tool.identity({ overlays: { [name]: source.replace(/[a-f0-9]{64}/g, 'f'.repeat(64)) } }).digest, initial.digest);
    assert.throws(() => tool.identity({ overlays: { [name]: source + '\nexport const extraRuntime = 1;' } }), /excluded|generated/i);
  }
  const queryPath = 'apps/desktop/main/src/app/library/library-query-projection.ts';
  const query = tool.queryIdentity();
  assert.notEqual(tool.queryIdentity({ overlays: { [queryPath]: fs.readFileSync(tool.root + '/' + queryPath, 'utf8') + '\n// algorithm mutation\n' } }).digest, query.digest);
  const store = 'apps/desktop/main/src/app/library/library-store.ts';
  assert.throws(() => tool.identity({ overlays: { [store]: fs.readFileSync(tool.root + '/' + store, 'utf8') + '\nimport "./new-admission-collaborator";' } }), /inventory/i);
});

test('recorded nonstandard admission evidence is hashed through both actual runtime closures', () => {
  const helper = 'apps/desktop/main/src/app/library/library-recorded-evidence.ts';
  const source = fs.readFileSync(tool.root + '/' + helper, 'utf8');
  for (const identity of [tool.identity, tool.queryIdentity]) {
    const initial = identity();
    assert.ok(initial.sources[helper], 'recorded admission evidence must stay in the runtime closure');
    const changed = identity({ overlays: { [helper]: source.replace('>0)', '>1)') } });
    assert.notEqual(changed.digest, initial.digest, 'changing the nonstandard admission predicate must invalidate the consumer');
  }
});

test('audited Store import bindings fail closed even when their specifiers stay unchanged', () => {
  const store = 'apps/desktop/main/src/app/library/library-store.ts';
  const source = fs.readFileSync(tool.root + '/' + store, 'utf8');
  assert.throws(() => tool.identity({ overlays: { [store]: source.replace(
    'import { libraryKnownNonstandardSql }', 'import { libraryKnownNonstandardSql as substitutedAdmission }') +
    '\nvoid substitutedAdmission;\n' } }), /binding\/callback inventory/i);
});

test('effective inherited project config selects and hashes the runtime alias and module suffix', () => {
  const project = 'apps/desktop/main/tsconfig.app.json';
  const inherited = 'apps/desktop/main/identity-fixture.project.json';
  const producer = 'apps/desktop/main/src/app/library/library-query-projection.ts';
  const selected = 'apps/desktop/main/src/app/library/identity-fixture-leaf.semantic.ts';
  const fallback = 'apps/desktop/main/src/app/library/identity-fixture-leaf.ts';
  const paths = JSON.parse(fs.readFileSync(tool.root + '/tsconfig.base.json', 'utf8')).compilerOptions.paths;
  const projectConfig = JSON.parse(fs.readFileSync(tool.root + '/' + project, 'utf8'));
  const inheritedConfig = { extends: './tsconfig.json', compilerOptions: {
    paths: { ...paths, '@fixture/semantic': ['apps/desktop/main/src/app/library/identity-fixture-leaf'] },
    moduleSuffixes: ['.semantic', ''],
  } };
  const overlays = { [project]: JSON.stringify({ ...projectConfig, extends: './identity-fixture.project.json' }),
    [inherited]: JSON.stringify(inheritedConfig),
    [producer]: fs.readFileSync(tool.root + '/' + producer, 'utf8') + '\nimport "@fixture/semantic";',
    [selected]: 'export const selected = 1;', [fallback]: 'export const fallback = 1;' };
  const initial = tool.queryIdentity({ overlays });
  assert.ok(initial.sources[inherited], 'consumed inherited configuration must be hashed');
  assert.ok(initial.sources[selected], 'effective alias and moduleSuffixes must select the runtime leaf');
  assert.equal(initial.sources[fallback], undefined, 'unselected fallback is not the runtime dependency');
  assert.notEqual(tool.queryIdentity({ overlays: { ...overlays, [selected]: 'export const selected = 2;' } }).digest, initial.digest);
  assert.notEqual(tool.queryIdentity({ overlays: { ...overlays, [inherited]: JSON.stringify({ ...inheritedConfig,
    compilerOptions: { ...inheritedConfig.compilerOptions, noUnusedLocals: false } }) } }).digest, initial.digest);
  const changedSelection = tool.queryIdentity({ overlays: { ...overlays, [inherited]: JSON.stringify({ ...inheritedConfig,
    compilerOptions: { ...inheritedConfig.compilerOptions, moduleSuffixes: [''] } }) } });
  assert.ok(changedSelection.sources[fallback]); assert.equal(changedSelection.sources[selected], undefined);
  assert.notEqual(changedSelection.digest, initial.digest);
});

test('indirect runtime loaders fail closed before a new leaf can escape later identities', () => {
  const producer = 'apps/desktop/main/src/app/library/library-query-projection.ts';
  const source = fs.readFileSync(tool.root + '/' + producer, 'utf8');
  for (const indirect of ['const load = require; load("./identity-fixture-leaf");',
    'const load = globalThis["require"]; load("./identity-fixture-leaf");',
    'const evaluate = eval; evaluate("runtimeCode");',
    'const Constructor = Function; new Constructor("runtimeCode");',
    'const Constructor = globalThis.Worker; new Constructor("runtime.js");',
    'globalThis[loaderName]("runtime.js");']) {
    assert.throws(() => tool.queryIdentity({ overlays: { [producer]: source + '\n' + indirect } }), /runtime|loader/i, indirect);
  }
});

test('native project inputs reject unclassified items properties targets and SDK boundaries', () => {
  assert.equal(typeof tool.validateNativeProject, 'function', 'native project input schema is missing');
  const native = fs.readFileSync(tool.root + '/engine/RewindPerformance/RewindPerformance.csproj', 'utf8');
  tool.validateNativeProject(native);
  for (const input of ['<ItemGroup><EmbeddedResource Include="rules.json" /></ItemGroup>',
    '<ItemGroup><AdditionalFiles Include="rules.json" /></ItemGroup>',
    '<ItemGroup><Analyzer Include="generator.dll" /></ItemGroup>',
    '<Target Name="Custom"><ReadLinesFromFile File="rules.json" /></Target>',
    '<PropertyGroup><CustomRuntimeInput>rules.json</CustomRuntimeInput></PropertyGroup>']) {
    assert.throws(() => tool.validateNativeProject(native.replace('</Project>', input + '</Project>')), /native|unclassified/i, input);
  }
  assert.throws(() => tool.validateNativeProject(native.replace('Microsoft.NET.Sdk', 'Unclassified.Sdk')), /native|SDK/i);
});

test('the excluded generated module must contain exactly its two canonical identity exports', () => {
  assert.equal(typeof tool.checkGenerated, 'function', 'canonical generated module validation is missing');
  const semantic = 'a'.repeat(64), query = 'b'.repeat(64), source = tool.renderGenerated(semantic, query);
  tool.checkGenerated(source, semantic, query);
  assert.throws(() => tool.checkGenerated(source + 'export const extraRuntime = 1;\n', semantic, query), /generated/i);
  assert.throws(() => tool.checkGenerated(source.replace(semantic, 'c'.repeat(64)), semantic, query), /generated/i);
});

test('local package resolution metadata is hashed even when both selected leaves are already reachable', () => {
  const producer = 'apps/desktop/main/src/app/library/library-query-projection.ts';
  const directory = 'apps/desktop/main/src/app/library/identity-fixture-package';
  const packageFile = directory + '/package.json';
  const overlays = { [producer]: fs.readFileSync(tool.root + '/' + producer, 'utf8') +
    '\nimport "./identity-fixture-package"; import "./identity-fixture-package/a"; import "./identity-fixture-package/b";',
    [packageFile]: JSON.stringify({ name: 'identity-fixture', main: 'a.ts' }),
    [directory + '/a.ts']: 'export const a = 1;', [directory + '/b.ts']: 'export const b = 2;' };
  const initial = tool.queryIdentity({ overlays });
  assert.ok(initial.sources[packageFile], 'resolver-consumed local package.json must be hashed');
  const switched = tool.queryIdentity({ overlays: { ...overlays, [packageFile]: JSON.stringify({ name: 'identity-fixture', main: 'b.ts' }) } });
  assert.deepEqual(Object.keys(initial.sources), Object.keys(switched.sources));
  assert.notEqual(initial.digest, switched.digest);
  assert.equal(initial.resolutions[producer]['./identity-fixture-package'], directory + '/a.ts');
  assert.equal(switched.resolutions[producer]['./identity-fixture-package'], directory + '/b.ts');
});

test('an emitted value import cannot silently substitute a local declaration for runtime code', () => {
  const producer = 'apps/desktop/main/src/app/library/library-query-projection.ts';
  const directory = 'apps/desktop/main/src/app/library/identity-fixture-declaration';
  assert.throws(() => tool.queryIdentity({ overlays: {
    [producer]: fs.readFileSync(tool.root + '/' + producer, 'utf8') + '\nimport "./identity-fixture-declaration";',
    [directory + '/package.json']: JSON.stringify({ types: 'index.d.ts', main: 'index.js' }),
    [directory + '/index.d.ts']: 'export declare const runtime: number;',
    [directory + '/index.js']: 'exports.runtime = 1;',
  } }), /declaration.*runtime|runtime.*declaration/i);
});
