import { spawnSync } from "child_process";
import { resolve } from "path";

const workspace = resolve(__dirname, "../../../../../../..");
const owners = ["CommonManagers", "AnalysisApp", "ScenarioManager", "AudioService", "AudioEngine",
  "PixiRendererManager", "SceneManager", "SliderTextureManager"];
type Outcome = { owner: string; check: string; error?: string };
let outcomes: Outcome[];

// Ordinary Node avoids ts-jest and Jest resolution differences. This bounded
// worker compiles actual sources in memory and starts no UI/audio/GPU services.
function runProductionRegression(workspaceRoot: string, sourceOverrides: Record<string, string> = {}) {
  // This function is serialized into ordinary Node, so its imports must be local CJS.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const assert: typeof import("assert/strict") = require("assert/strict");
  const path = require("path") as typeof import("path");
  const { readFileSync } = require("fs") as typeof import("fs");
  const { createRequire } = require("module") as typeof import("module");
  const { Script } = require("vm") as typeof import("vm");
  const nxLoader = require.resolve("@nrwl/web/src/utils/web-babel-loader");
  const babelLoader = createRequire(nxLoader).resolve("babel-loader");
  const babelCore = createRequire(babelLoader).resolve("@babel/core");
  const { transformSync, version } = require(babelCore) as typeof import("@babel/core");
  require("reflect-metadata");
  const inversify = require("inversify") as typeof import("inversify");
  const rxjs = require("rxjs") as typeof import("rxjs");
  /* eslint-enable @typescript-eslint/no-var-requires */
  assert.equal(babelCore, createRequire(path.join(path.dirname(babelLoader), "transform.js")).resolve("@babel/core"));
  console.error(JSON.stringify({ nxLoader, babelLoader, babelCore, version }));
  const services = path.join(workspaceRoot, "apps/desktop/frontend/src/app/services");
  const definitions = [
    ["common/CommonManagers.ts", "CommonManagers", 9],
    ["analysis/AnalysisApp.ts", "AnalysisApp", 18],
    ["manager/ScenarioManager.ts", "ScenarioManager", 20],
    ["common/audio/AudioService.ts", "AudioService", 1],
    ["common/audio/AudioEngine.ts", "AudioEngine", 3],
    ["renderers/PixiRendererManager.ts", "PixiRendererManager", 0],
    ["common/scenes/SceneManager.ts", "SceneManager", 0],
    ["renderers/components/sliders/SliderTextureManager.ts", "SliderTextureManager", 1],
  ] as const;
  type Observer = import("./ViewerLifecycleObserver").ViewerLifecycleObserver;
  type Owner = { lifecycle: Observer };
  type Constructor = new (...args: never[]) => Owner;
  type Token = import("inversify").interfaces.ServiceIdentifier<unknown>;
  type Tag = { key: string; value: unknown };
  const audioContextToken = Symbol("TestAudioContext");
  const results: Outcome[] = [];

  function productionCode(file: string): string {
    const caller = { name: "babel-loader", isModern: true, emitDecoratorMetadata: true,
      supportsStaticESM: true, supportsDynamicImport: true, supportsTopLevelAwait: true };
    // The optional in-memory map lets QA check verified rollback bytes without
    // restoring production files. Ordinary test runs read the current sources.
    const source = sourceOverrides[file] ?? readFileSync(file, "utf8");
    const result = transformSync(source, {
      filename: file, cwd: workspaceRoot, configFile: path.join(workspaceRoot, "babel.config.json"),
      babelrc: true, envName: "production", caller,
    });
    assert(result?.code, "Production Babel did not emit the owner");
    // Only adapt already-emitted ESM transport for this isolated VM. TypeScript
    // and decorator transforms have run through the actual production Nx preset.
    const commonjs = transformSync(result.code, { configFile: false, babelrc: false,
      plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")] });
    assert(commonjs?.code, "Missing CommonJS test transport");
    return commonjs.code;
  }

  function compileModule(relative: string): Record<string, unknown> {
    const file = path.join(services, relative);
    const dependencies = new Map<string, Record<string, unknown>>();
    const load = (request: string): unknown => {
      if (request === "inversify") return inversify;
      if (request === "rxjs") return rxjs;
      if (request.endsWith("/ViewerLifecycleObserver")) return contract;
      if (request === "pixi.js") return { Container: class Stage {}, Renderer: class Renderer {
        constructor() { throw new Error("DI construction must not create a GPU renderer"); }
      } };
      if (request.endsWith("/types")) return { STAGE_TYPES: { AUDIO_CONTEXT: audioContextToken } };
      if (request.includes("@babel/runtime")) {
        // Equivalent CJS helper exports support only the module transport adapter.
        return require(request.replace(/([\\/]helpers)[\\/]esm([\\/])/, "$1$2"));
      }
      if (["path", "crypto", "url", "fs/promises"].includes(request)) return require(request);
      // Collaborators supply metadata tokens. Their playback/IPC/GPU behavior is
      // covered by existing suites; these tokens do not replace DI or the observer.
      let dependency = dependencies.get(request);
      if (!dependency) {
        dependency = new Proxy<Record<string, unknown>>({ __esModule: true, IDLE_LOAD_STATE: { phase: "idle" } }, {
          get(target, key: string) {
            if (!(key in target)) {
              const token = class Dependency {};
              Object.defineProperty(token, "name", { value: key });
              target[key] = token;
            }
            return target[key];
          },
        });
        dependencies.set(request, dependency);
      }
      return dependency;
    };
    const module = { exports: {} as Record<string, unknown> };
    new Script(productionCode(file), { filename: file }).runInNewContext({
      module, exports: module.exports, require: load, Reflect, console,
    });
    return module.exports;
  }

  function resolveOwner(owner: Constructor, observerIndex: number, supplied?: Observer): Owner {
    const parent = new inversify.Container(), child = new inversify.Container();
    child.parent = parent;
    if (supplied !== undefined) parent.bind(contract.VIEWER_LIFECYCLE_OBSERVER).toConstantValue(supplied);
    const tags = Reflect.getMetadata("inversify:tagged", owner) as Record<string, Tag[]> | undefined;
    const types = Reflect.getMetadata("design:paramtypes", owner) as Token[];
    // Actual constructors and @postConstruct hooks run against inert collaborators,
    // without creating an AudioContext/GPU renderer or starting playback/tickers.
    const collaborator = {
      beforeDestroy$: new rxjs.Subject<void>(), seeked$: new rxjs.Subject<number>(),
      isPlaying$: new rxjs.Subject<boolean>(), playbackRate$: new rxjs.Subject<number>(),
      settings$: new rxjs.Subject<unknown>(), destination: {},
      createGain: () => ({ connect: () => undefined, gain: { value: 1 } }),
    };
    types.forEach((type, index) => {
      if (index === observerIndex) return;
      const token = (tags?.[index]?.find(tag => tag.key === "inject")?.value ?? type) as Token;
      if (!child.isBound(token)) child.bind(token).toConstantValue(collaborator);
    });
    child.bind(owner).toSelf();
    return child.get(owner);
  }

  function check(owner: string, name: string, run: () => void) {
    try { run(); results.push({ owner, check: name }); }
    catch (error) { results.push({ owner, check: name, error: String(error) }); }
  }
  const contract = compileModule("common/ViewerLifecycleObserver.ts") as typeof import("./ViewerLifecycleObserver");
  for (const [file, name, index] of definitions) {
    const owner = compileModule(file)[name] as Constructor;
    assert.equal(typeof owner, "function", "Actual compiled owner missing: " + name);
    check(name, "metadata", () => {
      const tags = Reflect.getMetadata("inversify:tagged", owner) as Record<string, Tag[]> | undefined;
      assert(tags?.[index]?.some(tag => tag.key === "inject" && tag.value === contract.VIEWER_LIFECYCLE_OBSERVER), "Observer symbol injection metadata was dropped");
      assert(tags?.[index]?.some(tag => tag.key === "optional" && tag.value === true), "Optional metadata was dropped");
    });
    check(name, "parent", () => {
      const supplied = new contract.ViewerLifecycleObserver({ id: () => 1, record: () => undefined,
        count: () => undefined, invalidate: () => undefined });
      assert.equal(resolveOwner(owner, index, supplied).lifecycle, supplied);
    });
    check(name, "absent", () => assert.equal(resolveOwner(owner, index).lifecycle, contract.NOOP_VIEWER_LIFECYCLE));
  }
  console.log(JSON.stringify(results));
  process.exitCode = results.some(result => result.error) ? 1 : 0;
}

beforeAll(() => {
  const child = spawnSync(process.execPath, ["-e", `(${runProductionRegression.toString()})(${JSON.stringify(workspace)})`], {
    cwd: workspace, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", NX_DAEMON: "false",
      DOTENV_CONFIG_PATH: resolve(workspace, "qa/replay-library/20261015T151758Z/normal-renderer-di-regression-r1/absent-env") },
  });
  if (child.error || child.signal || ![0, 1].includes(child.status ?? -1)) throw new Error(`Production Babel worker failed: ${child.error ?? child.stderr}`);
  if (child.stderr.trim()) console.info(child.stderr.trim());
  const line = child.stdout.trim().split(/\r?\n/).at(-1);
  if (!line?.startsWith("[")) throw new Error(`Production Babel worker did not report checks: ${child.stderr}`);
  outcomes = JSON.parse(line) as Outcome[];
  expect(outcomes).toHaveLength(24);
}, 35000);

describe.each(owners)("production Babel observer injection: %s", owner => {
  it.each(["metadata", "parent", "absent"])("preserves %s binding behavior", check => {
    const outcome = outcomes.find(result => result.owner === owner && result.check === check);
    expect(outcome).toBeDefined();
    expect(outcome?.error).toBeUndefined();
  });
});
