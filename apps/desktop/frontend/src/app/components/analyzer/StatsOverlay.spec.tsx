import { act, render, screen } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { StatsOverlay } from "./StatsOverlay";
import { useReadoutModel } from "../../hooks/readout";
import { useCommonManagers } from "../../providers/TheaterProvider";
import { DEFAULT_BEATMAP_BACKGROUND_SETTINGS } from "../../services/common/beatmap-background";
import { REWIND_COLORS } from "../../styles/tokens";
import type { ReadoutModel } from "../../services/analysis/readout-model";

jest.mock("../../hooks/readout", () => ({ useReadoutModel: jest.fn() }));
jest.mock("../../providers/TheaterProvider", () => ({ useCommonManagers: jest.fn() }));

const background$ = new BehaviorSubject({ ...DEFAULT_BEATMAP_BACKGROUND_SETTINGS });
beforeEach(() => {
  background$.next({ ...DEFAULT_BEATMAP_BACKGROUND_SETTINGS });
  (useCommonManagers as jest.Mock).mockReturnValue({
    beatmapBackgroundSettingsStore: {
      settings$: background$,
      get settings() {
        return background$.getValue();
      },
    },
  });
});

const model = (extra: Partial<ReadoutModel> = {}): ReadoutModel => ({
  identity: { title: "ANiMA", mods: "NM", ruleset: "Stable" },
  performance: { pp: "195.8", stars: "6.34" },
  rows: [
    { key: "ur", label: "UR", value: "178.0" },
    { key: "bias", label: "Bias", value: "−1.5", suffix: " ms" },
    { key: "combo", label: "Max Combo", value: "441", suffix: "/1140" },
  ],
  judgements: [
    { key: "100", label: "100", count: 25, color: "#8fe8af" },
    { key: "miss", label: "Miss", count: 2, color: "#ff7082" },
  ],
  ...extra,
});

describe("StatsOverlay", () => {
  it("renders nothing without a replay", () => {
    (useReadoutModel as jest.Mock).mockReturnValue(undefined);
    const { container } = render(<StatsOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it("shows pp, stars, the stacked rows and the judgement counts", () => {
    (useReadoutModel as jest.Mock).mockReturnValue(model());
    render(<StatsOverlay />);
    const overlay = screen.getByRole("complementary", { name: "Replay stats" });
    expect(overlay.textContent).toContain("195.8pp");
    expect(overlay.textContent).toContain("★ 6.34");
    expect(screen.getByText("Bias").nextElementSibling?.textContent).toBe("−1.5 ms");
    expect(screen.getByText("Max Combo").nextElementSibling?.textContent).toBe("441/1140");
    expect(screen.getByText("Miss").nextElementSibling?.textContent).toBe("2");
  });

  it("omits whole groups that settings turned off, with their dividers", () => {
    (useReadoutModel as jest.Mock).mockReturnValue(model({ performance: undefined, rows: [], judgements: [] }));
    render(<StatsOverlay />);
    const overlay = screen.getByRole("complementary", { name: "Replay stats" });
    expect(overlay.querySelectorAll("[data-divider]")).toHaveLength(0);
    expect(overlay.textContent).toBe("");
  });

  describe("the shade behind the stats", () => {
    const stats = () => screen.getByRole("complementary", { name: "Replay stats" });

    it("darkens the art's left edge when switched on, under a soft text shadow", () => {
      (useReadoutModel as jest.Mock).mockReturnValue(model());
      render(<StatsOverlay />);
      act(() => background$.next({ ...DEFAULT_BEATMAP_BACKGROUND_SETTINGS, statsShade: true }));
      expect(screen.getByTestId("stats-scrim")).toBeTruthy();
      expect(getComputedStyle(stats()).textShadow).toBe("0 1px 3px rgba(0,0,0,0.85)");
      expect(getComputedStyle(screen.getByText("UR")).color).toBe("rgb(201, 198, 192)");
    });

    it("leaves the art as it is by default, and outlines the text instead", () => {
      expect(DEFAULT_BEATMAP_BACKGROUND_SETTINGS.statsShade).toBe(false);
      (useReadoutModel as jest.Mock).mockReturnValue(model());
      render(<StatsOverlay />);
      expect(screen.queryByTestId("stats-scrim")).toBeNull();
      // A tight dark edge on every side, then a soft halo.
      expect(getComputedStyle(stats()).textShadow).toBe(
        "0 0 2px rgba(0,0,0,0.95),0 0 2px rgba(0,0,0,0.95),0 1px 4px rgba(0,0,0,0.9),0 0 12px rgba(0,0,0,0.6)",
      );
      // The grey labels go one step brighter.
      expect(REWIND_COLORS.textBright).toBe("#e2dfd9");
      expect(getComputedStyle(screen.getByText("UR")).color).toBe("rgb(226, 223, 217)");
      expect(getComputedStyle(screen.getByText("pp")).color).toBe("rgb(226, 223, 217)");
    });
  });

  it("never intercepts pointer input meant for the stage", () => {
    (useReadoutModel as jest.Mock).mockReturnValue(model());
    render(<StatsOverlay />);
    expect(getComputedStyle(screen.getByRole("complementary", { name: "Replay stats" })).pointerEvents).toBe("none");
    expect(screen.queryByTestId("stats-scrim")).toBeNull();
    act(() => background$.next({ ...DEFAULT_BEATMAP_BACKGROUND_SETTINGS, statsShade: true }));
    expect(getComputedStyle(screen.getByTestId("stats-scrim")).pointerEvents).toBe("none");
  });
});
