// Retained library producer semantic dependency identity. Read-only by default; --write is explicit.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), ts = require('typescript');
const { isBuiltin } = require('node:module');
const root = path.resolve(__dirname, '../..');
const revisionPath = 'apps/desktop/shared/library-incident-semantic-revision.ts';
const manifestPath = 'tools/library/incident-semantic-identity.json';
const generatedExclusions = [revisionPath, 'libs/osu/core/src/gameplay/trace/TraceModelRevision.ts'];
const roots = [
  'apps/desktop/frontend/src/app/services/library/library-analysis.worker.ts',
  'apps/desktop/frontend/src/app/services/library/library-replay.worker.ts',
  'apps/desktop/main/src/app/library/library-numerical-resources.ts',
  'apps/desktop/main/src/app/library/library-resource-server.ts',
  'apps/desktop/main/src/app/library/library-incidents-store.ts',
  'apps/desktop/main/src/app/library/library-numerical-profile.ts',
  'apps/desktop/main/src/app/library/library-incidents-preparation.ts',
  'apps/desktop/main/src/app/library/library-origin-index.ts',
  'apps/desktop/main/src/app/library/library-store.ts',
];
const queryRoots = ['apps/desktop/main/src/app/library/library-query-projection.ts'];
// Store owns retained metric admission and publication through callbacks. Hash its complete bytes,
// classify EVERY emitted value import, and traverse every semantic collaborator. Its
// query/status-only edges are explicitly cut so collaborator-only display edits cannot rerun producers.
const storeBoundary = 'apps/desktop/main/src/app/library/library-store.ts';
const storeImports = ['node:sqlite','crypto','@rewind/osu-performance/protocol','./library-metric-store',
  './library-numerical-recipe-store','./library-numerical-profile','./library-incidents-store','./library-query-projection',
  './library-query-invalidation','./library-source-admission','./library-query','./library-recorded-evidence',
  './library-performance-cache','./library-performance-recipe-store','./library-performance-dependencies','./library-performance-versions',
  './library-performance-context','./library-preparation-store','./library-source-binding','./library-source-metrics',
  '../../../../shared/library-analysis','./library-timeline-target','./library-fc-target',
  './library-current-replay-authority','./library-query-readiness','./library-analysis-activity','./library-resource-changes'];
const storeQueryEdges = {
  './library-query': 'Passive reader creation only; no C producer or admission decision.',
  './library-query-projection': 'Derived scalar cache, query evidence revision and query-only Unicode player fold registration; callbacks invoke Store-owned admission methods whose full source is hashed. Recorded admission SQL is traversed independently through library-recorded-evidence.',
  './library-query-invalidation': 'Bounded dirty/scope queues; not a C classifier, evidence or target producer.',
  './library-query-readiness': 'Read-only committed-queue/schema inspection for passive query readiness and source-only notification proof; no metric/admission writes. Store callers and semantic-dirty guards remain fully hashed.',
  './library-analysis-activity': 'Connection-local TEMP display/status counters and triggers observing existing intent/eligibility rows; writes only its TEMP projection, never admits work or publishes metrics/query evidence. Store construction/call sites remain fully hashed; recorded admission evidence is independently traversed through library-recorded-evidence.',
};
const storeBindings = ['DatabaseSync','randomUUID','PERFORMANCE_ENGINE_VERSION','LibraryMetricStore,libraryCapabilityAttempt',
  'LibraryNumericalRecipeStore','numericalModsHash,numericalProfileKey,validateNumericalRecipe','LibraryIncidentRecipeStore','LibraryQueryProjection,registerLibraryPlayerFold,LIBRARY_FILTER_EVIDENCE_REVISION','LibraryQueryInvalidation',
  'LibrarySourceAdmission','LibraryQueryReader','libraryKnownNonstandardSql','LibraryPerformanceCache',
  'LibraryPerformanceRecipeStore','performanceDependencyKeys','LIBRARY_P_PRODUCER_VERSION','composePerformanceContext','LibraryPreparationStore',
  'projectSourceEvidence,projectStableMapEvidence,sourceMapEvidence','LIBRARY_SOURCE_PROJECTION_VERSION,metricInputKey',
  'LIBRARY_NUMERIC_PROJECTION_VERSION,LIBRARY_REPLAY_PARSER_VERSION,LIBRARY_RESOURCE_PREPARATION_VERSION',
  'libraryTimelineTarget','libraryFcTarget','LibraryCurrentReplayAuthorities,currentReplayDescriptor','libraryQueryReadiness','LibraryAnalysisActivityStore','LibraryResourceChangesJournal'];
