import { fireEvent, render, screen, within } from "@testing-library/react";
import { frontendAPI } from "../../api";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";
import { StageEmpty, StageError, StageLoading } from "./StageStates";

jest.mock("../../api", () => ({ frontendAPI: { runAppMenuAction: jest.fn() } }));
jest.mock("../../hooks/app-info", () => ({ useAppInfo: () => ({ platform: "win32", version: "test" }) }));
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

const runAppMenuAction = frontendAPI.runAppMenuAction as jest.Mock;
const beatmapUrl = "https://osu.ppy.sh/beatmapsets/12345#osu/67890";

function setOsuFolder(folder: string) {
  (useAnalysisApp as jest.Mock).mockReturnValue({ osuFolderService: { getOsuFolder: () => folder } });
}

beforeEach(() => {
  runAppMenuAction.mockReset();
  runAppMenuAction.mockResolvedValue(undefined);
  setOsuFolder("C:\\osu!");
});

describe("StageEmpty", () => {
  it("explains how to open a replay", () => {
    render(<StageEmpty />);
    expect(screen.getByRole("heading", { name: "No replay open" })).toBeTruthy();
    expect(
      screen.getByText("Drop an .osr file anywhere in this window, or open one from your Replays folder."),
    ).toBeTruthy();
    expect(screen.getByText("In osu!, press F2 on a score or fail screen to send the replay here.")).toBeTruthy();
  });

  it("opens the native picker through the bridge once", () => {
    render(<StageEmpty />);
    const button = screen.getByRole("button", { name: "Open replay" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("F2");
    expect(within(button).getByText("F2")).toBeTruthy();
    fireEvent.click(button);
    expect(runAppMenuAction).toHaveBeenCalledTimes(1);
    expect(runAppMenuAction).toHaveBeenCalledWith("openReplay");
  });

  it("is disabled without an osu! folder", () => {
    setOsuFolder("");
    render(<StageEmpty />);
    const button = screen.getByRole("button", { name: "Open replay" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(runAppMenuAction).not.toHaveBeenCalled();
  });
});

describe("StageLoading", () => {
  const loading = (
    step: NonNullable<ReplayLoadState["step"]>,
    extra: Partial<ReplayLoadState> = {},
  ): ReplayLoadState => ({ phase: "loading", step, ...extra });
  const rows = () =>
    screen.getAllByRole("listitem").map((item) => [item.textContent, item.getAttribute("data-status")]);

  it.each([
    [
      "read-replay",
      0,
      [
        ["Reading replay file", "active"],
        ["Finding beatmap in Songs", "pending"],
        ["Simulating", "pending"],
        ["Explaining misses", "pending"],
      ],
    ],
    [
      "find-beatmap",
      25,
      [
        ["Read replay file", "done"],
        ["Finding beatmap in Songs", "active"],
        ["Simulating", "pending"],
        ["Explaining misses", "pending"],
      ],
    ],
    [
      "simulate",
      50,
      [
        ["Read replay file", "done"],
        ["Found beatmap in Songs", "done"],
        ["Simulating with Stable rules", "active"],
        ["Explaining misses", "pending"],
      ],
    ],
  ] as const)("shows the four rows and progress at %s", (step, percent, expected) => {
    render(<StageLoading state={loading(step, step === "simulate" ? { ruleset: "Stable" } : {})} />);
    expect(screen.getByText("Loading replay")).toBeTruthy();
    expect(rows()).toEqual(expected);
    const active = screen.getAllByRole("listitem").filter((item) => item.getAttribute("aria-current") === "step");
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-status")).toBe("active");
    const bar = screen.getByRole("progressbar", { name: "Loading replay" });
    expect(bar.getAttribute("aria-valuenow")).toBe(String(percent));
  });

  it("draws no background image until the map's background is known", () => {
    const { container } = render(<StageLoading state={loading("find-beatmap")} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws the blurred background once known and drops it when it fails to load", () => {
    const { container } = render(
      <StageLoading state={loading("simulate", { backgroundUrl: "file:///songs/map/bg.jpg" })} />,
    );
    const image = container.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("file:///songs/map/bg.jpg");
    expect(image.getAttribute("alt")).toBe("");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps raw map art about as dark as the dimmed playfield behind the steps", () => {
    // The mock's art was an already dimmed capture; the app blurs the raw background, which needs a heavier veil.
    render(<StageLoading state={loading("simulate", { backgroundUrl: "file:///songs/map/bg.jpg" })} />);
    expect(getComputedStyle(screen.getByTestId("loading-veil")).backgroundColor).toBe("rgba(11, 11, 13, 0.86)");
  });

  it("tries a new background after a previous one failed", () => {
    const { container, rerender } = render(
      <StageLoading state={loading("simulate", { backgroundUrl: "file:///a.jpg" })} />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    rerender(<StageLoading state={loading("simulate", { backgroundUrl: "file:///b.jpg" })} />);
    expect((container.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe("file:///b.jpg");
  });
});

describe("StageError", () => {
  const notFound = (lookup: "found" | "not-found" | "unavailable"): ReplayLoadState => ({
    phase: "failed",
    failure: { kind: "beatmap-not-found", lookup, ...(lookup === "found" ? { beatmapUrl } : {}) },
  });
  const openAnother = () => screen.getByRole("button", { name: "Open another replay" });

  it("offers the beatmap page when the lookup found it", () => {
    render(<StageError state={notFound("found")} />);
    expect(screen.getByRole("heading", { name: "Beatmap not found" })).toBeTruthy();
    expect(screen.getByText("It isn't in your Songs folder.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Find beatmap on osu! web" });
    expect(link.getAttribute("href")).toBe(beatmapUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(openAnother());
    expect(runAppMenuAction).toHaveBeenCalledTimes(1);
    expect(runAppMenuAction).toHaveBeenCalledWith("openReplay");
  });

  it("says the map is not online when the lookup did not find it", () => {
    render(<StageError state={notFound("not-found")} />);
    expect(screen.getByRole("heading", { name: "Beatmap not found" })).toBeTruthy();
    expect(screen.getByText("It isn't in your Songs folder and couldn't be found online.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(openAnother());
    expect(runAppMenuAction).toHaveBeenCalledTimes(1);
  });

  it("says the online check was not possible when the lookup was unavailable", () => {
    render(<StageError state={notFound("unavailable")} />);
    expect(screen.getByRole("heading", { name: "Beatmap not found" })).toBeTruthy();
    expect(screen.getByText("It isn't in your Songs folder and Hindsight couldn't check online.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(openAnother());
    expect(runAppMenuAction).toHaveBeenCalledTimes(1);
  });

  it("wraps a long unbroken message such as a Windows path inside the column", () => {
    const message = `ENOENT: no such file or directory, open 'D:\${"Replays\\".repeat(20)}score.osr'`;
    render(<StageError state={{ phase: "failed", failure: { kind: "other", message } }} />);
    expect(getComputedStyle(screen.getByText(message)).overflowWrap).toBe("anywhere");
  });

  it("shows the real message for any other failure", () => {
    render(
      <StageError state={{ phase: "failed", failure: { kind: "other", message: "Replay file could not be read" } }} />,
    );
    expect(screen.getByRole("heading", { name: "Replay couldn't be loaded" })).toBeTruthy();
    expect(screen.getByText("Replay file could not be read")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(openAnother());
    expect(runAppMenuAction).toHaveBeenCalledTimes(1);
  });
});
