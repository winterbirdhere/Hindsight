import { Container, Text, Texture } from "pixi.js";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS, type KeyOverlayLength } from "../../../analysis/replay-display-settings";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { KeyPressOverlay } from "../keypresses/KeyPressOverlay";
import { AnalysisStage, liveHudSettings } from "./AnalysisStage";
import { calculateAnalysisStageLayout } from "./AnalysisStageLayout";
import { EXPORT_STAGE_FRAME, liveStageFrame } from "./stage-frame";

/** A stand-in for the overlay, already at the default length: the tests that use it are not about its length. */
const overlayStub = () => ({
  length: DEFAULT_REPLAY_DISPLAY_SETTINGS.keyOverlayLength,
  windowDuration: 315,
  bounds: { x: 0, y: 0, width: 510, height: 75 },
  setLength: jest.fn(),
  onMouseOut: jest.fn(),
});

describe("AnalysisStage replay displays", () => {
  it("captures in the export frame and never shows the Pixi timing text", () => {
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    const timing = new Container();
    const bar = new Container();
    timing.y = 200;
    const updateHUD = jest.fn();
    const applyFrame = jest.spyOn(stage, "applyFrame").mockImplementation(() => undefined);
    const settings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS };
    Object.assign(stage, {
      keyPressOverlayPreparer: { container: new Container(), update: jest.fn(), keyPressOverlay: overlayStub() },
      foregroundHUDPreparer: { stats: timing, hitErrorBar: { container: bar }, container: new Container(), updateHUD },
      replayDisplaySettingsStore: { settings },
    });
    // The clip asks for both timing rows; the column draws them, so the Pixi text stays hidden.
    const displaySettings = { ...settings, unstableRateEnabled: true, timingBiasEnabled: true };
    stage.withCaptureLayers({ showKeys: false, showTiming: true, showHitErrorBar: true, displaySettings }, () => {
      expect(applyFrame).toHaveBeenLastCalledWith(EXPORT_STAGE_FRAME);
      expect(timing.visible).toBe(false);
      expect(timing.y).toBe(200);
      expect(bar.visible).toBe(true);
      expect(updateHUD).toHaveBeenCalledWith(
        expect.objectContaining({ unstableRateEnabled: false, timingBiasEnabled: false }),
        true,
      );
    });
    expect(timing.visible).toBe(true);
    expect(settings.unstableRateEnabled).toBe(true);
    expect(settings.timingBiasEnabled).toBe(true);
  });

  it("prepares capture HUD once per frame and restores the live appearance only when the session ends", () => {
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    const keys = new Container(),
      timing = new Container(),
      bar = new Container();
    keys.visible = timing.visible = bar.visible = false;
    timing.y = 200;
    const updateHUD = jest.fn();
    const updateKeys = jest.fn();
    const updatePlayfield = jest.fn();
    Object.assign(stage, {
      resizeTo: jest.fn(),
      playfield: { updatePlayfield },
      keyPressOverlayPreparer: { container: keys, update: updateKeys, keyPressOverlay: overlayStub() },
      foregroundHUDPreparer: { stats: timing, hitErrorBar: { container: bar }, container: new Container(), updateHUD },
      replayDisplaySettingsStore: { settings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, keyOverlapEnabled: false } },
    });
    const options = { showKeys: true, showTiming: true, showHitErrorBar: false };
    const capture = stage.beginCaptureLayers(options);
    for (let i = 0; i < 3; i++) {
      stage.updateAnalysisStage();
      stage.withCaptureLayers(options, () => {
        // The Pixi timing text is never shown in a capture and is not moved: the column draws UR and bias.
        expect([keys.visible, timing.visible, bar.visible]).toEqual([true, false, false]);
        expect(timing.y).toBe(200);
      });
      expect(updateHUD).toHaveBeenCalledTimes(i + 1);
    }
    expect(updatePlayfield).toHaveBeenCalledTimes(3);
    expect(updateKeys).toHaveBeenCalledTimes(3);
    capture.dispose();
    capture.dispose();
    expect(updateHUD).toHaveBeenCalledTimes(4);
    expect(updateHUD).toHaveBeenLastCalledWith(expect.objectContaining({ unstableRateEnabled: false, timingBiasEnabled: false }));
    expect([keys.visible, timing.visible, bar.visible]).toEqual([false, false, false]);
    expect(timing.y).toBe(200);
  });
  it("captures independent timing and cursor choices and restores the viewer after failure", () => {
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    const keys = new Container(),
      timing = new Container(),
      bar = new Container();
    const updateHUD = jest.fn();
    const capture = jest.fn((_options, render: () => void) => render());
    Object.assign(stage, {
      playfield: { withCaptureCursors: capture },
      keyPressOverlayPreparer: { container: keys, update: jest.fn(), keyPressOverlay: overlayStub() },
      foregroundHUDPreparer: { stats: timing, hitErrorBar: { container: bar }, container: new Container(), updateHUD },
      replayDisplaySettingsStore: { settings: DEFAULT_REPLAY_DISPLAY_SETTINGS },
    });
    const options = {
      showKeys: false,
      showTiming: true,
      showHitErrorBar: false,
      showAnalysisCursor: true,
      displaySettings: { unstableRateEnabled: false, timingBiasEnabled: true, accuracyEnabled: false },
    };
    expect(() =>
      stage.withCaptureLayers(options, () => {
        expect(timing.visible).toBe(false);
        expect(bar.visible).toBe(false);
        expect(updateHUD).toHaveBeenCalledWith(
          expect.objectContaining({ unstableRateEnabled: false, timingBiasEnabled: false, accuracyEnabled: false }),
          false,
        );
        throw new Error("capture failed");
      }),
    ).toThrow("capture failed");
    expect(capture).toHaveBeenCalledWith(options, expect.any(Function));
    expect(updateHUD).toHaveBeenLastCalledWith(expect.objectContaining({ unstableRateEnabled: false, timingBiasEnabled: false }));
    expect([keys.visible, timing.visible, bar.visible]).toEqual([true, true, true]);
    expect(DEFAULT_REPLAY_DISPLAY_SETTINGS.accuracyEnabled).toBe(true);
  });
  it("can include keys that the live view hides, and never shows timing text, without changing its preferences", () => {
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    const keys = new Container();
    const timing = new Container();
    const bar = new Container();
    keys.visible = timing.visible = bar.visible = false;
    const settings = {
      ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
      keyOverlapEnabled: false,
      unstableRateEnabled: false,
      timingBiasEnabled: false,
    };
    const keyUpdate = jest.fn();
    const updateHUD = jest.fn();
    Object.assign(stage, {
      keyPressOverlayPreparer: { container: keys, update: keyUpdate, keyPressOverlay: overlayStub() },
      foregroundHUDPreparer: { stats: timing, hitErrorBar: { container: bar }, container: new Container(), updateHUD },
      replayDisplaySettingsStore: { settings },
    });
    stage.withCaptureLayers({ showKeys: true, showTiming: true }, () => {
      expect([keys.visible, timing.visible, bar.visible]).toEqual([true, false, true]);
      expect(updateHUD).toHaveBeenCalledWith(
        expect.objectContaining({ unstableRateEnabled: false, timingBiasEnabled: false }),
        true,
      );
    });
    expect(keyUpdate).toHaveBeenCalledTimes(1);
    expect(updateHUD).toHaveBeenLastCalledWith(expect.objectContaining({ unstableRateEnabled: false, timingBiasEnabled: false }));
    expect([keys.visible, timing.visible, bar.visible]).toEqual([false, false, false]);
    expect(settings.keyOverlapEnabled).toBe(false);
    expect(settings.unstableRateEnabled).toBe(false);
    expect(settings.timingBiasEnabled).toBe(false);
  });

  it("leaves the Pixi timing text hidden and unmoved during a capture and restores all live layers after render failure", () => {
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    const keys = new Container();
    const timing = new Container();
    const bar = new Container();
    const parent = new Container();
    parent.addChild(timing);
    timing.y = 200;
    timing.updateTransform();
    Object.assign(stage, {
      keyPressOverlayPreparer: { container: keys, update: jest.fn(), keyPressOverlay: overlayStub() },
      foregroundHUDPreparer: {
        stats: timing,
        hitErrorBar: { container: bar },
        container: parent,
        updateHUD: jest.fn(),
      },
      replayDisplaySettingsStore: { settings: DEFAULT_REPLAY_DISPLAY_SETTINGS },
    });
    expect(() =>
      stage.withCaptureLayers({ showKeys: false, showTiming: false }, () => {
        expect(keys.visible).toBe(false);
        expect(timing.visible).toBe(false);
        expect(bar.visible).toBe(false);
        // Capture no longer moves the timing text (the column draws it).
        expect(timing.y).toBe(200);
        expect(timing.worldTransform.ty).toBe(200);
        throw new Error("GPU failure");
      }),
    ).toThrow("GPU failure");
    expect([keys.visible, timing.visible, bar.visible]).toEqual([true, true, true]);
    expect(timing.y).toBe(200);
    expect(timing.worldTransform.ty).toBe(200);
  });

  it("hides the key-overlap timeline and skips its per-frame update", () => {
    const settings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, keyOverlapEnabled: false };
    const keyPressOverlayPreparer = {
      container: new Container(),
      keyPressOverlay: overlayStub(),
      update: jest.fn(),
    };
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    Object.assign(stage, {
      resizeTo: jest.fn(),
      playfield: { updatePlayfield: jest.fn() },
      foregroundHUDPreparer: { updateHUD: jest.fn() },
      keyPressOverlayPreparer,
      replayDisplaySettingsStore: { settings },
    });

    stage.updateAnalysisStage();
    expect(keyPressOverlayPreparer.container.visible).toBe(false);
    expect(keyPressOverlayPreparer.update).not.toHaveBeenCalled();
    expect(keyPressOverlayPreparer.keyPressOverlay.onMouseOut).toHaveBeenCalledTimes(1);

    stage.updateAnalysisStage();
    expect(keyPressOverlayPreparer.keyPressOverlay.onMouseOut).toHaveBeenCalledTimes(1);

    settings.keyOverlapEnabled = true;
    stage.updateAnalysisStage();
    expect(keyPressOverlayPreparer.container.visible).toBe(true);
    expect(keyPressOverlayPreparer.update).toHaveBeenCalledTimes(1);
  });
});

