import "reflect-metadata";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import username from "username";
import { BehaviorSubject } from "rxjs";
import { useGameClockControls } from "../../hooks/game-clock";
import { useModControls } from "../../hooks/mods";
import { useShortcuts } from "../../hooks/shortcuts";
import { InspectorProvider, useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { SkinId, skinIdToString } from "../../model/SkinId";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { readOsuSkinInUse } from "../../services/setup/osu-skin-in-use";
import { thinScrollbar } from "../../styles/scrollbar";
import * as skinOptionsModule from "./skin-options";
import { SkinTab } from "./SkinTab";

jest.mock("../../providers/TheaterProvider", () => ({ useCommonManagers: jest.fn(), useAnalysisApp: jest.fn() }));
jest.mock("../../hooks/game-clock", () => ({ useGameClockControls: jest.fn() }));
jest.mock("../../hooks/mods", () => ({ useModControls: jest.fn() }));
jest.mock("username", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../services/setup/osu-skin-in-use", () => ({ readOsuSkinInUse: jest.fn() }));

const OSU_FOLDER = "D:\\osu!";
const FOLDER_SKINS = ["Lain", "- WhiteCat 2.1 -", "Cookiezi 32"];

function Mode() {
  return <span data-testid="mode">{useInspector().mode}</span>;
}

/** The shell mounts the shortcuts once, above every panel; here they sit next to the tab. */
function Shortcuts() {
  useShortcuts();
  return null;
}

function mount(
  options: {
    folderSkins?: string[];
    preferredSkinId?: string;
    skinInUse?: string | undefined;
    cfgError?: Error;
    readCfg?: () => Promise<string | undefined>;
    loadSkinList?: jest.Mock;
    loadSkin?: jest.Mock;
    /** Mount the app's real `useShortcuts` next to the tab, with a replay loaded. */
    shortcuts?: boolean;
  } = {},
) {
  const skinList$ = new BehaviorSubject<string[]>(options.folderSkins ?? FOLDER_SKINS);
  const settings$ = new BehaviorSubject({ preferredSkinId: options.preferredSkinId ?? "rewind:RewindDefaultSkin" });
  const skinSettingsStore = {
    settings$,
    get settings() {
      return settings$.getValue();
    },
  };
  const skinManager = {
    skinList$,
    loadSkinList: options.loadSkinList ?? jest.fn().mockResolvedValue(undefined),
    loadSkin:
      options.loadSkin ??
      jest.fn(async (id: SkinId) => {
        settings$.next({ preferredSkinId: skinIdToString(id) });
      }),
  };
  const osuFolderService = { getOsuFolder: jest.fn().mockReturnValue(OSU_FOLDER) };
  (useCommonManagers as jest.Mock).mockReturnValue({ skinManager, skinSettingsStore });
  const toggleClock = jest.fn();
  // Space goes through the transport toggle, which outside an export session is the clock's own toggle.
  const gameClock = new GameplayClock();
  jest.spyOn(gameClock, "toggle").mockImplementation(toggleClock);
  (useAnalysisApp as jest.Mock).mockReturnValue({
    osuFolderService,
    scenarioManager: { loadState$: new BehaviorSubject({ phase: "ready" }) },
    gameClock,
    clipRecorder: { isBusy: false },
  });
  const setHidden = jest.fn();
  (useGameClockControls as jest.Mock).mockReturnValue({
    toggleClock,
    seekBackward: jest.fn(),
    seekForward: jest.fn(),
    increaseSpeed: jest.fn(),
    decreaseSpeed: jest.fn(),
  });
  (useModControls as jest.Mock).mockReturnValue({ hidden: false, flashlight: false, setHidden });
  if (options.readCfg) (readOsuSkinInUse as jest.Mock).mockImplementation(options.readCfg);
  else if (options.cfgError) (readOsuSkinInUse as jest.Mock).mockRejectedValue(options.cfgError);
  else (readOsuSkinInUse as jest.Mock).mockResolvedValue("skinInUse" in options ? options.skinInUse : "- WhiteCat 2.1 -");
  const tree = () => (
    <InspectorProvider initialMode="settings">
      <SkinTab />
      <Mode />
      {options.shortcuts && <Shortcuts />}
    </InspectorProvider>
  );
  const view = render(tree());
  return { ...view, tree, toggleClock, setHidden, skinManager, skinSettingsStore, osuFolderService, skinList$, settings$ };
}

const rescanButton = () => screen.getByRole("button", { name: "Rescan" }) as HTMLButtonElement;
const triggerButton = () => document.querySelector("button[aria-expanded]") as HTMLButtonElement;
const searchField = () => screen.getByRole("combobox") as HTMLInputElement;
const listbox = () => screen.getByRole("listbox", { name: "Skins" });
const optionLabels = () => within(listbox()).getAllByRole("option").map((option) => option.textContent);

async function mountSettled(options: Parameters<typeof mount>[0] = {}) {
  const result = mount(options);
  await waitFor(() => expect(rescanButton().disabled).toBe(false));
  return result;
}

async function openList() {
  fireEvent.click(triggerButton());
  await screen.findByRole("listbox", { name: "Skins" });
}

/** The CSS the page carries for an element's emotion class (jsdom does not resolve every property). */
function cssOf(element: Element): string {
  const className = Array.from(element.classList).find((name) => name.startsWith("css-")) ?? "";
  // Keep the plain `.css-x{...}` rules: the `:hover` and `@media` ones are other rules.
  const rules = Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .filter((rule) => rule instanceof CSSStyleRule && rule.selectorText === `.${className}`)
    .map((rule) => rule.cssText);
  return rules.join("").replace(/\s+/g, "");
}

/** The CSS of the emotion rule that is an element's class plus a suffix such as `:focus-within` (jsdom cannot match it). */
function cssOfRule(element: Element, suffix: string): string {
  const className = Array.from(element.classList).find((name) => name.startsWith("css-")) ?? "";
  return Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .filter((rule) => rule instanceof CSSStyleRule && rule.selectorText === `.${className}${suffix}`)
    .map((rule) => rule.cssText)
    .join("")
    .replace(/\s+/g, "");
}

/** A promise that the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  (username as unknown as jest.Mock).mockResolvedValue("Player");
});

describe("SkinTab", () => {
  it("shows the current skin and the count in the search placeholder", async () => {
    await mountSettled({ preferredSkinId: "osu:Lain" });
    expect(screen.getByRole("group", { name: "Skin" })).toBeTruthy();
    expect(triggerButton().textContent).toContain("Lain");
    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");
    await openList();
    expect(triggerButton().getAttribute("aria-expanded")).toBe("true");
    // Three folder skins plus the two built-ins.
    expect(searchField().placeholder).toBe("Search 5 skins");
    const selected = within(listbox()).getByRole("option", { selected: true });
    expect(selected.textContent).toContain("Lain");
  });

  it("shows the built-in label for a built-in skin and the raw name for a malformed stored id", async () => {
    const first = await mountSettled({ preferredSkinId: "rewind:RewindDefaultSkin" });
    expect(triggerButton().textContent).toContain("Hindsight");
    first.unmount();
    await mountSettled({ preferredSkinId: "not-a-skin-id" });
    expect(triggerButton().textContent).toContain("not-a-skin-id");
    await openList();
    expect(within(listbox()).queryAllByRole("option", { selected: true })).toHaveLength(0);
  });

  it("tags the skin used in osu!", async () => {
    await mountSettled({ preferredSkinId: "osu:- WhiteCat 2.1 -" });
    expect(triggerButton().textContent).toContain("Used in osu!");
    await openList();
    expect(optionLabels()).toEqual([
      "- WhiteCat 2.1 -Used in osu!",
      "Hindsightbuilt in",
      "osu! defaultbuilt in",
      "Cookiezi 32",
      "Lain",
    ]);
    expect(within(listbox()).getAllByText("Used in osu!")).toHaveLength(1);
    expect(readOsuSkinInUse).toHaveBeenCalledWith(OSU_FOLDER, "Player");
  });

  it("asks for the cfg of no user and shows no tag when the user name cannot be read", async () => {
    (username as unknown as jest.Mock).mockRejectedValue(new Error("no user"));
    await mountSettled({ preferredSkinId: "osu:- WhiteCat 2.1 -", skinInUse: undefined });
    expect(readOsuSkinInUse).toHaveBeenCalledWith(OSU_FOLDER, "");
    expect(screen.queryByText("Used in osu!")).toBeNull();
    await openList();
    expect(screen.queryByText("Used in osu!")).toBeNull();
    // The list itself still works: built-ins, then the folder skins.
    expect(optionLabels()).toEqual(["Hindsightbuilt in", "osu! defaultbuilt in", "- WhiteCat 2.1 -", "Cookiezi 32", "Lain"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows no tag, no crash and no folder alert when reading the cfg rejects", async () => {
    await mountSettled({ preferredSkinId: "osu:Lain", cfgError: new Error("EACCES") });
    expect(readOsuSkinInUse).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Used in osu!")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await openList();
    expect(optionLabels()).toEqual(["Hindsightbuilt in", "osu! defaultbuilt in", "- WhiteCat 2.1 -", "Cookiezi 32", "Lain"]);
  });

  it("filters while typing and shows a line when nothing matches", async () => {
    await mountSettled();
    await openList();
    fireEvent.change(searchField(), { target: { value: "  LA " } });
    expect(optionLabels()).toEqual(["Lain"]);
    fireEvent.change(searchField(), { target: { value: "zzz" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("No skins match.")).toBeTruthy();
    fireEvent.change(searchField(), { target: { value: "" } });
    expect(optionLabels()).toHaveLength(5);
  });

  it("loads the chosen skin and closes the list", async () => {
    const { skinManager } = await mountSettled();
    await openList();
    fireEvent.click(within(listbox()).getByRole("option", { name: /Cookiezi 32/ }));
    expect(skinManager.loadSkin).toHaveBeenCalledWith({ source: "osu", name: "Cookiezi 32" });
    await waitFor(() => expect(triggerButton().textContent).toContain("Cookiezi 32"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("moves the active option with the arrow keys and chooses it with Enter", async () => {
    const { skinManager } = await mountSettled();
    await openList();
    // The active option starts on the selected skin (Hindsight, after the pinned one).
    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    fireEvent.keyDown(searchField(), { key: "ArrowUp" });
    const active = document.getElementById(searchField().getAttribute("aria-activedescendant") ?? "");
    expect(active?.textContent).toContain("osu! default");
    fireEvent.keyDown(searchField(), { key: "Enter" });
    expect(skinManager.loadSkin).toHaveBeenCalledWith({ source: "rewind", name: "OsuDefaultSkin" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the previous skin and says so when the load fails", async () => {
    const loadSkin = jest.fn().mockRejectedValueOnce(new Error("broken")).mockResolvedValue(undefined);
    await mountSettled({ preferredSkinId: "osu:Lain", loadSkin });
    await openList();
    fireEvent.click(within(listbox()).getByRole("option", { name: /Cookiezi 32/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't load Cookiezi 32. The previous skin is still in use.");
    expect(triggerButton().textContent).toContain("Lain");
    await openList();
    fireEvent.click(within(listbox()).getByRole("option", { name: /Hindsight/ }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rescans the folder and the cfg", async () => {
    const loadSkinList = jest.fn().mockResolvedValue(undefined);
    const { skinList$, osuFolderService } = await mountSettled({ loadSkinList });
    expect(loadSkinList).toHaveBeenCalledTimes(1);
    expect(screen.getByText("D:\\osu!\\Skins")).toBeTruthy();
    expect(osuFolderService.getOsuFolder).toHaveBeenCalled();
    loadSkinList.mockImplementation(async () => skinList$.next([...FOLDER_SKINS, "Mocha"]));
    (readOsuSkinInUse as jest.Mock).mockResolvedValue("Mocha");
    fireEvent.click(rescanButton());
    await waitFor(() => expect(readOsuSkinInUse).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rescanButton().disabled).toBe(false));
    expect(loadSkinList).toHaveBeenCalledTimes(2);
    await openList();
    expect(optionLabels()[0]).toBe("MochaUsed in osu!");
    expect(searchField().placeholder).toBe("Search 6 skins");
  });

  it("says when the Skins folder cannot be read and still offers the built-ins", async () => {
    await mountSettled({ folderSkins: [], loadSkinList: jest.fn().mockRejectedValue(new Error("EPERM")) });
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't read the Skins folder.");
    await openList();
    expect(optionLabels()).toEqual(["Hindsightbuilt in", "osu! defaultbuilt in"]);
  });

  it("ignores a second Rescan while one is running", async () => {
    let finish: () => void = () => undefined;
    const loadSkinList = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    await mountSettled({ loadSkinList });
    fireEvent.click(rescanButton());
    await waitFor(() => expect(rescanButton().disabled).toBe(true));
    fireEvent.click(rescanButton());
    fireEvent.click(rescanButton());
    expect(loadSkinList).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    await waitFor(() => expect(rescanButton().disabled).toBe(false));
    expect(loadSkinList).toHaveBeenCalledTimes(2);
  });

  it("lets the newest scan win when an older one finishes last", async () => {
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    const pending = [first, second];
    const view = mount({ readCfg: () => (pending.shift() ?? first).promise });
    await waitFor(() => expect(readOsuSkinInUse).toHaveBeenCalledTimes(1));
    // A new manager restarts the scan while the first one is still running.
    (useCommonManagers as jest.Mock).mockReturnValue({
      skinManager: { ...view.skinManager, loadSkinList: jest.fn().mockResolvedValue(undefined) },
      skinSettingsStore: view.skinSettingsStore,
    });
    view.rerender(view.tree());
    await waitFor(() => expect(readOsuSkinInUse).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve("Cookiezi 32"));
    await waitFor(() => expect(rescanButton().disabled).toBe(false));
    await act(async () => first.resolve("Lain"));
    await openList();
    expect(optionLabels()[0]).toBe("Cookiezi 32Used in osu!");
    expect(within(listbox()).getAllByText("Used in osu!")).toHaveLength(1);
  });

  it("wraps a long skin name in the load failure line and the folder line", async () => {
    const longName = "Rafis_2020_Edit_v2_final_noCursorTrail_".repeat(2) + "x";
    const loadSkin = jest.fn().mockRejectedValue(new Error("broken"));
    await mountSettled({ folderSkins: [longName], loadSkin });
    await openList();
    fireEvent.click(within(listbox()).getByRole("option", { name: new RegExp(longName) }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(longName);
    expect(cssOf(alert)).toContain("overflow-wrap:anywhere");
    expect(cssOf(alert)).toContain("min-width:0");
    // The closed button and the rows cut the name with an ellipsis; the footer path wraps.
    const label = triggerButton().querySelector("span") as HTMLElement;
    expect(cssOf(label)).toContain("text-overflow:ellipsis");
    expect(cssOf(screen.getByText("D:\\osu!\\Skins"))).toContain("overflow-wrap:anywhere");
  });

  it("wraps the Skins folder failure line", async () => {
    await mountSettled({ loadSkinList: jest.fn().mockRejectedValue(new Error("EPERM")) });
    expect(cssOf(await screen.findByRole("alert"))).toContain("overflow-wrap:anywhere");
  });

  it("keeps the full name in a title on truncated rows and on the button", async () => {
    await mountSettled({ preferredSkinId: "osu:Lain" });
    expect(triggerButton().querySelector("span")?.getAttribute("title")).toBe("Lain");
    await openList();
    for (const row of within(listbox()).getAllByRole("option")) {
      const name = row.querySelector("span[title]") as HTMLElement;
      expect(name.getAttribute("title")).toBe(name.textContent);
      expect(cssOf(name)).toContain("text-overflow:ellipsis");
    }
  });

  it("keeps a row the keyboard moves to clear of the bottom fade", async () => {
    const fadeHeight = 40;
    await mountSettled({ folderSkins: Array.from({ length: 40 }, (_, index) => `Skin ${index}`) });
    await openList();
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      fireEvent.keyDown(searchField(), { key: "ArrowDown" });
      // The list scrolls the active row with "nearest" and every row keeps a margin as tall as the fade below it.
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
      const rows = within(listbox()).getAllByRole("option");
      for (const row of [rows[0], rows[rows.length - 1]]) {
        expect(cssOf(row)).toContain(`scroll-margin-bottom:${fadeHeight}px`);
      }
      const fade = document.querySelector("[data-scroll-fade]") as HTMLElement;
      expect(cssOf(fade)).toContain(`height:${fadeHeight}px`);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("ignores Enter and Escape that belong to an IME composition", async () => {
    const { skinManager } = await mountSettled();
    await openList();
    fireEvent.keyDown(searchField(), { key: "Enter", isComposing: true });
    expect(skinManager.loadSkin).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox", { name: "Skins" })).toBeTruthy();
    fireEvent.keyDown(searchField(), { key: "Escape", isComposing: true });
    expect(screen.getByRole("listbox", { name: "Skins" })).toBeTruthy();
    expect(screen.getByTestId("mode").textContent).toBe("settings");
    // The same keys outside a composition still work.
    fireEvent.keyDown(searchField(), { key: "Enter" });
    expect(skinManager.loadSkin).toHaveBeenCalledTimes(1);
  });

  it("recognises the stored skin without regard to case", async () => {
    await mountSettled({ folderSkins: ["Cookiezi 32", "Lain"], preferredSkinId: "osu:cookiezi 32", skinInUse: undefined });
    expect(triggerButton().textContent).toContain("Cookiezi 32");
    await openList();
    const selected = within(listbox()).getAllByRole("option", { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Cookiezi 32");
  });

  it("points aria-controls and aria-activedescendant at nothing while no skin matches", async () => {
    await mountSettled();
    await openList();
    expect(searchField().getAttribute("aria-controls")).toBe(listbox().id);
    expect(searchField().getAttribute("aria-activedescendant")).toBeTruthy();
    fireEvent.change(searchField(), { target: { value: "zzz" } });
    expect(searchField().hasAttribute("aria-controls")).toBe(false);
    expect(searchField().hasAttribute("aria-activedescendant")).toBe(false);
    expect(triggerButton().hasAttribute("aria-controls")).toBe(false);
    fireEvent.change(searchField(), { target: { value: "" } });
    expect(searchField().getAttribute("aria-controls")).toBe(listbox().id);
    expect(triggerButton().getAttribute("aria-controls")).toBe(listbox().id);
  });

  it("re-renders only the rows whose active state changes when the active option moves", async () => {
    let reads = 0;
    const real = skinOptionsModule.buildSkinOptions;
    const spy = jest.spyOn(skinOptionsModule, "buildSkinOptions").mockImplementation((...args) =>
      real(...args).map((option) => {
        const copy = { ...option };
        Object.defineProperty(copy, "label", {
          get() {
            reads += 1;
            return option.label;
          },
        });
        return copy;
      }),
    );
    try {
      await mountSettled({ folderSkins: Array.from({ length: 500 }, (_, index) => `Skin ${index + 1}`) });
      await openList();
      const before = reads;
      for (let step = 0; step < 5; step++) fireEvent.keyDown(searchField(), { key: "ArrowDown" });
      // Two rows (the old and the new active one) per step, a few label reads each; a full re-render reads 500+ labels.
      expect(reads - before).toBeLessThan(5 * 2 * 4 + 10);
    } finally {
      spy.mockRestore();
    }
  });

  it("Escape closes the list without closing Settings", async () => {
    await mountSettled();
    await openList();
    fireEvent.keyDown(searchField(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("mode").textContent).toBe("settings");
    // With the list closed, Escape is Settings' again.
    fireEvent.keyDown(triggerButton(), { key: "Escape" });
    expect(screen.getByTestId("mode").textContent).toBe("incidents");
  });

  it("Escape from Rescan closes the open list first and keeps Settings open", async () => {
    await mountSettled();
    await openList();
    act(() => rescanButton().focus());
    expect(document.activeElement).toBe(rescanButton());
    fireEvent.keyDown(rescanButton(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("mode").textContent).toBe("settings");
    expect(document.activeElement).toBe(triggerButton());
    // A second Escape, with the list closed, is Settings' again.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.getByTestId("mode").textContent).toBe("incidents");
  });

  it("Escape from Rescan during an IME composition closes nothing", async () => {
    await mountSettled();
    await openList();
    act(() => rescanButton().focus());
    fireEvent.keyDown(rescanButton(), { key: "Escape", isComposing: true });
    expect(screen.getByRole("listbox", { name: "Skins" })).toBeTruthy();
    expect(screen.getByTestId("mode").textContent).toBe("settings");
  });

  it("draws no outline on the search input; the search row's hairline brightens while it has focus", async () => {
    await mountSettled();
    await openList();
    const input = searchField();
    expect(cssOf(input)).toContain("outline:none");
    expect(cssOfRule(input, ":focus-visible")).toContain("outline:none");
    expect(cssOfRule(input, ":focus-visible")).not.toContain("2px");
    const row = input.parentElement as HTMLElement;
    expect(cssOf(row)).toContain("box-shadow:inset0-1px0rgba(255,255,255,0.08)");
    expect(cssOfRule(row, ":focus-within")).toContain("box-shadow:inset0-1px0rgba(255,255,255,0.28)");
  });

  it("gives the skin list the app's thin scrollbar", async () => {
    await mountSettled();
    await openList();
    const css = cssOf(listbox());
    expect(css).toContain("scrollbar-width:thin");
    expect(css).toContain(`scrollbar-color:${thinScrollbar.scrollbarColor.replace(/\s+/g, "")}`);
    expect(cssOfRule(listbox(), "::-webkit-scrollbar")).toContain("width:6px");
    expect(cssOfRule(listbox(), "::-webkit-scrollbar-button")).toContain("display:none");
    expect(cssOfRule(listbox(), "::-webkit-scrollbar-thumb")).toContain("background-color:rgba(255,255,255,0.14)");
  });

  describe("with the app's real shortcuts mounted and a replay loaded", () => {
    const keyF = { key: "f", code: "KeyF", keyCode: 70, which: 70 };
    const keySpace = { key: " ", code: "Space", keyCode: 32, which: 32 };

    /** A key press as a browser sends it: keydown, the edit it causes (if the key types), keyup. */
    function press(target: Element, event: typeof keyF, typed?: string) {
      fireEvent.keyDown(target, event);
      if (typed !== undefined) fireEvent.change(target, { target: { value: typed } });
      fireEvent.keyUp(target, event);
    }

    async function mountWithShortcuts() {
      const view = await mountSettled({ shortcuts: true });
      await openList();
      return view;
    }

    it("typing f and a space in the search field only changes the query", async () => {
      const { toggleClock, setHidden } = await mountWithShortcuts();
      const field = searchField();
      expect(field.tagName).toBe("INPUT");
      act(() => field.focus());
      press(field, keyF, "f");
      press(field, keySpace, "f ");
      expect(searchField().value).toBe("f ");
      expect(setHidden).not.toHaveBeenCalled();
      expect(toggleClock).not.toHaveBeenCalled();
      expect(screen.getByTestId("mode").textContent).toBe("settings");
    });

    it("the same keys outside the field still drive playback", async () => {
      const { toggleClock, setHidden } = await mountWithShortcuts();
      press(document.body, keyF);
      press(document.body, keySpace);
      expect(setHidden).toHaveBeenCalledTimes(1);
      expect(setHidden).toHaveBeenCalledWith(true);
      expect(toggleClock).toHaveBeenCalledTimes(1);
    });
  });

  it("renders 500 skins without error and keeps the list height capped", async () => {
    const many = Array.from({ length: 500 }, (_, index) => `Skin ${index + 1}`);
    await mountSettled({ folderSkins: many });
    await openList();
    expect(within(listbox()).getAllByRole("option")).toHaveLength(502);
    expect(searchField().placeholder).toBe("Search 502 skins");
    const style = window.getComputedStyle(listbox());
    expect(style.maxHeight).toBe("278px");
    expect(style.overflowY).toBe("auto");
  });

  it("shows the bottom fade only while there is more to scroll", async () => {
    const heights = { scrollHeight: 800, clientHeight: 278 };
    const spies = (Object.keys(heights) as Array<keyof typeof heights>).map((key) =>
      jest.spyOn(HTMLElement.prototype, key, "get").mockReturnValue(heights[key]),
    );
    try {
      await mountSettled({ folderSkins: Array.from({ length: 40 }, (_, index) => `Skin ${index}`) });
      await openList();
      const fade = () => document.querySelector("[data-scroll-fade]") as HTMLElement;
      expect(window.getComputedStyle(fade()).opacity).toBe("1");
      listbox().scrollTop = 522;
      fireEvent.scroll(listbox());
      expect(window.getComputedStyle(fade()).opacity).toBe("0");
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
