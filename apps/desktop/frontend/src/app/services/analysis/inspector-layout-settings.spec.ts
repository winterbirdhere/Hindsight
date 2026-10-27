import Ajv from "ajv";
import {
  clampInspectorWidth,
  DEFAULT_INSPECTOR_LAYOUT,
  INSPECTOR_WIDTH_LIMITS,
  InspectorLayoutSettingsSchema,
  InspectorLayoutSettingsStore,
  inspectorWidthBounds,
  sanitizeInspectorLayout,
} from "./inspector-layout-settings";

describe("inspector width clamp", () => {
  it("keeps the documented limits", () => {
    expect(INSPECTOR_WIDTH_LIMITS).toEqual({ min: 240, max: 440, minStage: 480 });
    expect(DEFAULT_INSPECTOR_LAYOUT).toEqual({ visible: true, width: 260 });
  });

  it.each([
    // requested, window, expected
    [340, 1440, 340],
    [100, 1440, 240],
    [240, 1440, 240],
    [280, 1440, 280], // the former minimum is now an ordinary width
    [440, 1440, 440],
    [640, 1440, 440], // the former maximum is limited
    [900, 1440, 440],
    [900, 1000, 440],
    [600, 900, 420], // window − 480
    [500, 900, 420],
    [400, 900, 400],
    [340, 760, 280], // window − 480 = 280
    [340, 700, 240], // window − 480 < min: never below min
    [900, 0, 240],
    [339.6, 1440, 340], // whole pixels
  ])("clamps %d at window %d to %d", (requested, windowWidth, expected) => {
    expect(clampInspectorWidth(requested, windowWidth)).toBe(expected);
  });

  it("falls back to the default width for a request that is not a finite number", () => {
    expect(clampInspectorWidth(Number.NaN, 1440)).toBe(260);
    expect(clampInspectorWidth(Number.POSITIVE_INFINITY, 1440)).toBe(260);
    expect(clampInspectorWidth(Number.NaN, 700)).toBe(240); // default 260, then limited by the window
  });

  it("reports the bounds for a window width", () => {
    expect(inspectorWidthBounds(1440)).toEqual({ min: 240, max: 440 });
    expect(inspectorWidthBounds(1000)).toEqual({ min: 240, max: 440 });
    expect(inspectorWidthBounds(900)).toEqual({ min: 240, max: 420 });
    expect(inspectorWidthBounds(600)).toEqual({ min: 240, max: 240 });
  });
});

describe("sanitizeInspectorLayout", () => {
  it("passes good values through", () => {
    expect(sanitizeInspectorLayout({ visible: false, width: 500 })).toEqual({ visible: false, width: 500 });
  });

  it.each([
    [{ visible: "yes", width: "x" }],
    [{ visible: null, width: Number.NaN }],
    [{}],
    [undefined],
    [null],
    ["junk"],
  ])("falls back to the defaults for %j", (bad) => {
    expect(sanitizeInspectorLayout(bad)).toEqual({ visible: true, width: 260 });
  });

  it("keeps a numeric width of any size for the caller to clamp", () => {
    expect(sanitizeInspectorLayout({ visible: true, width: 5 }).width).toBe(5);
    expect(sanitizeInspectorLayout({ visible: true, width: 5000 }).width).toBe(5000);
  });
});

describe("InspectorLayoutSettingsStore", () => {
  afterEach(() => window.localStorage.removeItem("inspector-layout"));

  it("defaults to a visible 260 px inspector under the key inspector-layout", () => {
    const store = new InspectorLayoutSettingsStore();
    expect(store.key).toBe("inspector-layout");
    expect(store.getDefaultValue()).toEqual({ visible: true, width: 260 });
    expect(store.settings).toEqual({ visible: true, width: 260 });
  });

  it("fills missing fields from the schema defaults and rejects wrong types", () => {
    const validate = new Ajv({ useDefaults: true }).compile(InspectorLayoutSettingsSchema);
    const legacy = {};
    expect(validate(legacy)).toBe(true);
    expect(legacy).toEqual({ visible: true, width: 260 });
    const partial: Record<string, unknown> = { visible: false };
    expect(validate(partial)).toBe(true);
    expect(partial).toEqual({ visible: false, width: 260 });
    expect(validate({ width: "x" })).toBe(false);
    expect(validate({ visible: "no" })).toBe(false);
  });

  it("persists the choice and restores it through the existing storage path", () => {
    jest.useFakeTimers();
    const store = new InspectorLayoutSettingsStore();
    let restored: InspectorLayoutSettingsStore | undefined;
    try {
      store.init();
      store.changeSettings((draft) => Object.assign(draft, { visible: false, width: 480 }));
      jest.advanceTimersByTime(500);
      expect(JSON.parse(window.localStorage.getItem("inspector-layout") ?? "null")).toEqual({ visible: false, width: 480 });
      restored = new InspectorLayoutSettingsStore();
      restored.init();
      expect(restored.settings).toEqual({ visible: false, width: 480 });
    } finally {
      store.settings$.complete();
      restored?.settings$.complete();
      jest.useRealTimers();
    }
  });

  it.each([
    ['{"visible":true,"width":"x"}'],
    ['{"visible":"no","width":400}'],
    ["not json"],
  ])("loads the defaults from the bad stored value %s", (stored) => {
    window.localStorage.setItem("inspector-layout", stored);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new InspectorLayoutSettingsStore();
    try {
      store.init();
      expect(store.settings).toEqual({ visible: true, width: 260 });
    } finally {
      store.settings$.complete();
      warn.mockRestore();
    }
  });

  it("loads an out-of-range numeric width as stored and leaves clamping to the consumer", () => {
    window.localStorage.setItem("inspector-layout", '{"visible":true,"width":5}');
    const store = new InspectorLayoutSettingsStore();
    try {
      store.init();
      expect(sanitizeInspectorLayout(store.settings).width).toBe(5);
      expect(clampInspectorWidth(store.settings.width, 1440)).toBe(240);
    } finally {
      store.settings$.complete();
    }
  });

  it("clamps a stored width above the new maximum to 440", () => {
    window.localStorage.setItem("inspector-layout", '{"visible":true,"width":640}');
    const store = new InspectorLayoutSettingsStore();
    try {
      store.init();
      expect(store.settings.width).toBe(640);
      expect(clampInspectorWidth(store.settings.width, 1440)).toBe(440);
    } finally {
      store.settings$.complete();
    }
  });
});