describe("AnalysisStage frames", () => {
  function frameFixture(width = 790, height = 605) {
    const stage = Object.create(AnalysisStage.prototype) as AnalysisStage;
    const screen = { width, height };
    const background = { resize: jest.fn() };
    const playfield = { container: new Container(), updatePlayfield: jest.fn() };
    const keys = new Container();
    const hud = {
      stats: new Container(),
      hitErrorBar: { container: new Container() },
      container: new Container(),
      updateHUD: jest.fn(),
      setHudAnchors: jest.fn(),
    };
    Object.assign(stage, {
      stage: new Container(),
      rendererManager: { getRenderer: () => ({ screen }) },
      background,
      playfield,
      overlayBounds: { x: 0, y: 0, width: 510, height: 75 },
      keyPressOverlayPreparer: { container: keys, update: jest.fn(), keyPressOverlay: overlayStub() },
      foregroundHUDPreparer: hud,
      replayDisplaySettingsStore: { settings: DEFAULT_REPLAY_DISPLAY_SETTINGS },
    });
    return { stage, screen, background, playfield, hud };
  }

  it("fills the canvas without letterboxing", () => {
    const { stage, background, playfield } = frameFixture();
    stage.resizeTo();
    expect(stage.stage.scale.x).toBeCloseTo(605 / 900);
    expect([stage.stage.position.x, stage.stage.position.y]).toEqual([0, 0]);
    expect(background.resize).toHaveBeenLastCalledWith({ width: expect.closeTo(1175.2066, 3), height: 900 });
    // The 790 px cell shifts its region 2 x (140 − 66.28) = 147.4 px (219.32 frame units) in, so the playfield's left
    // edge clears the 140 px stats strip, and it shrinks to fit (was scale 1.9102 at x 98.6033).
    expect(playfield.container.scale.x).toBeCloseTo(1.7732, 4);
    expect(playfield.container.position.x).toBeCloseTo(243.3223, 3);
    expect(playfield.container.position.x * (605 / 900)).toBeGreaterThanOrEqual(140);
  });

  it("renders exports in the 1600 × 900 export frame and restores the live frame", () => {
    const { stage, background, playfield } = frameFixture();
    stage.resizeTo();
    stage.withCaptureLayers({ showKeys: false, showTiming: false }, () => {
      expect(background.resize).toHaveBeenLastCalledWith({ width: 1600, height: 900 });
      expect(playfield.container.scale.x).toBeCloseTo(1.91015625);
      expect(playfield.container.position.x).toBeCloseTo(311);
    });
    expect(background.resize).toHaveBeenLastCalledWith({ width: expect.closeTo(1175.2066, 3), height: 900 });
  });

  describe("world transforms of the layers a capture moves (the export renders with skipUpdateTransform)", () => {
    const OVERLAY = { x: 0, y: 0, width: 510, height: 75 };
    /** A 790 × 605 live stage: not 16:9, and it reserves room for the stats overlay, so its layout differs from the export frame's. */
    function mounted() {
      const fixture = frameFixture();
      const root = new Container();
      root.parent = new Container(); // like the renderer's temporary parent, so a root can update its transform
      root.addChild(fixture.stage.stage);
      fixture.stage.stage.addChild(fixture.playfield.container);
      fixture.stage.resizeTo();
      root.updateTransform();
      const scale = 605 / 900;
      const world = () => {
        const { a, d, tx, ty } = fixture.playfield.container.worldTransform;
        return { a, d, tx, ty };
      };
      const expected = (frame: Parameters<typeof calculateAnalysisStageLayout>[1]) => {
        const { playfield } = calculateAnalysisStageLayout(OVERLAY, frame);
        return { a: playfield.scale * scale, d: playfield.scale * scale, tx: playfield.left * scale, ty: playfield.top * scale };
      };
      const expectWorld = (actual: ReturnType<typeof world>, wanted: ReturnType<typeof expected>) => {
        for (const key of ["a", "d", "tx", "ty"] as const) expect(actual[key]).toBeCloseTo(wanted[key], 6);
      };
      return { ...fixture, root, world, expected, expectWorld, live: liveStageFrame(790, 605) };
    }

    it("the fixture's live layout really differs from the export frame's", () => {
      const { world, expected, live } = mounted();
      expect(world().tx).toBeCloseTo(expected(live).tx, 6);
      expect(Math.abs(expected(live).tx - expected(EXPORT_STAGE_FRAME).tx)).toBeGreaterThan(20);
      expect(Math.abs(expected(live).a - expected(EXPORT_STAGE_FRAME).a)).toBeGreaterThan(0.01);
    });

    it("withCaptureLayers renders with the export frame's world transforms and puts the live ones back", () => {
      const { stage, world, expected, expectWorld, live } = mounted();
      stage.withCaptureLayers({ showKeys: false, showTiming: false }, () => {
        expectWorld(world(), expected(EXPORT_STAGE_FRAME));
      });
      expectWorld(world(), expected(live));
    });

    it("restores the live world transforms after a failed render", () => {
      const { stage, world, expected, expectWorld, live } = mounted();
      expect(() =>
        stage.withCaptureLayers({ showKeys: false, showTiming: false }, () => {
          expectWorld(world(), expected(EXPORT_STAGE_FRAME));
          throw new Error("GPU failure");
        }),
      ).toThrow("GPU failure");
      expectWorld(world(), expected(live));
    });

    it("ending a capture session puts the live world transforms back", () => {
      const { stage, root, world, expected, expectWorld, live } = mounted();
      const capture = stage.beginCaptureLayers({ showKeys: false, showTiming: false });
      // Pixi's own update during the session (a normal render) lays the export frame out in world space.
      root.updateTransform();
      expectWorld(world(), expected(EXPORT_STAGE_FRAME));
      capture.dispose();
      expectWorld(world(), expected(live));
    });
  });

  it("restores the latest window size when a resize happened during an export session", () => {
    const { stage, screen, background } = frameFixture();
    stage.resizeTo();
    const capture = stage.beginCaptureLayers({ showKeys: false, showTiming: false });
    screen.width = 1000;
    screen.height = 600;
    stage.resizeTo();
    expect(background.resize).toHaveBeenLastCalledWith({ width: 1600, height: 900 });
    capture.dispose();
    expect(background.resize).toHaveBeenLastCalledWith({ width: 1500, height: 900 });
  });

  it("never draws the on-art UR/bias text in the live view", () => {
    expect(liveHudSettings(DEFAULT_REPLAY_DISPLAY_SETTINGS)).toMatchObject({
      unstableRateEnabled: false,
      timingBiasEnabled: false,
      accuracyEnabled: DEFAULT_REPLAY_DISPLAY_SETTINGS.accuracyEnabled,
    });
  });
});

