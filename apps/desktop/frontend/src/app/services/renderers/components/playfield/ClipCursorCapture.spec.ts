import { Container } from "pixi.js";
import { CursorPreparer } from "./CursorPreparer";
import { DEFAULT_ANALYSIS_CURSOR_SETTINGS } from "../../../analysis/analysis-cursor";

describe("clip cursor composition", () => {
  it.each([false, true])(
    "can enable Analysis Cursor only for capture and restore the live scene (failure=%s)",
    (fail) => {
      const preparer = Object.create(CursorPreparer.prototype) as CursorPreparer;
      const container = new Container();
      const classic = new Container(),
        analysis = new Container(),
        comparison = new Container();
      container.addChild(classic, comparison);
      const settings = Object.freeze({ ...DEFAULT_ANALYSIS_CURSOR_SETTINGS, enabled: false });
      Object.assign(preparer, {
        container,
        analysisCursorSettingsStore: { settings },
        updateOsuCursor: jest.fn((enabled) => {
          if (enabled) container.addChild(classic);
        }),
        updateAnalysisCursor: jest.fn((options) => {
          if (options.enabled) container.addChild(analysis);
        }),
        updateComparisonCursor: jest.fn((enabled) => {
          if (enabled) container.addChild(comparison);
        }),
      });
      const capture = () =>
        preparer.withCaptureCursors(
          { showReplayCursor: false, showAnalysisCursor: true, showComparisonCursor: false },
          () => {
            expect(container.children).toEqual([analysis]);
            expect(settings.enabled).toBe(false);
            if (fail) throw new Error("encoder render failure");
            return "captured";
          },
        );
      if (fail) expect(capture).toThrow("encoder render failure");
      else expect(capture()).toBe("captured");
      expect(container.children).toEqual([classic, comparison]);
      expect(analysis.parent).toBeNull();
      expect(settings.enabled).toBe(false);
    },
  );
});
