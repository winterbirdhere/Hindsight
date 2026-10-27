import { render, screen } from "@testing-library/react";
import { act, StrictMode } from "react";
import { BehaviorSubject } from "rxjs";
import type { LiveReplayStats } from "../../services/analysis/live-replay-stats";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { GameCanvas } from "./GameCanvas";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../../services/analysis/replay-display-settings";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";

jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("../../hooks/app-info", () => ({ useAppInfo: () => ({ platform: "win32", appVersion: "test" }) }));

const stableStats: LiveReplayStats = {
  count100: 12,
  count50: 3,
  countMiss: 2,
  sliderBreakCount: 1,
  sliderEndMissCount: 3,
  maxComboSoFar: 456,
  mapMaxCombo: 2136,
};

describe("GameCanvas missing beatmap", () => {
  const beatmapUrl = "https://osu.ppy.sh/beatmapsets/12345#osu/67890";
  let loadState$: BehaviorSubject<ReplayLoadState>;

  beforeEach(() => {
    loadState$ = new BehaviorSubject<ReplayLoadState>({
      phase: "failed",
      failure: { kind: "beatmap-not-found", lookup: "found", beatmapUrl },
    });
    (useAnalysisApp as jest.Mock).mockReturnValue({
      scenarioManager: { loadState$ },
      osuFolderService: { getOsuFolder: jest.fn() },
      gameSimulator: {
        rulesetFocus$: new BehaviorSubject("stable"),
        getCurrentScoreStats: () => stableStats,
      },
      replayDisplaySettingsStore: {
        settings: DEFAULT_REPLAY_DISPLAY_SETTINGS,
        settings$: new BehaviorSubject(DEFAULT_REPLAY_DISPLAY_SETTINGS),
      },
      onEnter: jest.fn(),
      onHide: jest.fn(),
      performanceTimeline: {
        changed$: new BehaviorSubject(0),
        at: () => ({ point: { pp: 42.5, sr: 1.23, time: 1000 }, description: "Stable" }),
      },
      gameClock: { timeElapsedInMs: 1000 },
    });
  });

  afterEach(() => loadState$.complete());

  it("draws the inner stage vignette without blocking pointer input (spec §2.1)", () => {
    loadState$.next({ phase: "ready" });
    render(<GameCanvas />);
    const vignette = screen.getByTestId("stage-vignette");
    expect(vignette.getAttribute("aria-hidden")).toBe("true");
    const style = getComputedStyle(vignette);
    expect(style.pointerEvents).toBe("none");
    expect(style.boxShadow).toContain("inset 0 0 60px rgba(0,0,0,0.55)");
  });

  it("sets the stage text at the card's 1.4 line height, not the body default", () => {
    loadState$.next({ phase: "idle" });
    render(<GameCanvas />);
    expect(getComputedStyle(screen.getByTestId("stage-overlay")).lineHeight).toBe("1.4");
  });

  it("gives each StrictMode renderer setup a fresh canvas after the previous context is released", () => {
    const analysisApp = (useAnalysisApp as jest.Mock)();
    const canvases: HTMLCanvasElement[] = [];
    const releasedCanvases: HTMLCanvasElement[] = [];
    analysisApp.onEnter.mockImplementation((canvas: HTMLCanvasElement) => {
      expect(canvas.isConnected).toBe(true);
      canvases.push(canvas);
    });
    analysisApp.onHide.mockImplementation(() => releasedCanvases.push(canvases[canvases.length - 1]));

    const { container, unmount } = render(
      <StrictMode>
        <GameCanvas />
      </StrictMode>,
    );

    expect(canvases).toHaveLength(2);
    expect(canvases[1]).not.toBe(canvases[0]);
    expect(releasedCanvases).toEqual([canvases[0]]);
    expect(canvases[0].isConnected).toBe(false);
    expect(Array.from(container.querySelectorAll("canvas"))).toEqual([canvases[1]]);

    unmount();

    expect(releasedCanvases).toEqual(canvases);
    expect(canvases[1].isConnected).toBe(false);
  });

  it("offers the resolved beatmap page alongside the friendly message", () => {
    const { container } = render(<GameCanvas />);
    const link = screen.getByRole("link", { name: "Find beatmap on osu! web" });

    expect(screen.getByText("It isn't in your Songs folder.")).toBeTruthy();
    expect(link.getAttribute("href")).toBe(beatmapUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).not.toContain("MD5");
  });

  it("shows the online lookup failure without a download link", () => {
    loadState$.next({ phase: "failed", failure: { kind: "beatmap-not-found", lookup: "not-found" } });
    const { container } = render(<GameCanvas />);

    expect(screen.getByText("It isn't in your Songs folder and couldn't be found online.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Find beatmap on osu! web" })).toBeNull();
    expect(container.textContent).not.toContain("MD5");
  });

  it("removes the previous beatmap link while loading and when the scenario changes", () => {
    render(<GameCanvas />);
    expect(screen.getByRole("link", { name: "Find beatmap on osu! web" })).toBeTruthy();

    act(() => loadState$.next({ phase: "loading", step: "read-replay" }));
    expect(screen.queryByRole("link", { name: "Find beatmap on osu! web" })).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();

    act(() =>
      loadState$.next({ phase: "failed", failure: { kind: "other", message: "Replay file could not be read" } }),
    );
    expect(screen.getByText("Replay file could not be read")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Find beatmap on osu! web" })).toBeNull();

    act(() => loadState$.next({ phase: "idle" }));
    expect(screen.getByText("No replay open")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Find beatmap on osu! web" })).toBeNull();

    act(() => loadState$.next({ phase: "ready" }));
    expect(screen.queryByRole("button", { name: "Close replay" })).toBeNull();
    expect(screen.queryByTestId("live-stats-panel")).toBeNull();
    expect(screen.queryByRole("link", { name: "Find beatmap on osu! web" })).toBeNull();
  });
});
