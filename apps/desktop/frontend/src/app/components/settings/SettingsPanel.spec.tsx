import { act, fireEvent, render, screen } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { InspectorProvider, InspectorState, useInspector } from "../../providers/InspectorProvider";
import { useCommonManagers } from "../../providers/TheaterProvider";
import { DEFAULT_ANALYSIS_CURSOR_SETTINGS } from "../../services/analysis/analysis-cursor";
import { DEFAULT_BEATMAP_BACKGROUND_SETTINGS } from "../../services/common/beatmap-background";
import { DEFAULT_PLAY_BAR_SETTINGS } from "../../services/common/playbar";
import { DEFAULT_REPLAY_CURSOR_SETTINGS } from "../../services/common/replay-cursor";
import { SettingsPanel } from "./SettingsPanel";

jest.mock("../../providers/TheaterProvider", () => ({ useCommonManagers: jest.fn() }));
// The other tabs are built and tested on their own; here they are stand-ins, so this spec only checks the frame.
jest.mock("./DisplayTab", () => ({ DisplayTab: () => <div data-testid="display-tab" /> }));
jest.mock("./SkinTab", () => ({ SkinTab: () => <div data-testid="skin-tab" /> }));
jest.mock("./GeneralTab", () => ({ GeneralTab: () => <div data-testid="general-tab" /> }));

let inspector: InspectorState;
function Capture() {
  inspector = useInspector();
  return null;
}

function store<T extends object>(initial: T) {
  const settings$ = new BehaviorSubject(initial);
  return {
    settings$,
    get settings() {
      return settings$.getValue();
    },
    changeSettings: jest.fn(),
    setEnabled: jest.fn(),
    setDim: jest.fn(),
  };
}

function mount(initialMode: "incidents" | "settings" = "settings", locked = false) {
  (useCommonManagers as jest.Mock).mockReturnValue({
    replayCursorSettingsStore: store({ ...DEFAULT_REPLAY_CURSOR_SETTINGS }),
    analysisCursorSettingsStore: store({ ...DEFAULT_ANALYSIS_CURSOR_SETTINGS }),
    beatmapBackgroundSettingsStore: store({ ...DEFAULT_BEATMAP_BACKGROUND_SETTINGS }),
    playbarSettingsStore: store({ ...DEFAULT_PLAY_BAR_SETTINGS }),
  });
  return render(
    <InspectorProvider initialMode={initialMode} locked={locked}>
      <Capture />
      <SettingsPanel />
    </InspectorProvider>,
  );
}

const TABS = ["Playback", "Display", "Skin", "General"];

/** Every CSS rule emotion has put in the document (it inserts rules through the CSSOM, not as text). */
function allCss() {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .map((rule) => rule.cssText)
    .join("\n");
}

describe("SettingsPanel", () => {
  it("names the panel and offers four tabs", () => {
    mount();
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Changes apply live")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close settings" })).toBeTruthy();
    const tablist = screen.getByRole("tablist", { name: "Settings categories" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(TABS);
    expect(tablist.contains(tabs[0])).toBe(true);
    expect(getComputedStyle(tabs[0]).height).toBe("38px");
    // Every tab controls the one panel; only the selected tab is in the Tab order.
    const panel = screen.getByRole("tabpanel");
    for (const tab of tabs) {
      expect(tab.getAttribute("id")).toBeTruthy();
      expect(tab.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    }
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].getAttribute("id"));
    expect(getComputedStyle(panel).overflow).toBe("auto");
  });

  it("selects the provider's tab and switches on click", () => {
    mount();
    expect(screen.getByRole("tab", { name: "Playback" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("switch", { name: "Show cursor" })).toBeTruthy();

    act(() => inspector.openSettings({ tab: "skin" }));
    expect(screen.getByRole("tab", { name: "Skin" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Playback" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("skin-tab")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(inspector.settingsTab).toBe("general");
    expect(screen.getByTestId("general-tab")).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      screen.getByRole("tab", { name: "General" }).getAttribute("id"),
    );
  });

  it("moves between tabs with the arrow keys", () => {
    mount();
    const playback = screen.getByRole("tab", { name: "Playback" });
    act(() => playback.focus());
    fireEvent.keyDown(playback, { key: "ArrowRight" });
    expect(inspector.settingsTab).toBe("display");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Display" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(inspector.settingsTab).toBe("playback");
    // Both ends wrap.
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(inspector.settingsTab).toBe("general");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(inspector.settingsTab).toBe("playback");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(inspector.settingsTab).toBe("general");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(inspector.settingsTab).toBe("playback");
  });

  it("does not keep focus on a tab pressed with the pointer", () => {
    mount();
    expect(fireEvent.mouseDown(screen.getByRole("tab", { name: "Display" }), { button: 0 })).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Close settings" }), { button: 0 })).toBe(false);
  });

  it("the close button returns to incidents", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(inspector.mode).toBe("incidents");
  });

  it("disables the close button while locked, and keeps its name and title", () => {
    mount("settings", true);
    const close = screen.getByRole("button", { name: "Close settings" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.getAttribute("title")).toBe("Close (Esc)");
    fireEvent.click(close);
    expect(inspector.mode).toBe("settings");
  });

  it("enables the close button when not locked", () => {
    mount();
    expect((screen.getByRole("button", { name: "Close settings" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps all four tabs on one row at any width: no wrapping, no shrinking, tighter below 300 px", () => {
    mount();
    const tablist = screen.getByRole("tablist");
    expect(getComputedStyle(tablist).flexWrap).not.toBe("wrap");
    for (const tab of screen.getAllByRole("tab")) {
      expect(getComputedStyle(tab).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(tab).flexShrink).toBe("0");
    }
    // At 340 px the mock's 18 px gap and 20 px padding apply.
    expect(getComputedStyle(tablist).gap).toBe("18px");
    expect(getComputedStyle(tablist).paddingLeft).toBe("20px");
    // jsdom cannot evaluate container queries: assert the rule the browser will apply.
    expect(allCss()).toMatch(/container-type:\s*inline-size/);
    expect(allCss()).toMatch(/@container \(max-width:\s*299px\)\s*\{[^}]*gap:\s*8px[^}]*padding:\s*0 12px/);
  });

  it("hides the subtitle in the narrow mode and keeps it on one line otherwise", () => {
    mount();
    const subtitle = screen.getByText("Changes apply live");
    expect(getComputedStyle(subtitle).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(subtitle).display).not.toBe("none");
    // jsdom cannot evaluate container queries: assert the rule the browser will apply.
    const className = Array.from(subtitle.classList).find((name) => name.startsWith("css-")) ?? "";
    expect(className).not.toBe("");
    expect(allCss().replace(/\s+/g, "")).toContain(`@container(max-width:299px){.${className}{display:none;}`);
    // The title and the close button are not touched by it.
    expect(getComputedStyle(screen.getByRole("heading", { name: "Settings" })).whiteSpace).toBe("nowrap");
    expect(screen.getByRole("button", { name: "Close settings" })).toBeTruthy();
  });

  it("scrolls the content vertically with the app's thin scrollbar", () => {
    mount();
    const panel = screen.getByRole("tabpanel");
    expect(["0", "0px"]).toContain(getComputedStyle(panel).minHeight);
    expect(allCss()).toMatch(/scrollbar-width:\s*thin/);
  });
});
