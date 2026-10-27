import { SETTINGS_MIGRATION_KEY, SETTINGS_MIGRATION_VALUE, migrateSettings } from "./settings-migration";

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function make(entries: Record<string, unknown>): FakeStorage {
  const storage = new FakeStorage();
  for (const [key, value] of Object.entries(entries)) {
    storage.map.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return storage;
}

function read(storage: FakeStorage, key: string): Record<string, unknown> {
  const raw = storage.getItem(key);
  if (raw === null) throw new Error(`missing ${key}`);
  return JSON.parse(raw);
}

const COUNTER_KEYS = ["liveResult100Enabled", "liveResult50Enabled", "liveResultMissEnabled"];
const SLIDER_KEYS = ["liveResultSliderBreakEnabled", "liveResultSliderTickEnabled", "liveResultSliderEndEnabled"];

describe("migrateSettings", () => {
  it("turns a hidden counter group into three hidden results", () => {
    const storage = make({ "replay-display": { judgementCountsEnabled: false } });
    migrateSettings(storage);
    const saved = read(storage, "replay-display");
    for (const key of COUNTER_KEYS) expect(saved[key]).toBe(false);
    for (const key of SLIDER_KEYS) expect(saved).not.toHaveProperty(key);
  });

  it("turns hidden slider results into three hidden slider keys", () => {
    const storage = make({ "replay-display": { sliderJudgementsEnabled: false } });
    migrateSettings(storage);
    const saved = read(storage, "replay-display");
    for (const key of SLIDER_KEYS) expect(saved[key]).toBe(false);
    for (const key of COUNTER_KEYS) expect(saved).not.toHaveProperty(key);
  });

  it("moves the viewer UR bar from the hit-error store", () => {
    const storage = make({
      "replay-display": { statsStyle: "compact" },
      "hit-error": { enabled: false, scale: 3 },
    });
    migrateSettings(storage);
    expect(read(storage, "replay-display")).toEqual({
      statsStyle: "compact",
      hitErrorBarEnabled: false,
      hitErrorBarScale: 3,
    });

    const bare = make({ "hit-error": { enabled: false, scale: 3 } });
    migrateSettings(bare);
    expect(read(bare, "replay-display")).toEqual({ hitErrorBarEnabled: false, hitErrorBarScale: 3 });
  });

  it("moves the clip UR bar switch and keeps the size clips were rendered with", () => {
    const storage = make({ "clip-export": { showHitErrorBar: false }, "hit-error": { scale: 1.5 } });
    migrateSettings(storage);
    expect(read(storage, "clip-export").displaySettings).toEqual({
      hitErrorBarEnabled: false,
      hitErrorBarScale: 1.5,
    });
  });

  it("applies the grouped-key rule to the clip display settings", () => {
    const storage = make({
      "clip-export": { displaySettings: { judgementCountsEnabled: false, sliderJudgementsEnabled: false } },
    });
    migrateSettings(storage);
    const display = read(storage, "clip-export").displaySettings as Record<string, unknown>;
    for (const key of [...COUNTER_KEYS, ...SLIDER_KEYS]) expect(display[key]).toBe(false);
  });

  it("creates the clip store with the old viewer scale when it was not 2.0", () => {
    const storage = make({ "hit-error": { scale: 3 } });
    migrateSettings(storage);
    expect(read(storage, "clip-export")).toEqual({ displaySettings: { hitErrorBarScale: 3 } });

    const defaultScale = make({ "hit-error": { scale: 2 } });
    migrateSettings(defaultScale);
    expect(defaultScale.getItem("clip-export")).toBeNull();
  });

  it.each([0, -1, null, 1e9, "2"])("drops an unusable saved scale %p", (scale) => {
    const storage = make({ "replay-display": {}, "clip-export": {}, "hit-error": { enabled: true, scale } });
    migrateSettings(storage);
    expect(read(storage, "replay-display")).not.toHaveProperty("hitErrorBarScale");
    expect(read(storage, "clip-export").displaySettings).not.toHaveProperty("hitErrorBarScale");
    expect(read(storage, "replay-display").hitErrorBarEnabled).toBe(true);
  });

  it.each([0, -1, null, 1e9, "2"])(
    "does not create the clip store or the viewer store for a lone scale %p",
    (scale) => {
      const storage = make({ "hit-error": { scale } });
      migrateSettings(storage);
      expect(storage.getItem("clip-export")).toBeNull();
      expect(storage.getItem("replay-display")).toBeNull();
      expect(storage.getItem(SETTINGS_MIGRATION_KEY)).toBe(SETTINGS_MIGRATION_VALUE);
    },
  );

  it.each(['{"a":', "[]", '"x"', "null", "42"])(
    "ignores a hit-error value that is not a JSON object (%s) and still migrates the others",
    (broken) => {
      const storage = make({ "hit-error": broken, "replay-display": { judgementCountsEnabled: false } });
      migrateSettings(storage);
      expect(storage.getItem("hit-error")).toBe(broken);
      const saved = read(storage, "replay-display");
      expect(saved).toMatchObject({ liveResult100Enabled: false });
      expect(saved).not.toHaveProperty("hitErrorBarEnabled");
      expect(saved).not.toHaveProperty("hitErrorBarScale");
      expect(storage.getItem("clip-export")).toBeNull();
      expect(storage.getItem(SETTINGS_MIGRATION_KEY)).toBe(SETTINGS_MIGRATION_VALUE);
    },
  );

  it.each(['{"a":', "[]", '"x"', "null", "42"])(
    "leaves a clip-export value that is not a JSON object (%s) alone and still migrates the viewer",
    (broken) => {
      const storage = make({
        "clip-export": broken,
        "replay-display": { sliderJudgementsEnabled: false },
        "hit-error": { enabled: false, scale: 3 },
      });
      migrateSettings(storage);
      expect(storage.getItem("clip-export")).toBe(broken);
      expect(read(storage, "replay-display")).toMatchObject({
        liveResultSliderBreakEnabled: false,
        hitErrorBarEnabled: false,
        hitErrorBarScale: 3,
      });
      expect(storage.getItem(SETTINGS_MIGRATION_KEY)).toBe(SETTINGS_MIGRATION_VALUE);
    },
  );

  it.each(['{"a":', "[]", '"x"', "null", "42"])(
    "leaves a key that is not a JSON object alone and still migrates the others (%s)",
    (broken) => {
      const storage = make({
        "replay-display": broken,
        "clip-export": { displaySettings: { judgementCountsEnabled: false } },
      });
      migrateSettings(storage);
      expect(storage.getItem("replay-display")).toBe(broken);
      expect(read(storage, "clip-export").displaySettings).toMatchObject({ liveResult100Enabled: false });
      expect(storage.getItem(SETTINGS_MIGRATION_KEY)).toBe(SETTINGS_MIGRATION_VALUE);
    },
  );

  it("never overwrites a key that already has a value", () => {
    const storage = make({
      "replay-display": {
        judgementCountsEnabled: false,
        liveResult100Enabled: true,
        hitErrorBarEnabled: true,
        hitErrorBarScale: 1,
      },
      "clip-export": {
        showHitErrorBar: false,
        displaySettings: { hitErrorBarEnabled: true, hitErrorBarScale: 4 },
      },
      "hit-error": { enabled: false, scale: 3 },
    });
    migrateSettings(storage);
    const viewer = read(storage, "replay-display");
    expect(viewer.liveResult100Enabled).toBe(true);
    expect(viewer.liveResult50Enabled).toBe(false);
    expect(viewer.hitErrorBarEnabled).toBe(true);
    expect(viewer.hitErrorBarScale).toBe(1);
    expect(read(storage, "clip-export").displaySettings).toMatchObject({
      hitErrorBarEnabled: true,
      hitErrorBarScale: 4,
    });
  });

  it("is idempotent", () => {
    const storage = make({
      "replay-display": { judgementCountsEnabled: false },
      "clip-export": { showHitErrorBar: false },
      "hit-error": { enabled: false, scale: 3 },
    });
    migrateSettings(storage);
    const once = new Map(storage.map);
    migrateSettings(storage);
    expect(storage.map).toEqual(once);
    storage.map.delete(SETTINGS_MIGRATION_KEY);
    migrateSettings(storage);
    expect(storage.map).toEqual(once);
  });

  it("returns at once when the marker is already set", () => {
    const storage = make({
      [SETTINGS_MIGRATION_KEY]: SETTINGS_MIGRATION_VALUE,
      "replay-display": { judgementCountsEnabled: false },
    });
    migrateSettings(storage);
    expect(read(storage, "replay-display")).toEqual({ judgementCountsEnabled: false });
  });

  it("writes nothing but the marker on a first run with empty storage", () => {
    const storage = new FakeStorage();
    migrateSettings(storage);
    expect([...storage.map.entries()]).toEqual([[SETTINGS_MIGRATION_KEY, SETTINGS_MIGRATION_VALUE]]);
  });

  it("does not throw and does not set the marker when a data write throws", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const storage = make({ "replay-display": { judgementCountsEnabled: false } });
      const original = storage.setItem.bind(storage);
      storage.setItem = (key: string, value: string) => {
        if (key === "replay-display") throw new Error("quota");
        original(key, value);
      };
      expect(() => migrateSettings(storage)).not.toThrow();
      expect(storage.getItem(SETTINGS_MIGRATION_KEY)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("writes the marker last", () => {
    const storage = make({
      "replay-display": { judgementCountsEnabled: false },
      "clip-export": { showHitErrorBar: false },
      "hit-error": { enabled: false, scale: 3 },
    });
    const written: string[] = [];
    const original = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      written.push(key);
      original(key, value);
    };
    migrateSettings(storage);
    expect(written.length).toBeGreaterThan(1);
    expect(written[written.length - 1]).toBe(SETTINGS_MIGRATION_KEY);
    expect(written.filter((key) => key === SETTINGS_MIGRATION_KEY)).toHaveLength(1);
  });

  it("leaves the old keys in place", () => {
    const storage = make({
      "replay-display": { judgementCountsEnabled: false, sliderJudgementsEnabled: false },
      "clip-export": { showHitErrorBar: false, displaySettings: { judgementCountsEnabled: false } },
      "hit-error": { enabled: false, scale: 3 },
    });
    migrateSettings(storage);
    expect(read(storage, "hit-error")).toEqual({ enabled: false, scale: 3 });
    expect(read(storage, "replay-display")).toMatchObject({
      judgementCountsEnabled: false,
      sliderJudgementsEnabled: false,
    });
    const clip = read(storage, "clip-export");
    expect(clip.showHitErrorBar).toBe(false);
    expect(clip.displaySettings).toMatchObject({ judgementCountsEnabled: false });
  });
});
