import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ClipRange } from "../services/manager/clip-range";
import { InspectorMode, InspectorProvider, InspectorState, useInspector } from "./InspectorProvider";

let api: InspectorState;

function Probe() {
  api = useInspector();
  return (
    <>
      <output data-testid="state">{`${api.mode}|${api.settingsTab}|${api.displayTarget}|${api.locked}`}</output>
      <output data-testid="export">{`${api.exportSession}|${JSON.stringify(api.exportRange)}`}</output>
    </>
  );
}

const state = () => screen.getByTestId("state").textContent;

function mount(props: { locked?: boolean; initialMode?: InspectorMode; children?: ReactNode } = {}) {
  return render(
    <InspectorProvider locked={props.locked} initialMode={props.initialMode}>
      <Probe />
    </InspectorProvider>,
  );
}

/** The `keydown` registrations (add or remove) a spy on `window` recorded. */
function keydownCalls(spy: jest.SpyInstance) {
  return spy.mock.calls.filter((call) => call[0] === "keydown");
}

function pressEscape(options: { prevent?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  if (options.prevent) event.preventDefault();
  act(() => {
    window.dispatchEvent(event);
  });
}

describe("InspectorProvider", () => {
  // A failing assertion must not leave a spy on `window` behind for the next test.
  afterEach(() => jest.restoreAllMocks());

  it("opens on the requested tab and target", () => {
    mount();
    expect(state()).toBe("incidents|playback|viewer|false");
    act(() => api.openSettings({ tab: "display", target: "clip" }));
    expect(state()).toBe("settings|display|clip|false");
  });

  it("opens on the remembered tab and target when no options are given", () => {
    mount();
    act(() => api.openSettings({ tab: "skin" }));
    act(() => api.closeSettings());
    act(() => api.openSettings());
    expect(state()).toBe("settings|skin|viewer|false");
  });

  it("toggles between incidents and settings", () => {
    mount();
    act(() => api.toggleSettings());
    expect(api.mode).toBe("settings");
    act(() => api.toggleSettings());
    expect(api.mode).toBe("incidents");
  });

  it("remembers the tab and target after closing", () => {
    mount();
    act(() => api.openSettings({ tab: "display", target: "clip" }));
    act(() => api.closeSettings());
    expect(state()).toBe("incidents|display|clip|false");
    act(() => api.toggleSettings());
    expect(state()).toBe("settings|display|clip|false");
  });

  it("changes the tab and the target while settings are open", () => {
    mount({ initialMode: "settings" });
    act(() => api.setSettingsTab("general"));
    act(() => api.setDisplayTarget("clip"));
    expect(state()).toBe("settings|general|clip|false");
  });

  it("ignores every mode change while locked", () => {
    mount({ locked: true });
    act(() => api.openSettings({ tab: "display", target: "clip" }));
    act(() => api.toggleSettings());
    expect(state()).toBe("incidents|playback|viewer|true");
    act(() => api.closeSettings());
    expect(api.mode).toBe("incidents");
  });

  it("does not close settings while locked", () => {
    mount({ locked: true, initialMode: "settings" });
    act(() => api.closeSettings());
    act(() => api.toggleSettings());
    expect(api.mode).toBe("settings");
  });

  it("closes on Escape", () => {
    mount({ initialMode: "settings" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.mode).toBe("incidents");
  });

  it("ignores Escape while locked, in incidents mode, or when the event was already handled", () => {
    // Locked: settings stay open.
    const locked = mount({ locked: true, initialMode: "settings" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.mode).toBe("settings");
    locked.unmount();

    // Incidents mode: no Escape listener is attached at all, so nothing can react to the key.
    const add = jest.spyOn(window, "addEventListener");
    const incidents = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.mode).toBe("incidents");
    expect(keydownCalls(add)).toHaveLength(0);
    incidents.unmount();
    add.mockRestore();

    // Already handled (a control used Esc itself) or not Escape: settings stay open.
    mount({ initialMode: "settings" });
    pressEscape({ prevent: true });
    expect(api.mode).toBe("settings");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(api.mode).toBe("settings");
  });

  it("attaches no Escape listener while locked", () => {
    const add = jest.spyOn(window, "addEventListener");
    mount({ locked: true, initialMode: "settings" });
    expect(keydownCalls(add)).toHaveLength(0);
    add.mockRestore();
  });

  it("stops Escape closing the panel when it becomes locked, and resumes when unlocked", () => {
    const view = render(
      <InspectorProvider initialMode="settings">
        <Probe />
      </InspectorProvider>,
    );
    const rerenderLocked = (locked: boolean) =>
      view.rerender(
        <InspectorProvider locked={locked}>
          <Probe />
        </InspectorProvider>,
      );
    rerenderLocked(true);
    expect(api.locked).toBe(true);
    expect(api.mode).toBe("settings");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.mode).toBe("settings");
    rerenderLocked(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.mode).toBe("incidents");
  });

  it("removes its window listener, the very same function, when it unmounts", () => {
    const add = jest.spyOn(window, "addEventListener");
    const remove = jest.spyOn(window, "removeEventListener");
    const view = mount({ initialMode: "settings" });
    const added = keydownCalls(add);
    expect(added).toHaveLength(1);
    expect(keydownCalls(remove)).toHaveLength(0);
    view.unmount();
    const removed = keydownCalls(remove);
    expect(removed).toHaveLength(1);
    expect(removed[0][1]).toBe(added[0][1]);
    add.mockRestore();
    remove.mockRestore();
  });

  describe("Export mode", () => {
    const range: ClipRange = { startMs: 1_000, endMs: 4_000 };
    const exportState = () => screen.getByTestId("export").textContent;
    const openSettingsFromExport = () => {
      act(() => api.openExport());
      act(() => api.openSettings({ tab: "display", target: "clip" }));
    };

    it("opens and closes Export, and toggles it", () => {
      mount();
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
      act(() => api.openExport());
      expect(api.mode).toBe("export");
      expect(api.exportSession).toBe(true);
      act(() => api.closeExport());
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
      act(() => api.toggleExport());
      expect(api.mode).toBe("export");
      expect(api.exportSession).toBe(true);
      act(() => api.toggleExport());
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
    });

    it("closes Export on Escape, but not while locked or when the event was handled", () => {
      // Handled by a control (default prevented): Export stays.
      const handled = mount({ initialMode: "export" });
      pressEscape({ prevent: true });
      expect(api.mode).toBe("export");
      // Not Escape: Export stays.
      fireEvent.keyDown(window, { key: "Enter" });
      expect(api.mode).toBe("export");
      // Plain Escape: back to incidents.
      fireEvent.keyDown(window, { key: "Escape" });
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
      handled.unmount();

      // Locked: no listener at all, Export stays.
      const add = jest.spyOn(window, "addEventListener");
      mount({ locked: true, initialMode: "export" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(api.mode).toBe("export");
      expect(keydownCalls(add)).toHaveLength(0);
    });

    it("returns to Export when Settings opened from it closes, by closeSettings, toggleSettings and Escape", () => {
      const closers: Array<() => void> = [
        () => act(() => api.closeSettings()),
        () => act(() => api.toggleSettings()),
        () => fireEvent.keyDown(window, { key: "Escape" }),
      ];
      for (const close of closers) {
        const view = mount();
        openSettingsFromExport();
        expect(api.mode).toBe("settings");
        close();
        expect(api.mode).toBe("export");
        expect(api.exportSession).toBe(true);
        view.unmount();
      }
    });

    it.each([
      ["closeSettings", () => act(() => api.closeSettings())],
      ["toggleSettings", () => act(() => api.toggleSettings())],
      ["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
    ] as const)("restores the Display target on the way back (%s)", (_name, leave) => {
      mount();
      expect(api.displayTarget).toBe("viewer");
      act(() => api.openExport());
      // The clip appearance link opens Display on the clip target.
      act(() => api.openSettings({ tab: "display", target: "clip" }));
      expect(api.displayTarget).toBe("clip");
      leave();
      expect(api.mode).toBe("export");
      expect(api.displayTarget).toBe("viewer");
      // The tab is not part of the way back: it stays where the link left it.
      expect(api.settingsTab).toBe("display");
    });

    it.each([
      ["closeExport", () => act(() => api.closeExport())],
      ["closeMode", () => act(() => api.closeMode())],
      ["toggleExport", () => act(() => api.toggleExport())],
    ] as const)("ending the session from Settings puts the Display target back (%s)", (_name, end) => {
      mount();
      act(() => api.openExport());
      act(() => api.openSettings({ tab: "display", target: "clip" }));
      expect(api.displayTarget).toBe("clip");
      end();
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
      expect(api.displayTarget).toBe("viewer");
      // The gear now opens Display on the viewer, not on the clip.
      act(() => api.openSettings({ tab: "display" }));
      expect(state()).toBe("settings|display|viewer|false");
    });

    it("keeps the export session while Settings is open from Export", () => {
      mount();
      openSettingsFromExport();
      expect(api.mode).toBe("settings");
      expect(api.exportSession).toBe(true);
    });

    it("needs two Escapes to leave Settings opened from Export", () => {
      mount();
      openSettingsFromExport();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(api.mode).toBe("export");
      expect(api.exportSession).toBe(true);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
    });

    it("ends the session when the Export toggle is used in Settings opened from Export", () => {
      mount();
      openSettingsFromExport();
      act(() => api.toggleExport());
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
      // The way back is forgotten: Settings opened now closes to incidents.
      act(() => api.openSettings());
      act(() => api.closeSettings());
      expect(api.mode).toBe("incidents");
    });

    it("does not return to Export from Settings that was opened from incidents", () => {
      const closers: Array<() => void> = [
        () => act(() => api.closeSettings()),
        () => act(() => api.toggleSettings()),
        () => fireEvent.keyDown(window, { key: "Escape" }),
      ];
      const openThenClose = (close: () => void) => {
        const view = mount();
        act(() => api.openSettings({ tab: "display", target: "clip" }));
        expect(api.exportSession).toBe(false);
        close();
        expect(api.mode).toBe("incidents");
        expect(api.exportSession).toBe(false);
        view.unmount();
      };
      closers.forEach(openThenClose);
      // Opening Export from such Settings goes to Export and changes nothing else.
      mount();
      act(() => api.openSettings({ tab: "display", target: "clip" }));
      act(() => api.openExport());
      expect(api.mode).toBe("export");
      expect(api.exportSession).toBe(true);
      expect(api.displayTarget).toBe("clip");
      act(() => api.closeExport());
      expect(api.mode).toBe("incidents");
    });

    it("keeps the range across closing and reopening Export and across Settings", () => {
      mount();
      expect(exportState()).toBe("false|null");
      act(() => api.openExport());
      act(() => api.setExportRange(range));
      expect(exportState()).toBe(`true|${JSON.stringify(range)}`);
      act(() => api.openSettings({ tab: "display", target: "clip" }));
      expect(api.exportRange).toEqual(range);
      act(() => api.closeSettings());
      expect(api.exportRange).toEqual(range);
      act(() => api.closeExport());
      expect(exportState()).toBe(`false|${JSON.stringify(range)}`);
      act(() => api.openExport());
      expect(api.exportRange).toEqual(range);
      // null is a value too: it means the whole replay.
      act(() => api.setExportRange(null));
      expect(api.exportRange).toBeNull();
    });

    it("ignores openExport, closeExport, toggleExport, closeMode and setExportRange while locked", () => {
      // Locked in incidents: nothing opens and the range does not change.
      const incidents = mount({ locked: true });
      act(() => api.openExport());
      act(() => api.toggleExport());
      act(() => api.setExportRange(range));
      expect(state()).toBe("incidents|playback|viewer|true");
      expect(exportState()).toBe("false|null");
      incidents.unmount();

      // Locked in Export: nothing closes it and the range does not change.
      const inExport = mount({ locked: true, initialMode: "export" });
      act(() => api.closeExport());
      act(() => api.toggleExport());
      act(() => api.closeMode());
      act(() => api.setExportRange(range));
      act(() => api.openSettings({ tab: "display", target: "clip" }));
      expect(api.mode).toBe("export");
      expect(exportState()).toBe("true|null");
      inExport.unmount();

      // Locked in Settings: nothing closes it either.
      mount({ locked: true, initialMode: "settings" });
      act(() => api.closeMode());
      act(() => api.openExport());
      expect(api.mode).toBe("settings");
    });

    it("closeMode leaves Settings opened from Export for incidents in one step", () => {
      mount();
      openSettingsFromExport();
      act(() => api.closeMode());
      expect(api.mode).toBe("incidents");
      expect(api.exportSession).toBe(false);
      // From Export, and from plain Settings, it also goes to incidents.
      act(() => api.openExport());
      act(() => api.closeMode());
      expect(api.mode).toBe("incidents");
      act(() => api.openSettings());
      act(() => api.closeMode());
      expect(api.mode).toBe("incidents");
      // The way back was forgotten: Settings opened now closes to incidents.
      act(() => api.openSettings());
      act(() => api.closeSettings());
      expect(api.mode).toBe("incidents");
    });
  });

  it("throws a clear error outside the provider", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow("useInspector must be used inside an InspectorProvider");
    error.mockRestore();
  });
});
