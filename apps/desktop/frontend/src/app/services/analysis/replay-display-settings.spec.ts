import Ajv from "ajv";
import {
  DEFAULT_REPLAY_DISPLAY_SETTINGS,
  LIVE_RESULT_KEYS,
  ReplayDisplaySettingsSchema,
  ReplayDisplaySettingsStore,
} from "./replay-display-settings";

describe("ReplayDisplaySettingsStore", () => {
  it("defaults error causes to Concise and migrates existing settings without losing choices", () => {
    const validate = new Ajv({ useDefaults: true }).compile(ReplayDisplaySettingsSchema);
    const saved: Record<string, unknown> = { statsStyle: "compact", timelineMissEnabled: false };
    expect(validate(saved)).toBe(true);
    expect(saved).toMatchObject({ errorCauseDisplay: "concise", statsStyle: "compact", timelineMissEnabled: false });
    expect(new ReplayDisplaySettingsStore().settings).toMatchObject({ errorCauseDisplay: "concise" });
    expect(validate({ errorCauseDisplay: "verbose" })).toBe(false);
  });

  it("persists Brief detail and reloads it through the real existing storage path", () => {
    jest.useFakeTimers();
    window.localStorage.removeItem("replay-display");
    const store = new ReplayDisplaySettingsStore();
    let restored: ReplayDisplaySettingsStore | undefined;
    try {
      store.init();
      store.changeSettings((draft) => Object.assign(draft, { errorCauseDisplay: "brief", timeline50Enabled: false }));
      jest.advanceTimersByTime(500);
      const persisted = window.localStorage.getItem("replay-display");
      if (!persisted) throw new Error("Expected persisted display settings");
      expect(JSON.parse(persisted)).toMatchObject({
        errorCauseDisplay: "brief",
        timeline50Enabled: false,
      });
      restored = new ReplayDisplaySettingsStore();
      restored.init();
      expect(restored.settings).toMatchObject({ errorCauseDisplay: "brief", timeline50Enabled: false });
    } finally {
      store.settings$.complete();
      restored?.settings$.complete();
      jest.useRealTimers();
      window.localStorage.removeItem("replay-display");
    }
  });

  it("keeps replay displays enabled with timeline Sliderend off by default", () => {
    const store = new ReplayDisplaySettingsStore();

    expect(store.key).toBe("replay-display");
    expect(store.getDefaultValue()).toEqual(
      expect.objectContaining(
        Object.fromEntries(
          Object.keys(DEFAULT_REPLAY_DISPLAY_SETTINGS)
            .filter(
              (key) =>
                typeof DEFAULT_REPLAY_DISPLAY_SETTINGS[key as keyof typeof DEFAULT_REPLAY_DISPLAY_SETTINGS] ===
                "boolean",
            )
            // Off by default: the timeline's slider-end marks, and the numbers beside a miss's taps.
            .map((key) => [key, key !== "timelineSliderEndEnabled" && key !== "tapNumbersEnabled"]),
        ),
      ),
    );
    expect(store.getDefaultValue()).toMatchObject({ statsStyle: "classic" });
  });

  it("fills newly introduced fields without replacing saved choices", () => {
    const validate = new Ajv({ useDefaults: true }).compile(ReplayDisplaySettingsSchema);
    const legacySettings = {};
    expect(validate(legacySettings)).toBe(true);
    expect(legacySettings).toEqual(DEFAULT_REPLAY_DISPLAY_SETTINGS);

    const saved: Record<string, unknown> = {
      performancePointsEnabled: false,
      judgementCountsEnabled: false,
      timeline100Enabled: false,
      timelineSliderEndEnabled: true,
    };

    expect(validate(saved)).toBe(true);
    expect(saved).toEqual({
      ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
      performancePointsEnabled: false,
      judgementCountsEnabled: false,
      timeline100Enabled: false,
      timelineSliderEndEnabled: true,
    });
    expect(saved.statsStyle).toBe("classic");
  });

  it("retains a saved compact style and rejects unsupported styles", () => {
    const validate = new Ajv({ useDefaults: true }).compile(ReplayDisplaySettingsSchema);
    const saved = { statsStyle: "compact", performancePointsEnabled: false };
    expect(validate(saved)).toBe(true);
    expect(saved).toMatchObject({ statsStyle: "compact", performancePointsEnabled: false });
    expect(validate({ statsStyle: "unknown" })).toBe(false);
  });

  it("loads a save from before the per-result keys with every new key at its default", () => {
    window.localStorage.setItem("replay-display", '{"judgementCountsEnabled":true,"timelineMissEnabled":false}');
    try {
      const store = new ReplayDisplaySettingsStore();
      store.init();
      try {
        expect(store.settings).toEqual({ ...DEFAULT_REPLAY_DISPLAY_SETTINGS, timelineMissEnabled: false });
        expect(store.settings).toMatchObject({
          liveResult100Enabled: true,
          liveResult50Enabled: true,
          liveResultMissEnabled: true,
          liveResultSliderBreakEnabled: true,
          liveResultSliderTickEnabled: true,
          liveResultSliderEndEnabled: true,
          hitErrorBarEnabled: true,
          hitErrorBarScale: 2,
        });
      } finally {
        store.settings$.complete();
      }
    } finally {
      window.localStorage.removeItem("replay-display");
    }
  });

  it.each([0.6, 7])("keeps a saved hitErrorBarScale of %p", (scale) => {
    window.localStorage.setItem("replay-display", JSON.stringify({ hitErrorBarScale: scale }));
    try {
      const store = new ReplayDisplaySettingsStore();
      store.init();
      try {
        expect(store.settings.hitErrorBarScale).toBe(scale);
      } finally {
        store.settings$.complete();
      }
    } finally {
      window.localStorage.removeItem("replay-display");
    }
  });

  it("gives a save from before the key overlay length the medium length, and keeps a saved one", () => {
    for (const [saved, expected] of [
      ['{"keyOverlapEnabled":false}', "medium"],
      ['{"keyOverlayLength":"short"}', "short"],
      ['{"keyOverlayLength":"long"}', "long"],
    ]) {
      window.localStorage.setItem("replay-display", saved);
      const store = new ReplayDisplaySettingsStore();
      try {
        store.init();
        expect(store.settings.keyOverlayLength).toBe(expected);
      } finally {
        store.settings$.complete();
        window.localStorage.removeItem("replay-display");
      }
    }
    expect(new ReplayDisplaySettingsStore().settings.keyOverlayLength).toBe("medium");
  });

  it("has no outline for a save from before the option existed, and keeps a saved choice", () => {
    for (const [saved, expected] of [
      ['{"accuracyEnabled":false}', "off"],
      ['{"errorOutline":"selected"}', "selected"],
      ['{"errorOutline":"off"}', "off"],
      ['{"errorOutline":"all"}', "all"],
    ] as const) {
      window.localStorage.setItem("replay-display", saved);
      const store = new ReplayDisplaySettingsStore();
      try {
        store.init();
        expect(store.settings.errorOutline).toBe(expected);
      } finally {
        store.settings$.complete();
        window.localStorage.removeItem("replay-display");
      }
    }
  });

  it("turns the miss trail on and leaves the tap numbers off for a save from before them, and keeps saved choices", () => {
    for (const [saved, trail, numbers] of [
      ['{"accuracyEnabled":false}', true, false],
      ['{"missTrailEnabled":false}', false, false],
      ['{"tapNumbersEnabled":true}', true, true],
      // The numbers were on by default under another key for one build; that saved value does not turn them on.
      ['{"tapOffsetEnabled":true}', true, false],
    ] as const) {
      window.localStorage.setItem("replay-display", saved);
      const store = new ReplayDisplaySettingsStore();
      try {
        store.init();
        expect([store.settings.missTrailEnabled, store.settings.tapNumbersEnabled]).toEqual([trail, numbers]);
      } finally {
        store.settings$.complete();
        window.localStorage.removeItem("replay-display");
      }
    }
  });

  it("rejects an error outline mode it does not offer", () => {
    const validate = new Ajv({ useDefaults: true }).compile(ReplayDisplaySettingsSchema);
    expect(validate({ errorOutline: "all" })).toBe(true);
    expect(validate({ errorOutline: "some" })).toBe(false);
    expect(validate({ errorOutline: true })).toBe(false);
  });

  it("rejects a key overlay length it does not offer", () => {
    const validate = new Ajv({ useDefaults: true }).compile(ReplayDisplaySettingsSchema);
    expect(validate({ keyOverlayLength: "long" })).toBe(true);
    expect(validate({ keyOverlayLength: "huge" })).toBe(false);
    expect(validate({ keyOverlayLength: 2 })).toBe(false);
  });

  it("lists the six live result keys in order", () => {
    expect(LIVE_RESULT_KEYS).toEqual([
      "liveResult100Enabled",
      "liveResult50Enabled",
      "liveResultMissEnabled",
      "liveResultSliderBreakEnabled",
      "liveResultSliderTickEnabled",
      "liveResultSliderEndEnabled",
    ]);
  });
});
