import { render, screen, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";
import { InspectorHeader } from "./InspectorHeader";
import { useReadoutIdentity } from "../../hooks/readout";
import { useAnalysisApp } from "../../providers/TheaterProvider";

jest.mock("../../hooks/readout", () => ({ useReadoutIdentity: jest.fn() }));
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("./RulesetSwitch", () => ({
  RulesetSwitch: ({ preview }: { preview?: string }) => <div data-testid="ruleset-switch" data-preview={preview ?? ""} />,
}));
jest.mock("./OpenReplayButton", () => ({
  OpenReplayButton: ({ disabled }: { disabled: boolean }) => <button disabled={disabled}>Open replay</button>,
}));
jest.mock("../replay-library-host",()=>({LibraryViewerStepper:()=><div data-testid="library-stepper"/>}));

const folder = (value: string | undefined, state: ReplayLoadState = { phase: "ready" }) =>
  (useAnalysisApp as jest.Mock).mockReturnValue({
    osuFolderService: { getOsuFolder: () => value },
    scenarioManager: { loadState$: new BehaviorSubject<ReplayLoadState>(state) },
  });

const modAlts = () =>
  within(screen.getByRole("list", { name: "Replay mods" }))
    .getAllByRole("img")
    .map((image) => image.getAttribute("alt"));

describe("InspectorHeader", () => {
  it("shows artist - title, difficulty · mapper, player and no mods for No Mod", () => {
    folder("D:\\osu!");
    (useReadoutIdentity as jest.Mock).mockReturnValue({
      artist: "xi",
      title: "ANiMA",
      difficulty: "Oberum Primus",
      mapper: "Kalindraz",
      player: "WinterBird",
      mods: "NM",
      ruleset: "Stable",
    });
    render(<InspectorHeader />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("xi - ANiMA");
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("title")).toBe("xi - ANiMA");
    expect(screen.getByText("[Oberum Primus] · Kalindraz")).toBeTruthy();
    expect(screen.getByText("WinterBird")).toBeTruthy();
    expect(screen.getByTestId("library-stepper").closest("header")).toBeTruthy();
    // No Mod shows nothing: no text, no list, no empty box.
    expect(screen.queryByText("NM")).toBeNull();
    expect(screen.queryByRole("list", { name: "Replay mods" })).toBeNull();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByTestId("ruleset-switch")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open replay" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("leaves out what the beatmap or replay does not provide", () => {
    folder("D:\\osu!");
    (useReadoutIdentity as jest.Mock).mockReturnValue({ title: "Unknown beatmap", mods: "HD", ruleset: "Stable" });
    render(<InspectorHeader />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Unknown beatmap");
    expect(screen.queryByText(/·/)).toBeNull();
    expect(screen.queryByText("HD")).toBeNull();
    expect(modAlts()).toEqual(["Hidden (HD)"]);
  });

  it("stays on one line at 204 px: the player name ellipsises, the mod badges and the switch keep their size", () => {
    folder("D:\\osu!");
    (useReadoutIdentity as jest.Mock).mockReturnValue({
      artist: "A very long artist name",
      title: "An extremely long beatmap title that cannot fit",
      difficulty: "Oberum Primus",
      mapper: "Kalindraz",
      player: "A player with a very long name",
      mods: "HDDTHR",
      ruleset: "Stable",
    });
    const { container } = render(<InspectorHeader />);
    // Title row: the title column gives way (ellipsis); the folder button is a fixed 28 px.
    const heading = getComputedStyle(screen.getByRole("heading", { level: 1 }));
    expect([heading.overflow, heading.textOverflow, heading.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
    const titleColumn = (container.querySelector("[data-header-title-row]") as HTMLElement).firstElementChild as HTMLElement;
    expect(getComputedStyle(titleColumn).minWidth).toBe("0");
    const subtitle = getComputedStyle(screen.getByText("[Oberum Primus] · Kalindraz"));
    expect([subtitle.overflow, subtitle.textOverflow, subtitle.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
    // Player row: never wraps; the name shrinks to an ellipsis, the tag and the switch never do.
    const row = getComputedStyle(container.querySelector("[data-header-identity-row]") as Element);
    expect([row.display, row.flexWrap]).toEqual(["flex", "nowrap"]);
    const player = getComputedStyle(screen.getByText("A player with a very long name"));
    expect([player.minWidth, player.overflow, player.textOverflow, player.whiteSpace, player.flexShrink]).toEqual([
      "0",
      "hidden",
      "ellipsis",
      "nowrap",
      "1",
    ]);
    expect(screen.getByText("A player with a very long name").title).toBe("A player with a very long name");
    // The badges are 16 px tall, 4 px apart, in the identity row where the text tag used to be.
    expect(modAlts()).toEqual(["Hidden (HD)", "Double Time (DT)", "Hard Rock (HR)"]);
    const mods = screen.getByRole("list", { name: "Replay mods" });
    expect(getComputedStyle(mods).flexShrink).toBe("0");
    expect(getComputedStyle(mods).gap).toBe("4px");
    expect(mods.parentElement).toBe(container.querySelector("[data-header-identity-row]"));
    for (const image of within(mods).getAllByRole("img")) expect(getComputedStyle(image).height).toBe("16px");
    // The switch is `flex: none` itself (RulesetSwitch is mocked here; its own spec and source pin that).
    expect(screen.getByTestId("ruleset-switch").parentElement).toBe(container.querySelector("[data-header-identity-row]"));
  });

  it("keeps its shape with no replay and disables opening without an osu! folder", () => {
    folder(undefined);
    (useReadoutIdentity as jest.Mock).mockReturnValue(undefined);
    render(<InspectorHeader />);
    expect(screen.getByRole("heading", { level: 1, name: "No replay loaded" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open replay" }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("without a ready replay", () => {
    const LONG_NAME = `${"A very long player name - artist - title ".repeat(3)}.osr`.slice(0, 120).padEnd(120, "x");
    const fileName = "WinterBird - xi - ANiMA [Oberum Primus] (2026-08-18) Osu.osr";
    const mapSoFar = { artist: "xi", title: "ANiMA", difficulty: "Oberum Primus", mapper: "Kalindraz" };

    function renderState(state: ReplayLoadState) {
      folder("D:\\osu!", state);
      // The readout has no replay to read while a replay is not ready.
      (useReadoutIdentity as jest.Mock).mockReturnValue(undefined);
      return render(<InspectorHeader />);
    }

    it("idle: Hindsight and the open button on one row, nothing else", () => {
      const { container } = renderState({ phase: "idle" });
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading.textContent).toBe("Hindsight");
      expect(screen.getByRole("button", { name: "Open replay" })).toBeTruthy();
      expect(screen.queryByRole("group")).toBeNull();
      expect(screen.queryByTestId("ruleset-switch")).toBeNull();
      expect(container.querySelector("[data-header-identity-row]")).toBeNull();
      expect(screen.queryByText("No replay loaded")).toBeNull();
      const header = getComputedStyle(container.querySelector("header") as Element);
      expect(header.minHeight).toBe("72px");
    });

    it("idle: still disables opening without an osu! folder", () => {
      folder(undefined, { phase: "idle" });
      (useReadoutIdentity as jest.Mock).mockReturnValue(undefined);
      render(<InspectorHeader />);
      expect((screen.getByRole("button", { name: "Open replay" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("loading with the header only: file name, player, mods and a switch previewing the ruleset", () => {
      renderState({ phase: "loading", step: "find-beatmap", fileName, player: "WinterBird", mods: "HDDT", ruleset: "Lazer" });
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading.textContent).toBe(fileName);
      expect(heading.getAttribute("title")).toBe(fileName);
      expect(screen.getByText("WinterBird")).toBeTruthy();
      expect(screen.queryByText("HDDT")).toBeNull();
      expect(modAlts()).toEqual(["Hidden (HD)", "Double Time (DT)"]);
      expect(screen.getByTestId("ruleset-switch").getAttribute("data-preview")).toBe("Lazer");
      expect(screen.queryByText(/·/)).toBeNull();
      expect(screen.getByRole("button", { name: "Open replay" })).toBeTruthy();
    });

    it("loading before the replay is read: the file name only, no identity, no switch", () => {
      renderState({ phase: "loading", step: "read-replay", fileName });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(fileName);
      expect(screen.queryByTestId("ruleset-switch")).toBeNull();
      expect(screen.queryByText("NM")).toBeNull();
      expect(screen.queryByRole("list", { name: "Replay mods" })).toBeNull();
    });

    it("loading with the map: artist - title and the difficulty · mapper subtitle", () => {
      renderState({
        phase: "loading",
        step: "simulate",
        fileName,
        player: "WinterBird",
        mods: "NM",
        ruleset: "Stable",
        map: mapSoFar,
      });
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading.textContent).toBe("xi - ANiMA");
      expect(heading.getAttribute("title")).toBe("xi - ANiMA");
      expect(screen.getByText("[Oberum Primus] · Kalindraz")).toBeTruthy();
      expect(screen.queryByText(fileName)).toBeNull();
      // No Mod while loading: nothing where the mods go.
      expect(screen.queryByText("NM")).toBeNull();
      expect(screen.queryByRole("list", { name: "Replay mods" })).toBeNull();
    });

    it("beatmap-not-found: Unknown beatmap with the file name below it", () => {
      renderState({
        phase: "failed",
        fileName,
        player: "WinterBird",
        mods: "NM",
        ruleset: "Stable",
        failure: { kind: "beatmap-not-found", lookup: "not-found" },
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Unknown beatmap");
      const name = screen.getByText(fileName);
      expect(name.getAttribute("title")).toBe(fileName);
      expect(getComputedStyle(name).fontFamily).toContain("Geist Mono");
      expect(screen.getByText("WinterBird")).toBeTruthy();
      expect(screen.getByTestId("ruleset-switch").getAttribute("data-preview")).toBe("Stable");
    });

    it("shows the found map above a generic failure", () => {
      renderState({
        phase: "failed",
        fileName,
        player: "WinterBird",
        mods: "NM",
        ruleset: "Stable",
        map: mapSoFar,
        failure: { kind: "other", message: "The audio file is missing" },
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("xi - ANiMA");
      expect(screen.getByText("[Oberum Primus] · Kalindraz")).toBeTruthy();
      expect(screen.queryByText("Unknown beatmap")).toBeNull();
      expect(screen.queryByText(fileName)).toBeNull();
    });

    it("shows the file name as the heading for a generic failure before the map was found", () => {
      renderState({ phase: "failed", fileName, failure: { kind: "other", message: "The file could not be read" } });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(fileName);
      expect(screen.queryByText("Unknown beatmap")).toBeNull();
      expect(screen.queryByTestId("ruleset-switch")).toBeNull();
    });

    it("truncates a long file name: one line, ellipsis, the full name in title", () => {
      expect(LONG_NAME).toHaveLength(120);
      for (const state of [
        { phase: "loading", step: "find-beatmap", fileName: LONG_NAME },
        { phase: "failed", fileName: LONG_NAME, failure: { kind: "beatmap-not-found", lookup: "not-found" } },
      ] as ReplayLoadState[]) {
        const { container, unmount } = renderState(state);
        const element = screen.getByTitle(LONG_NAME);
        const style = getComputedStyle(element);
        expect([style.overflow, style.textOverflow, style.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
        expect(element.textContent).toBe(LONG_NAME);
        const column = (container.querySelector("[data-header-title-row]") as HTMLElement).firstElementChild as HTMLElement;
        expect(column.contains(element)).toBe(true);
        expect(getComputedStyle(column).minWidth).toBe("0");
        unmount();
      }
    });

    it("truncates a long player name in the identity row while loading", () => {
      const player = "A player with a very long name that cannot fit";
      const { container } = renderState({
        phase: "loading",
        step: "simulate",
        fileName,
        player,
        mods: "HDDTHR",
        ruleset: "Stable",
      });
      const row = getComputedStyle(container.querySelector("[data-header-identity-row]") as Element);
      expect([row.display, row.flexWrap]).toEqual(["flex", "nowrap"]);
      const name = getComputedStyle(screen.getByText(player));
      expect([name.minWidth, name.overflow, name.textOverflow, name.whiteSpace]).toEqual(["0", "hidden", "ellipsis", "nowrap"]);
      expect(screen.getByText(player).title).toBe(player);
    });
  });
});
