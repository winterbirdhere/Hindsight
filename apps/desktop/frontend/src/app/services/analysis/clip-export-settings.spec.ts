import "reflect-metadata";
import { LocalStorageLoader } from "../common/local-storage";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "./replay-display-settings";
import {
  ClipExportSettingsSchema,
  ClipExportSettingsStore,
  clipAppearanceOptions,
  sanitizeClipSpeed,
} from "./clip-export-settings";
import { validateClipOptions } from "../manager/clip-export-types";
import { DISPLAY_TOGGLES, displaySections } from "../../components/settings/display-rows";

const DEFAULT_CLIP = () => new ClipExportSettingsStore().getDefaultValue();
const OFF_RESULTS = {
  liveResult100Enabled: false,
  liveResult50Enabled: false,
  liveResultMissEnabled: false,
  liveResultSliderBreakEnabled: false,
  liveResultSliderTickEnabled: false,
  liveResultSliderEndEnabled: false,
} as const;

describe("clip export preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to 1080p60 and keeps cursor/stat choices separate from viewer defaults", () => {
    const store = new ClipExportSettingsStore();
    store.changeSettings((settings) => {
      settings.showAnalysisCursor = true;
      settings.displaySettings.performancePointsEnabled = false;
      Object.assign(settings.displaySettings, { statsStyle: "compact" });
    });
    expect(store.settings).toMatchObject({ width: 1920, fps: 60, showAnalysisCursor: true });
    expect(DEFAULT_REPLAY_DISPLAY_SETTINGS.performancePointsEnabled).toBe(true);
    expect(DEFAULT_REPLAY_DISPLAY_SETTINGS).toMatchObject({ statsStyle: "classic" });
    expect(new ClipExportSettingsStore().settings.displaySettings.performancePointsEnabled).toBe(true);
    const options = clipAppearanceOptions(store.settings);
    expect(options).toMatchObject({
      showStats: true,
      showAnalysisCursor: true,
      displaySettings: { performancePointsEnabled: false, statsStyle: "compact" },
    });
    expect(options.displaySettings).not.toBe(store.settings.displaySettings);
  });

  it("persists high quality and per-element choices across loading and fills missing defaults", () => {
    localStorage.setItem(
      "clip-export",
      JSON.stringify({
        width: 3840,
        fps: 120,
        showAnalysisCursor: true,
        displaySettings: { unstableRateEnabled: false, timingBiasEnabled: true },
      }),
    );
    const defaults = new ClipExportSettingsStore().getDefaultValue();
    const loaded = new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage();
    expect(loaded).toMatchObject({
      width: 3840,
      fps: 120,
      showAnalysisCursor: true,
      audio: true,
      displaySettings: {
        unstableRateEnabled: false,
        timingBiasEnabled: true,
        performancePointsEnabled: true,
        statsStyle: "classic",
      },
    });
    expect(clipAppearanceOptions(loaded)).toMatchObject({ showTiming: true });
  });

  it("loads a saved compact clip style and carries it into the recording snapshot", () => {
    localStorage.setItem(
      "clip-export",
      JSON.stringify({
        displaySettings: {
          statsStyle: "compact",
          liveResultSliderBreakEnabled: false,
          liveResultSliderTickEnabled: false,
          liveResultSliderEndEnabled: false,
        },
      }),
    );
    const defaults = new ClipExportSettingsStore().getDefaultValue();
    const loaded = new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage();
    const options = clipAppearanceOptions(loaded);
    expect(options.displaySettings).toMatchObject({ statsStyle: "compact", liveResultSliderBreakEnabled: false });
    expect(defaults.displaySettings).toMatchObject({ statsStyle: "classic", liveResultSliderBreakEnabled: true });
  });

  it.each([
    { ur: true, bias: false },
    { ur: false, bias: true },
    { ur: false, bias: false },
  ] as const)("gates timing by UR and bias alone, never by the stats column (%j)", ({ ur, bias }) => {
    const settings = new ClipExportSettingsStore().getDefaultValue();
    settings.displaySettings = {
      ...settings.displaySettings,
      performancePointsEnabled: false,
      starRatingEnabled: false,
      maxComboEnabled: false,
      ...OFF_RESULTS,
      unstableRateEnabled: ur,
      timingBiasEnabled: bias,
    };
    expect(clipAppearanceOptions(settings)).toMatchObject({ showStats: false, showTiming: ur || bias });
  });

  it.each([{ width: 1280 }, { fps: 30 }, { fps: "120" }, { showAnalysisCursor: "yes" }])(
    "rejects unsupported or malformed saved settings %j",
    (change) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const defaults = new ClipExportSettingsStore().getDefaultValue();
      localStorage.setItem("clip-export", JSON.stringify({ ...defaults, ...change }));
      expect(new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage()).toEqual(
        defaults,
      );
      warn.mockRestore();
    },
  );

  it("passes the clip's own UR bar switch and size", () => {
    const settings = DEFAULT_CLIP();
    settings.showHitErrorBar = true;
    settings.displaySettings = { ...settings.displaySettings, hitErrorBarEnabled: false, hitErrorBarScale: 3 };
    const options = clipAppearanceOptions(settings);
    expect(options.showHitErrorBar).toBe(false);
    expect(options.displaySettings).toMatchObject({ hitErrorBarEnabled: false, hitErrorBarScale: 3 });
    settings.showHitErrorBar = false;
    settings.displaySettings = { ...settings.displaySettings, hitErrorBarEnabled: true };
    expect(clipAppearanceOptions(settings).showHitErrorBar).toBe(true);
  });

  const QUIET = {
    performancePointsEnabled: false,
    starRatingEnabled: false,
    maxComboEnabled: false,
    unstableRateEnabled: false,
    timingBiasEnabled: false,
    ...OFF_RESULTS,
  } as const;

  it("shows the stats column when a single live result is on and everything else is off", () => {
    for (const key of Object.keys(OFF_RESULTS)) {
      const one = DEFAULT_CLIP();
      one.displaySettings = { ...one.displaySettings, ...QUIET, [key]: true };
      expect(clipAppearanceOptions(one)).toMatchObject({ showStats: true, showTiming: false });
    }
    for (const key of ["performancePointsEnabled", "starRatingEnabled", "maxComboEnabled"]) {
      const one = DEFAULT_CLIP();
      one.displaySettings = { ...one.displaySettings, ...QUIET, [key]: true };
      expect(clipAppearanceOptions(one).showStats).toBe(true);
    }
  });

  it("starts the stats column for the Combo row alone", () => {
    const only = DEFAULT_CLIP();
    only.displaySettings = { ...only.displaySettings, ...QUIET, maxComboEnabled: true };
    expect(clipAppearanceOptions(only)).toMatchObject({ showStats: true, showTiming: false });
    only.displaySettings = { ...only.displaySettings, maxComboEnabled: false };
    expect(clipAppearanceOptions(only)).toMatchObject({ showStats: false, showTiming: false });
  });

  it("a clip with every Display toggle off has no stats column", () => {
    const settings = DEFAULT_CLIP();
    const display = { ...settings.displaySettings };
    // Every key the clip's Display tab offers, read from the rows rather than listed here.
    const keys: string[] = [];
    for (const section of displaySections("clip")) {
      if (section === "cursors") continue;
      for (const { key } of DISPLAY_TOGGLES[section]) {
        display[key] = false;
        keys.push(key);
      }
    }
    // The clip's own Max combo toggle is among them, so switching them all off switches it off too.
    expect(keys).toContain("maxComboEnabled");
    settings.displaySettings = display;
    Object.assign(settings, { showReplayCursor: false, showAnalysisCursor: false, showComparisonCursor: false });
    expect(settings.displaySettings.maxComboEnabled).toBe(false);
    expect(clipAppearanceOptions(settings)).toMatchObject({ showStats: false, showTiming: false });
  });

  it("hides it when every stats row is off", () => {
    const none = DEFAULT_CLIP();
    none.displaySettings = { ...none.displaySettings, ...QUIET };
    expect(clipAppearanceOptions(none)).toMatchObject({ showStats: false, showTiming: false });
  });

  it("passes the clip's display settings through untouched", () => {
    const settings = DEFAULT_CLIP();
    // The grouped keys are no longer derived from the per-result keys, so a stale value stays as it is.
    settings.displaySettings = {
      ...settings.displaySettings,
      ...OFF_RESULTS,
      judgementCountsEnabled: true,
      sliderJudgementsEnabled: false,
      statsStyle: "compact",
      hitErrorBarScale: 2,
    };
    const options = clipAppearanceOptions(settings);
    expect(options.displaySettings).toEqual(settings.displaySettings);
    expect(options.showKeys).toBe(settings.displaySettings.keyOverlapEnabled);
  });

  it("defaults the save folder to an empty string, meaning the Videos folder", () => {
    expect(DEFAULT_CLIP().saveFolder).toBe("");
    expect(new ClipExportSettingsStore().settings.saveFolder).toBe("");
  });

  it("loads a saved store without saveFolder with an empty folder and its other values kept", () => {
    localStorage.setItem("clip-export", JSON.stringify({ width: 2560, fps: 144, audio: false, speed: 2 }));
    const defaults = new ClipExportSettingsStore().getDefaultValue();
    const loaded = new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage();
    expect(loaded).toMatchObject({ width: 2560, fps: 144, audio: false, speed: 2, saveFolder: "" });
  });

  it("keeps a saved folder through loading", () => {
    localStorage.setItem("clip-export", JSON.stringify({ saveFolder: "D:\\Clips\\osu" }));
    const defaults = new ClipExportSettingsStore().getDefaultValue();
    const loaded = new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage();
    expect(loaded.saveFolder).toBe("D:\\Clips\\osu");
  });

  it("still validates the options built from the settings, with a folder set or not", () => {
    const base = { startMs: 0, endMs: 5000, width: 1920, fps: 60, audio: true, speed: 1 } as const;
    for (const saveFolder of ["", "D:\\Clips\\osu"]) {
      const settings = { ...DEFAULT_CLIP(), saveFolder };
      expect(clipAppearanceOptions(settings)).not.toHaveProperty("saveFolder");
      expect(() => validateClipOptions({ ...base, ...clipAppearanceOptions(settings) }, 60_000)).not.toThrow();
    }
  });

  it("validates for the default store and for a store that still carries statsLayout and the grouped keys", () => {
    const duration = 60_000;
    const base = { startMs: 0, endMs: 5000, width: 1920, fps: 60, audio: true, speed: 1 } as const;
    const fresh = clipAppearanceOptions(DEFAULT_CLIP());
    expect(() => validateClipOptions({ ...base, ...fresh }, duration)).not.toThrow();
    // A saved store from before this change still has statsLayout and the grouped keys; only the loader sees them.
    const stale = { ...DEFAULT_CLIP(), statsLayout: "sidePanel" } as ReturnType<typeof DEFAULT_CLIP>;
    stale.displaySettings = { ...stale.displaySettings, judgementCountsEnabled: true, sliderJudgementsEnabled: true };
    const options = { ...base, ...clipAppearanceOptions(stale) };
    expect(options).not.toHaveProperty("statsLayout");
    expect(() => validateClipOptions(options, duration)).not.toThrow();
  });

  it("loads a saved clip store that still has statsLayout", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(
      "clip-export",
      JSON.stringify({ width: 2560, fps: 120, showAnalysisCursor: true, statsLayout: "sidePanel" }),
    );
    const defaults = new ClipExportSettingsStore().getDefaultValue();
    const loaded = new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage();
    // Loaded through the schema with its defaults: the saved choices survive, nothing is reset.
    expect(loaded).toMatchObject({ width: 2560, fps: 120, showAnalysisCursor: true, audio: true });
    expect(loaded).not.toEqual(defaults);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe("the clip speed", () => {
    const load = (saved: unknown) => {
      localStorage.setItem("clip-export", JSON.stringify(saved));
      const defaults = new ClipExportSettingsStore().getDefaultValue();
      return new LocalStorageLoader("clip-export", ClipExportSettingsSchema, defaults).loadFromLocalStorage();
    };

    it("defaults to 1 and is part of the saved settings", () => {
      expect(DEFAULT_CLIP().speed).toBe(1);
      const store = new ClipExportSettingsStore();
      store.changeSettings((draft) => void (draft.speed = 0.75));
      expect(store.settings.speed).toBe(0.75);
    });

    it("has no bound in its schema, so an old or odd saved value never resets the store", () => {
      const speed = (ClipExportSettingsSchema.properties as Record<string, Record<string, unknown>>).speed;
      expect(speed).toEqual({ type: "number", default: 1 });
      expect(ClipExportSettingsSchema.required).toEqual([]);
    });

    it("loads a store saved before the speed existed with 1, keeping its other choices", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const loaded = load({ width: 2560, fps: 120, audio: false });
      expect(loaded).toMatchObject({ width: 2560, fps: 120, audio: false, speed: 1 });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it.each([0.75, 7, 0, -1])("loads a saved speed of %s as it is, without resetting the store", (saved) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(load({ width: 3840, speed: saved })).toMatchObject({ width: 3840, speed: saved });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it.each([
      [0.75, 0.75],
      [1, 1],
      [0.25, 0.25],
      [2, 2],
      [0, 1],
      [-1, 1],
      [3, 1],
      [NaN, 1],
      ["1", 1],
      [undefined, 1],
      [null, 1],
    ] as Array<[unknown, number]>)("sanitizeClipSpeed(%p) is %p", (value, expected) => {
      expect(sanitizeClipSpeed(value)).toBe(expected);
    });
  });
});
