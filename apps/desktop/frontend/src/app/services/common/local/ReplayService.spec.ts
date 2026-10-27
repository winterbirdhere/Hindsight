import { ipcRenderer } from "electron";
import { ReplayService } from "./ReplayService";
import { OsuFolderService } from "./OsuFolderService";
import { Container } from "inversify";
import { resolve } from "path";
import { execFileSync } from "child_process";

jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn() } }));

function sourceReplay(overrides: Record<string, unknown> = {}) {
  return {
    gameMode: 0,
    gameVersion: 30_000_016,
    replay_data: "0|256|192|0,1000|256|192|1,",
    life_bar: "0|1,",
    mods: 64,
    replayMD5: "replay-md5",
    beatmapMD5: "beatmap-md5",
    playerName: "Player",
    number_300s: 1,
    number_100s: 0,
    number_50s: 0,
    misses: 0,
    max_combo: 1,
    score: 300,
    perfect_combo: 1,
    ...overrides,
  };
}

describe("ReplayService native metadata propagation", () => {
  function productionReplayService(): typeof ReplayService {
    // Jest normally uses TypeScript's decorator transform. Compile this module
    // with the actual renderer Babel configuration before using real Inversify.
    // A Node child preserves production Babel loading (Jest's resolver has
    // different JSON/module rules); only its transformed module is evaluated.
    const commonjs = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const { transformFileSync, transformSync } = require('@babel/core');
      const esm = transformFileSync(process.argv[1], {
        cwd: process.cwd(), envName: 'production',
        caller: { name: 'babel-loader', supportsStaticESM: true, emitDecoratorMetadata: true, isModern: true },
      }).code;
      const code = transformSync(esm, {
        configFile: false, babelrc: false,
        plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
      }).code;
      process.stdout.write(code);
    `,
        resolve(__dirname, "ReplayService.ts"),
      ],
      {
        cwd: resolve(__dirname, "../../../../../../../.."),
        env: { ...process.env, NODE_ENV: "production" },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    const module = { exports: {} as { ReplayService: typeof ReplayService } };
    new Function("require", "module", "exports", commonjs)(require, module, module.exports);
    return module.exports.ReplayService;
  }

  it("resolves the configured folder through the production Babel constructor and real singleton container", async () => {
    const CompiledReplayService = productionReplayService();
    const folders = { getOsuFolder: () => "D:\\configured-osu" } as OsuFolderService;
    const container = new Container({ defaultScope: "Singleton" });
    container.bind(OsuFolderService).toConstantValue(folders);
    container.bind(CompiledReplayService).toSelf();
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay());
    const service = container.get(CompiledReplayService);
    expect(container.get(CompiledReplayService)).toBe(service);
    await service.retrieveReplay("babel-source.osr");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("readOsr", "babel-source.osr", "D:\\configured-osu");
  });

  it("keeps the production Babel constructor optional when no folder service is bound", async () => {
    const CompiledReplayService = productionReplayService();
    const container = new Container({ defaultScope: "Singleton" });
    container.bind(CompiledReplayService).toSelf();
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay());
    await container.get(CompiledReplayService).retrieveReplay("babel-without-folder.osr");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("readOsr", "babel-without-folder.osr");
  });

  it("forwards only the existing configured folder and retains optional saved-score diagnostics", async () => {
    const savedScoreSource = { status: "rejected", reason: "terminal-mismatch", attempts: [] };
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ savedScoreSource }));
    const folders = { getOsuFolder: () => "D:\\configured-osu" } as OsuFolderService;
    const replay = await new ReplayService(folders).retrieveReplay("source.osr");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("readOsr", "source.osr", "D:\\configured-osu");
    expect(replay.savedScoreSource).toEqual(savedScoreSource);
  });
  it("carries the file digest and aligned parse diagnostics through the replay loader", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(
      sourceReplay({
        replayContentSha256: "a".repeat(64),
        replay_data: "0|256|-500|0,0|256|-500|0,100|100|120|1,bad,0|200|120|0,",
      }),
    );
    const replay = await new ReplayService().retrieveReplay("source.osr");
    expect(replay).toMatchObject({
      replayContentSha256: "a".repeat(64),
      parseDiagnostics: {
        initialActionsKnown: false,
        sourceCoverageLimits: ["initial-actions-unknown", "parser-malformed-token"],
        frameSources: [
          { origin: "parsed", parsedFrameIndex: 0, rawTokenIndex: 2 },
          { origin: "parsed", parsedFrameIndex: 1, rawTokenIndex: 4, discontinuityBefore: ["parser-malformed-token"] },
        ],
      },
    });
    expect(replay.frames.map((frame) => [frame.time, frame.position.x, frame.rawButtonMask])).toEqual([
      [100, 100, 1],
      [100, 200, 0],
    ]);
  });

  it.each([undefined, "legacy-id", "z".repeat(64)])(
    "never substitutes raw frame text or header MD5 for absent file identity: %p",
    async (digest) => {
      (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ replayContentSha256: digest }));
      const replay = await new ReplayService().retrieveReplay("unverified.osr");
      expect(replay).not.toHaveProperty("replayContentSha256", expect.any(String));
    },
  );

  it("retains confirmed source independently of the raw version, mods and statistics", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(
      sourceReplay({
        gameVersion: 20_260_711,
        mods: 0,
        sourceClient: "lazer",
        sourceProvenance: "user-confirmed",
      }),
    );
    const replay = await new ReplayService().retrieveReplay("legacy-wrapper.osr");
    expect(replay).toMatchObject({
      gameVersion: 20_260_711,
      sourceClient: "lazer",
      sourceProvenance: "user-confirmed",
      mods: [],
    });
    expect(replay.lazerMods).toBeUndefined();
    expect(replay.statistics?.count300).toBe(1);
  });

  it("retains the recording date for Stable spinner compatibility", async () => {
    const timestamp = new Date("2019-05-09T10:00:00Z");
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ timestamp }));
    const replay = await new ReplayService().retrieveReplay("old-spinner.osr");
    expect(replay.timestamp).toBe(timestamp.getTime());
  });
  it("retains the Stable TouchDevice bit through replay import", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ gameVersion: 20_260_904, mods: 4 }));
    const replay = await new ReplayService().retrieveReplay("touch-device.osr");
    expect(replay.mods).toEqual(["TOUCH_DEVICE"]);
    expect(replay.lazerMods).toBeUndefined();
  });
  it("preserves native settings and replaces stale legacy mod bits", async () => {
    const lazerMods = [
      { acronym: "HT", settings: { speed_change: 0.6 } },
      { acronym: "CL" },
      { acronym: "DA", settings: { overall_difficulty: 8 } },
    ];
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ lazerMods }));
    const replay = await new ReplayService().retrieveReplay("lazer.osr");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith("readOsr", "lazer.osr");
    expect(replay.mods).toEqual(["HALF_TIME"]);
    expect(replay.lazerMods).toEqual(lazerMods);
    expect(replay.frames).toHaveLength(2);
    expect(replay.statistics?.count300).toBe(1);
  });

  it("treats an empty native list as authoritative", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ lazerMods: [] }));
    const replay = await new ReplayService().retrieveReplay("native-nomod.osr");
    expect(replay.mods).toEqual([]);
    expect(replay.lazerMods).toEqual([]);
  });

  it("retains native nested statistics for terminal performance calculations", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(
      sourceReplay({
        lazerScoreInfo: {
          mods: [],
          statistics: { great: 1, slider_tail_hit: 1, large_tick_miss: 2 },
          maximum_statistics: { great: 1, slider_tail_hit: 1, large_tick_hit: 2 },
          rank: "A",
        },
      }),
    );
    const replay = await new ReplayService().retrieveReplay("native-score.osr");
    expect(replay.lazerScoreMetadata).toEqual({
      statistics: { great: 1, slider_tail_hit: 1, large_tick_miss: 2 },
      maximumStatistics: { great: 1, slider_tail_hit: 1, large_tick_hit: 2 },
      rank: "A",
    });
  });

  it("retains bitmask behavior when the source has no native metadata", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(sourceReplay({ gameVersion: 20_260_904 }));
    const replay = await new ReplayService().retrieveReplay("stable.osr");
    expect(replay.mods).toEqual(["DOUBLE_TIME"]);
    expect(replay.lazerMods).toBeUndefined();
  });
});
