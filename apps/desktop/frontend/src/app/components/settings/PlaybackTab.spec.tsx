import { fireEvent, render, screen, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { useCommonManagers } from "../../providers/TheaterProvider";
import { DEFAULT_ANALYSIS_CURSOR_SETTINGS } from "../../services/analysis/analysis-cursor";
import { DEFAULT_BEATMAP_BACKGROUND_SETTINGS } from "../../services/common/beatmap-background";
import { DEFAULT_PLAY_BAR_SETTINGS } from "../../services/common/playbar";
import { DEFAULT_REPLAY_CURSOR_SETTINGS } from "../../services/common/replay-cursor";
import { PlaybackTab } from "./PlaybackTab";

jest.mock("../../providers/TheaterProvider", () => ({ useCommonManagers: jest.fn() }));

/** A store with the surface PlaybackTab uses: `settings$`, `changeSettings`, plus the two named setters. */
function mutableStore<T extends object>(initial: T) {
  const settings$ = new BehaviorSubject(initial);
  return {
    settings$,
    get settings() {
      return settings$.getValue();
    },
    changeSettings(change: (settings: T) => unknown) {
      const next = { ...settings$.getValue() };
      change(next);
      settings$.next(next);
    },
    setEnabled(enabled: boolean) {
      settings$.next({ ...settings$.getValue(), enabled });
    },
    setDim(dim: number) {
      settings$.next({ ...settings$.getValue(), dim });
    },
    setStatsShade(statsShade: boolean) {
      settings$.next({ ...settings$.getValue(), statsShade });
    },
  };
}

function mount(overrides: { replay?: object; analysis?: object; background?: object; playbar?: object } = {}) {
  const stores = {
    replayCursorSettingsStore: mutableStore({ ...DEFAULT_REPLAY_CURSOR_SETTINGS, ...overrides.replay }),
    analysisCursorSettingsStore: mutableStore({ ...DEFAULT_ANALYSIS_CURSOR_SETTINGS, ...overrides.analysis }),
    beatmapBackgroundSettingsStore: mutableStore({ ...DEFAULT_BEATMAP_BACKGROUND_SETTINGS, ...overrides.background }),
    playbarSettingsStore: mutableStore({ ...DEFAULT_PLAY_BAR_SETTINGS, ...overrides.playbar }),
  };
  (useCommonManagers as jest.Mock).mockReturnValue(stores);
  render(<PlaybackTab />);
  return stores;
}

const aSwitch = (name: string) => screen.getByRole("switch", { name }) as HTMLElement;
const aSlider = (name: string) => screen.getByRole("slider", { name }) as HTMLInputElement;

describe("PlaybackTab", () => {
  it("lists the five sections", () => {
    mount();
    for (const label of ["Replay cursor", "Analysis cursor", "Beatmap background", "Steps and speed", "Timeline"]) {
      expect(screen.getByRole("group", { name: label })).toBeTruthy();
    }
    expect(screen.getByText("Marks where each press landed.")).toBeTruthy();
  });

  it("Show cursor edits the replay cursor", () => {
    const { replayCursorSettingsStore } = mount({ replay: { enabled: true } });
    fireEvent.click(aSwitch("Show cursor"));
    expect(replayCursorSettingsStore.settings.enabled).toBe(false);
  });

  it("Smooth trail edits the replay cursor trail", () => {
    const { replayCursorSettingsStore } = mount({ replay: { enabled: true, smoothCursorTrail: false } });
    fireEvent.click(aSwitch("Smooth trail"));
    expect(replayCursorSettingsStore.settings.smoothCursorTrail).toBe(true);
  });

  it("Size edits the replay cursor scale as a fraction", () => {
    const { replayCursorSettingsStore } = mount({ replay: { enabled: true, scale: 1 } });
    fireEvent.change(aSlider("Size"), { target: { value: "150" } });
    expect(replayCursorSettingsStore.settings.scale).toBeCloseTo(1.5, 10);
    expect(aSlider("Size").min).toBe("10");
    expect(aSlider("Size").max).toBe("200");
  });

  it("Show analysis cursor edits the analysis cursor", () => {
    const { analysisCursorSettingsStore } = mount({ analysis: { enabled: false } });
    fireEvent.click(aSwitch("Show analysis cursor"));
    expect(analysisCursorSettingsStore.settings.enabled).toBe(true);
  });

  it("Dim edits the beatmap background dim as a fraction", () => {
    const { beatmapBackgroundSettingsStore } = mount({ background: { dim: 0.8 } });
    fireEvent.change(aSlider("Dim"), { target: { value: "35" } });
    expect(beatmapBackgroundSettingsStore.settings.dim).toBeCloseTo(0.35, 10);
    expect(aSlider("Dim").min).toBe("0");
    expect(aSlider("Dim").max).toBe("100");
  });

  it("Shade behind stats is off by default and edits the beatmap background", () => {
    const { beatmapBackgroundSettingsStore } = mount();
    expect(aSwitch("Shade behind stats").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Darkens the left edge behind the stats. Applies to exported clips too.")).toBeTruthy();
    fireEvent.click(aSwitch("Shade behind stats"));
    expect(beatmapBackgroundSettingsStore.settings.statsShade).toBe(true);
    expect(aSwitch("Shade behind stats").getAttribute("aria-checked")).toBe("true");
  });

  describe("Steps and speed", () => {
    const stepper = (name: string) => {
      const group = screen.getByRole("group", { name });
      const button = (label: string) => within(group).getByRole("button", { name: `${name}: ${label}` }) as HTMLButtonElement;
      return { group, button };
    };

    it("Scroll step is a stepper on Auto that goes through the beat's divisions, never a row of them", () => {
      const { playbarSettingsStore } = mount();
      const { group, button } = stepper("Scroll step");
      // Seven values, three buttons: it fits the narrowest panel.
      expect(group.querySelectorAll("button")).toHaveLength(3);
      expect(button("Auto")).toBeTruthy();
      expect(button("previous").disabled).toBe(true);
      fireEvent.click(button("next"));
      expect(playbarSettingsStore.settings.scrollStep).toBe("1/1");
      fireEvent.click(button("next"));
      expect(playbarSettingsStore.settings.scrollStep).toBe("1/2");
      expect(playbarSettingsStore.settings.difficultyGraphEnabled).toBe(true);
    });

    it("Scroll step's value opens all seven to choose from", () => {
      const { playbarSettingsStore } = mount();
      fireEvent.click(stepper("Scroll step").button("Auto"));
      const items = screen.getAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["Auto", "1/1", "1/2", "1/3", "1/4", "1/6", "1/8"]);
      fireEvent.click(items[5]);
      expect(playbarSettingsStore.settings.scrollStep).toBe("1/6");
    });

    it("Speed while holding Q is a stepper on 0.5× that stores a number", () => {
      const { playbarSettingsStore } = mount();
      const { group, button } = stepper("Speed while holding Q");
      expect(group.querySelectorAll("button")).toHaveLength(3);
      expect(button("0.5×")).toBeTruthy();
      fireEvent.click(button("previous"));
      expect(playbarSettingsStore.settings.holdSpeed).toBe(0.25);
      expect(stepper("Speed while holding Q").button("previous").disabled).toBe(true);
      fireEvent.click(stepper("Speed while holding Q").button("next"));
      fireEvent.click(stepper("Speed while holding Q").button("next"));
      expect(playbarSettingsStore.settings.holdSpeed).toBe(0.75);
      expect(stepper("Speed while holding Q").button("next").disabled).toBe(true);
    });
  });

  it("Difficulty graph edits the timeline", () => {
    const { playbarSettingsStore } = mount({ playbar: { difficultyGraphEnabled: true } });
    fireEvent.click(aSwitch("Difficulty graph"));
    expect(playbarSettingsStore.settings.difficultyGraphEnabled).toBe(false);
  });

  it("disables Smooth trail and Size while the cursor is hidden", () => {
    mount({ replay: { enabled: false } });
    expect(aSwitch("Smooth trail").getAttribute("aria-disabled")).toBe("true");
    expect(aSlider("Size").disabled).toBe(true);
    expect(aSwitch("Show cursor").getAttribute("aria-disabled")).not.toBe("true");
    expect(aSwitch("Show cursor").getAttribute("aria-checked")).toBe("false");
  });

  it("keeps Smooth trail and Size usable while the cursor is shown", () => {
    mount({ replay: { enabled: true } });
    expect(aSwitch("Smooth trail").getAttribute("aria-disabled")).not.toBe("true");
    expect(aSlider("Size").disabled).toBe(false);
  });

  it("shows the stored values", () => {
    mount({
      replay: { enabled: true, scale: 1.5, smoothCursorTrail: true },
      analysis: { enabled: true },
      background: { dim: 0.7 },
      playbar: { difficultyGraphEnabled: false },
    });
    expect(aSlider("Size").value).toBe("150");
    expect(screen.getByText("150%")).toBeTruthy();
    expect(aSlider("Dim").value).toBe("70");
    expect(screen.getByText("70%")).toBeTruthy();
    expect(aSwitch("Smooth trail").getAttribute("aria-checked")).toBe("true");
    expect(aSwitch("Show analysis cursor").getAttribute("aria-checked")).toBe("true");
    expect(aSwitch("Difficulty graph").getAttribute("aria-checked")).toBe("false");
  });
});