describe("AnalysisStage key overlay length", () => {
  beforeEach(() => {
    jest.spyOn(Texture, "WHITE", "get").mockReturnValue(Texture.EMPTY as typeof Texture.WHITE);
    // jsdom has no 2D canvas, so the key caps' text cannot be measured or drawn here.
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    jest.spyOn(Text.prototype, "updateText").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // A 1600 × 900 stage is the export frame too: the playfield spans x 311–1289 and starts at y 83.25. The panel is
  // 74.25 high (scale 0.99) and centred, so its left edge is (1600 − width × 0.99) / 2.
  const LEFT = { short: 547.55, medium: 450.65375, long: 353.7575 };
  const WIDTH = { short: 510, medium: 705.75, long: 901.5 };

  /** A real stage and a real overlay; only the renderer, the art, the playfield and the HUD are stand-ins. */
  function liveStage(length: KeyOverlayLength) {
    const overlay = new KeyPressOverlay(new GameplayClock());
    const settings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, keyOverlayLength: length };
    const stage = new AnalysisStage(
      { getRenderer: () => ({ screen: { width: 1600, height: 900 } }) } as never,
      { createBeatmapBackground: () => ({ container: new Container(), resize: jest.fn() }) } as never,
      { createPlayfield: () => ({ container: new Container(), updatePlayfield: jest.fn() }) } as never,
      {
        container: new Container(),
        stats: new Container(),
        hitErrorBar: { container: new Container() },
        updateHUD: jest.fn(),
        setHudAnchors: jest.fn(),
      } as never,
      { container: overlay.container, keyPressOverlay: overlay, update: () => overlay.update(0) } as never,
      { settings } as never,
    );
    const expectPanel = (expected: KeyOverlayLength) => {
      expect(overlay.length).toBe(expected);
      expect(overlay.container.scale.x).toBeCloseTo(0.99, 6);
      expect(overlay.container.position.x).toBeCloseTo(LEFT[expected], 4);
      expect(overlay.container.position.y).toBe(6);
      // Inside the playfield's width and wholly above it.
      expect(overlay.container.position.x).toBeGreaterThanOrEqual(311);
      expect(overlay.container.position.x + WIDTH[expected] * 0.99).toBeLessThanOrEqual(1289);
      expect(6 + 75 * 0.99).toBeLessThan(83.25);
    };
    return { stage, overlay, settings, expectPanel };
  }

  it.each(["short", "medium", "long"] as const)("starts with the saved %s length, centred above the playfield", (length) => {
    const { expectPanel } = liveStage(length);
    expectPanel(length);
  });

  it("follows the viewer's length as it changes", () => {
    const { stage, settings, expectPanel } = liveStage("medium");
    settings.keyOverlayLength = "long";
    stage.updateAnalysisStage();
    expectPanel("long");
    settings.keyOverlayLength = "short";
    stage.updateAnalysisStage();
    expectPanel("short");
  });

  it("leaves a wheel zoom alone from frame to frame", () => {
    const { stage, overlay } = liveStage("medium");
    overlay.onWindowDurationChange(800);
    stage.updateAnalysisStage();
    stage.updateAnalysisStage();
    expect(overlay.windowDuration).toBe(800);
  });

  it("an export session draws the clip's own length and window, then gives the viewer's length and zoom back", () => {
    const { stage, overlay, expectPanel } = liveStage("medium");
    overlay.onWindowDurationChange(800);
    const options = { showKeys: true, showTiming: false, displaySettings: { keyOverlayLength: "long" as const } };
    const capture = stage.beginCaptureLayers(options);
    expectPanel("long");
    expect(overlay.windowDuration).toBe(420);
    stage.updateAnalysisStage();
    stage.withCaptureLayers(options, () => {
      expectPanel("long");
      expect(overlay.windowDuration).toBe(420);
    });
    capture.dispose();
    expectPanel("medium");
    expect(overlay.windowDuration).toBe(800);
  });

  it("a clip of the viewer's length still drops the viewer's zoom while it is drawn", () => {
    const { stage, overlay, expectPanel } = liveStage("short");
    overlay.onWindowDurationChange(800);
    stage.withCaptureLayers({ showKeys: true, showTiming: false, displaySettings: { keyOverlayLength: "short" } }, () => {
      expectPanel("short");
      expect(overlay.windowDuration).toBe(210);
    });
    expectPanel("short");
    expect(overlay.windowDuration).toBe(800);
  });

  it("a single capture takes its length from the settings it is given and restores the viewer's after a failure", () => {
    const { stage, overlay, expectPanel } = liveStage("long");
    const clipSettings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, keyOverlayLength: "short" as const };
    expect(() =>
      stage.withCaptureLayers(
        { showKeys: true, showTiming: false },
        () => {
          expectPanel("short");
          expect(overlay.windowDuration).toBe(210);
          throw new Error("GPU failure");
        },
        clipSettings,
      ),
    ).toThrow("GPU failure");
    expectPanel("long");
    expect(overlay.windowDuration).toBe(420);
  });
});