const configs = ['package.json', 'yarn.lock', 'tsconfig.base.json',
  'apps/desktop/frontend/tsconfig.json', 'apps/desktop/frontend/tsconfig.app.json',
  'apps/desktop/main/tsconfig.json', 'apps/desktop/main/tsconfig.app.json',
  'libs/osu/core/tsconfig.json', 'libs/osu/core/tsconfig.lib.json',
  'libs/osu/math/tsconfig.json', 'libs/osu/math/tsconfig.lib.json',
  'libs/osu-local/osr-reader/tsconfig.json', 'libs/osu-local/osr-reader/tsconfig.lib.json'];
// These are the only runtime process boundaries reached by this closure. The helper's
// complete source project and lock are hashed below; executable/binary seals remain separate.
const processBoundaries = [
  'apps/desktop/main/src/app/library/sources/lazer-source.ts',
  'apps/desktop/main/src/app/library/library-lzma-client.ts',
  'apps/desktop/main/src/app/performance-worker.ts',
];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normal = value => value.replace(/\\/g, '/');
const generatedComment = '/** Generated independent C semantic and query algorithm closures; see tools/library/incident-semantic-identity.json. */';
const renderGenerated = (semantic, query) => generatedComment + '\nexport const LIBRARY_INCIDENT_SEMANTIC_REVISION = "' + semantic +
  '";\nexport const LIBRARY_QUERY_ALGORITHM_SOURCE_REVISION = "' + query + '";\n';
const checkGenerated = (source, semantic, query) => assert.equal(source, renderGenerated(semantic, query), 'Noncanonical or stale generated library identity module');
function validateExcluded(name, source) {
  const normalized = source.replace(/\r\n/g, '\n');
  if (name === revisionPath) {
    const values = [...normalized.matchAll(/export const (?:LIBRARY_INCIDENT_SEMANTIC_REVISION|LIBRARY_QUERY_ALGORITHM_SOURCE_REVISION) = "([a-f0-9]{64})";/g)].map(match => match[1]);
    assert(values.length === 2 && normalized === renderGenerated(values[0], values[1]), 'Unsupported generated library identity content');
  } else {
    assert(/^\/\*\* Generated from model, analysis and source-admission dependencies; see qa\/miss-explanation-v1\/m55-model-revision.json\. \*\/\nexport const TRACE_MODEL_SOURCE_REVISION = "[a-f0-9]{64}";\n$/.test(normalized), 'Unsupported excluded historical TRACE identity content');
  }
}
/** The current helper has only literal properties and three locked PackageReferences.
 * Unknown build inputs are rejected until their source/config closure is explicitly audited. */
function validateNativeProject(source) {
  const properties = new Set(['OutputType','TargetFramework','ImplicitUsings','Nullable','InvariantGlobalization',
    'AssemblyName','PackageLicenseExpression','RuntimeFrameworkVersion','RestorePackagesWithLockFile']);
  const packages = new Set(['ppy.osu.Game.Rulesets.Osu','ppy.osu.Game.Resources','ppy.osu.Framework.NativeLibs']);
  const clean = source.replace(/<!--[\s\S]*?-->/g, '');
  assert(!/[!&]|[$@%]\(/.test(clean), 'Unclassified native XML/property expression');
  const stack = []; let projects = 0;
  for (const token of clean.match(/<[^>]*>|[^<]+/g) || []) {
    if (!token.startsWith('<')) {
      assert(!token.trim() || properties.has(stack[stack.length - 1]), 'Unclassified native project text'); continue;
    }
    if (token.startsWith('</')) { assert.equal(token, '</' + stack.pop() + '>', 'Invalid native XML nesting'); continue; }
    const match = token.match(/^<([A-Za-z][A-Za-z0-9.]*)([^>]*?)(\/?)>$/);
    assert(match, 'Unclassified native XML declaration');
    const [, name, rawAttributes, selfClosing] = match, attributes = {};
    const remainder = rawAttributes.replace(/([A-Za-z]+)="([^"]*)"/g, (_, key, value) => {
      assert(!(key in attributes), 'Duplicate native attribute'); attributes[key] = value; return '';
    });
    assert(!remainder.trim(), 'Unclassified native attribute syntax');
    const parent = stack[stack.length - 1];
    if (name === 'Project') {
      assert(!parent && ++projects === 1 && JSON.stringify(attributes) === '{"Sdk":"Microsoft.NET.Sdk"}', 'Unclassified native SDK boundary');
    } else if (name === 'PropertyGroup' || name === 'ItemGroup') {
      assert(parent === 'Project' && !Object.keys(attributes).length, 'Unclassified native group');
    } else if (properties.has(name)) {
      assert(parent === 'PropertyGroup' && !Object.keys(attributes).length, 'Unclassified native property');
    } else if (name === 'PackageReference') {
      assert(parent === 'ItemGroup' && packages.has(attributes.Include) && typeof attributes.Version === 'string' &&
        Object.keys(attributes).every(key => ['Include','Version','ExcludeAssets','PrivateAssets'].includes(key)), 'Unclassified native package/input');
    } else throw Error('Unclassified native project item/property/target: ' + name);
    if (!selfClosing) stack.push(name);
  }
  assert(projects === 1 && stack.length === 0, 'Invalid native project root');
}
function identity({ overlays = {}, mode = 'semantic' } = {}) {
  const relative = absolute => normal(path.relative(root, absolute));
  const read = name => Object.prototype.hasOwnProperty.call(overlays, name) ? overlays[name] : fs.readFileSync(path.join(root, name), 'utf8');
  const exists = absolute => Object.prototype.hasOwnProperty.call(overlays, relative(absolute)) || fs.existsSync(absolute);
  const sources = {}, edges = {}, resolutions = {}, external = new Set(), visiting = new Set(), consumedConfigs = new Set(), resolutionInputs = new Set();
  const add = name => { assert(!name.startsWith('../') && !path.isAbsolute(name), 'Source escaped workspace: ' + name); sources[name] = hash(read(name)); };
  const declared = JSON.parse(read('package.json'));
  const packages = new Set(Object.keys({ ...declared.dependencies, ...declared.devDependencies }));
  const host = { fileExists: exists, readFile: absolute => exists(absolute) ? read(relative(absolute)) : undefined };
  const resolutionHost = { ...host, readFile: absolute => {
    if (!exists(absolute)) return undefined;
    const input = relative(absolute);
    assert(!input.startsWith('../') && !path.isAbsolute(input), 'Resolution metadata escaped workspace: ' + input);
    // Installed external package behavior retains the explicit package-lock boundary.
    // Local package/config metadata participates in the actual runtime binding identity.
    if (!input.startsWith('node_modules/') && !input.includes('/node_modules/')) { add(input); resolutionInputs.add(input); }
    return read(input);
  } };
  const emitOptions = new Map();
  function compilerOptions(name) {
    const project = name.startsWith('apps/desktop/frontend/') ? 'apps/desktop/frontend/tsconfig.app.json' :
      name.startsWith('apps/desktop/main/') ? 'apps/desktop/main/tsconfig.app.json' :
      name.startsWith('libs/osu/core/') ? 'libs/osu/core/tsconfig.lib.json' :
      name.startsWith('libs/osu/math/') ? 'libs/osu/math/tsconfig.lib.json' :
      name.startsWith('libs/osu-local/osr-reader/') ? 'libs/osu-local/osr-reader/tsconfig.lib.json' : 'tsconfig.base.json';
    if (!emitOptions.has(project)) {
      const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, project), {}, { ...ts.sys, ...host,
        readFile: absolute => {
          if (!exists(absolute)) return undefined;
          const input = relative(absolute); add(input); consumedConfigs.add(input); return read(input);
        },
        readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: diagnostic => { throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')); } });
      assert(parsed && !parsed.errors.some(error => error.code !== 18003), 'Invalid semantic project configuration: ' + project);
      emitOptions.set(project, parsed.options);
    }
    return emitOptions.get(project);
  }
  function dependency(from, specifier) {
    const resolved = ts.resolveModuleName(specifier, path.join(root, from), compilerOptions(from), resolutionHost).resolvedModule;
    resolutions[from] ||= {};
    if (resolved && !normal(resolved.resolvedFileName).includes('/node_modules/')) {
      assert(!/\.d\.[cm]?ts$/.test(resolved.resolvedFileName), 'Local declaration is not an audited runtime implementation: ' + from + ' -> ' + specifier);
      const selected = relative(resolved.resolvedFileName); resolutions[from][specifier] = selected; return selected;
    }
    if (specifier.startsWith('.') || specifier.startsWith('@rewind/') || specifier.startsWith('@osujs/'))
      throw Error('Unresolved local semantic dependency ' + from + ' -> ' + specifier);
    const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    assert(isBuiltin(specifier) || packages.has(packageName), 'Unaudited external runtime dependency: ' + specifier);
    if (specifier === 'child_process' || specifier === 'node:child_process')
      assert(processBoundaries.includes(from), 'Unaudited runtime process boundary: ' + from);
    assert(!['module','vm','worker_threads'].includes(specifier.replace(/^node:/, '')), 'Unaudited runtime loader boundary: ' + specifier);
    external.add(specifier); resolutions[from][specifier] = 'external:' + specifier; return undefined;
  }
  function visit(name) {
    if (generatedExclusions.includes(name)) { validateExcluded(name, read(name)); return; }
    if (visiting.has(name)) return;
    visiting.add(name); add(name);
    if (!/\.[cm]?[jt]sx?$/.test(name)) return;
    // TypeScript's configured emit erases type-only references, including imports used only
    // as types. Each visited source is hashed in full; emitted value imports form the graph.
    const result = ts.transpileModule(read(name), { fileName: path.join(root, name), reportDiagnostics: true, compilerOptions: { ...compilerOptions(name),
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, sourceMap: false, declaration: false } });
    assert(!result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), 'Invalid runtime source: ' + name);
    const emitted = result.outputText;
    const ast = ts.createSourceFile(name + '.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = new Set();
    function scan(node) {
      const loaders = new Set(['require','eval','Function','Worker','SharedWorker','createRequire']);
      if (ts.isIdentifier(node) && loaders.has(node.text)) {
        const directRequire = node.text === 'require' && ts.isCallExpression(node.parent) && node.parent.expression === node;
        assert(directRequire, 'Unaudited indirect runtime loader in ' + name + ': ' + node.text);
      }
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        assert(!(ts.isStringLiteralLike(key) && loaders.has(key.text)), 'Unaudited runtime loader element access in ' + name);
        assert(!(ts.isIdentifier(node.expression) && ['globalThis','global','window','self'].includes(node.expression.text)), 'Unaudited computed global runtime access in ' + name);
      }
      if (ts.isBindingElement(node) && node.propertyName && ts.isStringLiteralLike(node.propertyName))
        assert(!loaders.has(node.propertyName.text), 'Unaudited destructured runtime loader in ' + name);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text))) {
        assert(!(ts.isIdentifier(node.expression) && node.expression.text === 'eval'), 'Unaudited runtime eval in ' + name);
        assert(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]), 'Unaudited dynamic runtime import in ' + name);
        imports.add(node.arguments[0].text);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Worker', 'SharedWorker', 'Function'].includes(node.expression.text))
        throw Error('Unaudited runtime constructor boundary in ' + name + ': ' + node.expression.text);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['require','createRequire'].includes(node.expression.name.text))
        throw Error('Unaudited runtime module loader in ' + name);
      ts.forEachChild(node, scan);
    }
    scan(ast); edges[name] = [...imports].sort();
    if (name === storeBoundary) {
      assert.deepEqual(edges[name], [...storeImports].sort(), 'Store runtime dependency inventory changed: classify new imports/callback collaborators before regenerating');
      const bindings = Object.fromEntries(ast.statements.filter(ts.isImportDeclaration).map(node => [node.moduleSpecifier.text,
        node.importClause?.getText(ast).replace(/[{}\s]/g, '')]));
      assert.deepEqual(bindings, Object.fromEntries(storeImports.map((specifier, index) => [specifier, storeBindings[index]])), 'Store runtime binding/callback inventory changed');
    }
    for (const specifier of edges[name]) {
      if (name === storeBoundary && storeQueryEdges[specifier]) continue;
      const next = dependency(name, specifier); if (next) visit(next);
    }
  }
  const activeRoots = mode === 'query' ? queryRoots : roots;
  activeRoots.forEach(visit); configs.forEach(add);
  // Native helper is one compiled project. Include every source and dependency lock,
  // but never bin/obj/build outputs. New source files are automatically discovered.
  const nativeRoot = 'engine/RewindPerformance';
  function nativeVisit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (['bin', 'obj'].includes(entry.name)) continue;
      assert(!entry.isSymbolicLink(), 'Unaudited native symlink');
      const name = directory + '/' + entry.name;
      if (entry.isDirectory()) nativeVisit(name);
      else if (/\.(cs|csproj|props|targets)$/.test(name) || entry.name === 'packages.lock.json') {
        add(name);
        if (/\.(csproj|props|targets)$/.test(name)) validateNativeProject(read(name));
      }
    }
  }
  if (mode !== 'query') {
    nativeVisit(nativeRoot); add('global.json'); add('engine/NuGet.Config');
    for (const directory of ['', 'engine/', nativeRoot + '/']) for (const filename of ['Directory.Build.props','Directory.Build.targets','Directory.Packages.props'])
      assert(!exists(path.join(root, directory + filename)), 'Unaudited ambient native build configuration: ' + directory + filename);
  }
  // The generator is itself part of the boundary, so algorithm/root changes invalidate C.
  add('tools/library/incident-semantic-identity.cjs');
  const sorted = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, 'en')));
  const sortedResolutions = Object.fromEntries(Object.entries(resolutions).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { digest: hash(JSON.stringify({ sources: sorted, resolutions: sortedResolutions })), sources: sorted, roots: activeRoots, configs,
    consumedConfigs: [...consumedConfigs].sort(), resolutionInputs: [...resolutionInputs].sort(), generatedExclusions,
    processBoundaries, external: [...external].sort(), edges, resolutions: sortedResolutions, nativeRoot: mode === 'query' ? null : nativeRoot,
    storeBoundary: { path: storeBoundary, imports: storeImports, bindings: storeBindings, excludedEdges: storeQueryEdges },
    boundary: 'Runtime TypeScript emit graph including barrels/literal dynamic imports; full source bytes; package lock/config; complete native source project. Generated C identity self and broad TRACE identity token excluded; TRACE implementation remains traversed. Type-only edges erased by compiler are not runtime dependencies.' };
}
function check() {
  const result = identity();
  const query = identity({ mode: 'query' });
  checkGenerated(fs.readFileSync(path.join(root, revisionPath), 'utf8'), result.digest, query.digest);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')), { semantic: result, query }, 'Library C/query manifest stale');
  return result;
}
module.exports = { identity, queryIdentity: options => identity({ ...options, mode: 'query' }), check, root, roots, generatedExclusions, revisionPath,
  renderGenerated, checkGenerated, validateNativeProject, validateExcluded };
if (require.main === module) {
  assert(process.argv.length <= 3 && (!process.argv[2] || ['--write', '--inspect'].includes(process.argv[2])), 'Usage: [--write|--inspect]');
  const result = process.argv[2] ? identity() : check();
  if (process.argv[2] === '--write') {
    const query = identity({ mode: 'query' });
    fs.writeFileSync(path.join(root, revisionPath), renderGenerated(result.digest, query.digest));
    fs.writeFileSync(path.join(root, manifestPath), JSON.stringify({ semantic: result, query }, null, 2) + '\n');
    check();
  }
  console.log(JSON.stringify({ mode: process.argv[2] || 'check', files: Object.keys(result.sources).length, digest: result.digest }));
}
