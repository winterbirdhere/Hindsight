import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { frontendAPI } from "../../api";
import { InspectorProvider, useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { GeneralTab, resetGeneralTabStateForTests } from "./GeneralTab";

jest.mock("../../api", () => ({ frontendAPI: { selectDirectory: jest.fn(), reboot: jest.fn() } }));
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn(), useCommonManagers: jest.fn() }));

const FOLDER = "D:\\Games\\osu!";

function ModeProbe() {
  const { mode, settingsTab, openSettings, closeSettings, setSettingsTab } = useInspector();
  return (
    <>
      <output data-testid="mode">{mode}</output>
      <output data-testid="tab">{settingsTab}</output>
      <button data-testid="probe-open-general" onClick={() => openSettings({ tab: "general" })} />
      <button data-testid="probe-close" onClick={closeSettings} />
      <button data-testid="probe-playback" onClick={() => setSettingsTab("playback")} />
    </>
  );
}

/** Like the real panel: General is mounted only while Settings are open on the General tab. */
function PanelShell() {
  const { mode, settingsTab } = useInspector();
  return mode === "settings" && settingsTab === "general" ? <GeneralTab /> : null;
}

const probe = (id: string) => screen.getByTestId(id);
const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const resetButton = () => screen.getByRole("button", { name: "Reset and restart" });
const confirmButton = (name = "Yes, reset and restart") => screen.getByRole("button", { name });
const cancelButton = () => screen.getByRole("button", { name: "Cancel" });
const question = "Clear every preference, including the osu! folder?";

function mount() {
  return render(
    <InspectorProvider initialMode="settings">
      <ModeProbe />
      <GeneralTab />
    </InspectorProvider>,
  );
}

function mountShell() {
  const view = render(
    <InspectorProvider>
      <ModeProbe />
      <PanelShell />
    </InspectorProvider>,
  );
  fireEvent.click(probe("probe-open-general"));
  return view;
}

beforeEach(() => {
  resetGeneralTabStateForTests();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("replay-cursor-settings", '{"enabled":false}');
  localStorage.setItem("osu-settings", JSON.stringify({ osuStablePath: FOLDER }));
  (frontendAPI.reboot as jest.Mock).mockResolvedValue(undefined);
  (useCommonManagers as jest.Mock).mockReturnValue({ appInfoService: { version: "9.7.3-preview.test", platform: "win32" } });
  const settings$ = new BehaviorSubject({ osuStablePath: FOLDER });
  (useAnalysisApp as jest.Mock).mockReturnValue({
    osuFolderService: {
      settings$,
      get settings() {
        return settings$.getValue();
      },
      isValidOsuFolder: jest.fn().mockResolvedValue(true),
      setOsuFolder: jest.fn(),
    },
  });
});

describe("GeneralTab", () => {
  it("identifies the running version and original project without inventing release destinations", () => {
    const view = mount();
    const about = screen.getByRole("group", { name: "About" });
    expect(within(about).getByText("Hindsight 9.7.3-preview.test")).toBeTruthy();
    expect(within(about).getByText("Based on Rewind by abstrakt.")).toBeTruthy();
    expect(within(about).getByText("Source code: MIT. Bundled dependencies and assets use separate licences.")).toBeTruthy();
    expect(within(about).queryByRole("link")).toBeNull();
    expect(within(about).queryByRole("button")).toBeNull();
    expect(about.querySelector("[tabindex]")).toBeNull();
    (useCommonManagers as jest.Mock).mockReturnValue({ appInfoService: { version: "9.8.0-preview.next", platform: "win32" } });
    view.rerender(<InspectorProvider><GeneralTab /></InspectorProvider>);
    expect(screen.getByText("Hindsight 9.8.0-preview.next")).toBeTruthy();
    expect(screen.queryByText("Hindsight 9.7.3-preview.test")).toBeNull();
  });

  it.each([undefined, "  "])("keeps an unavailable version honest (%s)", (version) => {
    (useCommonManagers as jest.Mock).mockReturnValue({ appInfoService: { version, platform: "win32" } });
    mount();
    const about = screen.getByRole("group", { name: "About" });
    expect(within(about).getByText("Hindsight · Version unavailable")).toBeTruthy();
    expect(about.textContent).not.toContain("undefined");
    expect(within(about).getByText("Based on Rewind by abstrakt.")).toBeTruthy();
  });

  it("keeps About copy selectable and wrapping without taking focus from settings", () => {
    mount();
    act(() => resetButton().focus());
    const credit = screen.getByText("Based on Rewind by abstrakt.");
    const copy = credit.parentElement as HTMLElement;
    expect(getComputedStyle(copy).userSelect).toBe("text");
    expect(getComputedStyle(copy).overflowWrap).toBe("anywhere");
    expect(parseFloat(getComputedStyle(copy).fontSize)).toBeGreaterThanOrEqual(13);
    expect(document.activeElement).toBe(resetButton());
  });

  it("shows the folder and reset sections", () => {
    mount();
    expect(screen.getByRole("group", { name: "osu! folder" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Reset" })).toBeTruthy();
    expect(screen.getByText(FOLDER)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();
    expect(screen.getByText("Hindsight restarts to apply a new folder.")).toBeTruthy();
    expect(screen.getByText("Reset all settings")).toBeTruthy();
    expect(screen.getByText("Clears every preference and restarts Hindsight.")).toBeTruthy();
    expect(resetButton()).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Confirm reset" })).toBeNull();
  });

  it("asks before clearing anything", () => {
    mount();
    fireEvent.click(resetButton());
    expect(localStorage.getItem("replay-cursor-settings")).not.toBeNull();
    expect(localStorage.getItem("osu-settings")).not.toBeNull();
    expect(frontendAPI.reboot).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: "Confirm reset" });
    expect(group.textContent).toContain(question);
    expect(confirmButton()).toBeTruthy();
    expect(cancelButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset and restart" })).toBeNull();
    expect(document.activeElement).toBe(cancelButton());
  });

  it("a double-click on Reset and restart does not confirm", () => {
    mount();
    // The click sequence a browser sends for a double-click: the first click asks, the row swaps, and the second
    // click (detail 2) lands on whatever now occupies the confirm button.
    fireEvent.click(resetButton(), { detail: 1 });
    fireEvent.click(confirmButton(), { detail: 2 });
    expect(localStorage.getItem("replay-cursor-settings")).not.toBeNull();
    expect(localStorage.getItem("osu-settings")).not.toBeNull();
    expect(frontendAPI.reboot).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm reset" }).textContent).toContain(question);
    expect(confirmButton()).toBeTruthy();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });

  describe("a pointer that has not moved since it opened the question", () => {
    const at = (x: number, y: number, detail = 1) => ({ detail, clientX: x, clientY: y });
    const nothingCleared = () => {
      expect(localStorage.getItem("replay-cursor-settings")).not.toBeNull();
      expect(localStorage.getItem("osu-settings")).not.toBeNull();
      expect(frontendAPI.reboot).not.toHaveBeenCalled();
      expect(screen.getByRole("group", { name: "Confirm reset" }).textContent).toContain(question);
    };

    it("a second click at the same spot does not confirm, however slow", () => {
      mount();
      fireEvent.click(resetButton(), at(300, 200));
      fireEvent.click(confirmButton(), at(300, 200));
      nothingCleared();
      fireEvent.click(confirmButton(), at(302, 203));
      nothingCleared();
      fireEvent.click(confirmButton(), at(296, 197));
      nothingCleared();
    });

    it("a click after the pointer has moved confirms", async () => {
      mount();
      fireEvent.click(resetButton(), at(300, 200));
      fireEvent.click(confirmButton(), at(300, 230));
      await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
      expect(localStorage.getItem("replay-cursor-settings")).toBeNull();
      expect(localStorage.getItem("osu-settings")).toBeNull();
    });

    it("a click that is far in only one axis confirms", async () => {
      mount();
      fireEvent.click(resetButton(), at(300, 200));
      fireEvent.click(confirmButton(), at(305, 200));
      await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
    });

    it("a question opened from the keyboard confirms on the first pointer click", async () => {
      mount();
      fireEvent.click(resetButton(), at(300, 200, 0));
      fireEvent.click(confirmButton(), at(300, 200));
      await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
      expect(localStorage.getItem("osu-settings")).toBeNull();
    });

    it("Enter still confirms when the pointer has not moved", async () => {
      mount();
      fireEvent.click(resetButton(), at(300, 200));
      const confirm = confirmButton();
      confirm.focus();
      fireEvent.keyDown(confirm, { key: "Enter" });
      fireEvent.click(confirm, at(300, 200, 0));
      fireEvent.keyUp(confirm, { key: "Enter" });
      await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
      expect(localStorage.getItem("osu-settings")).toBeNull();
    });

    it("Cancel forgets the remembered point", async () => {
      mount();
      fireEvent.click(resetButton(), at(300, 200));
      fireEvent.click(cancelButton(), at(10, 10));
      fireEvent.click(resetButton(), at(300, 200, 0));
      fireEvent.click(confirmButton(), at(300, 200));
      await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
    });

    it("Retry restart keeps only the double-click guard", async () => {
      (frontendAPI.reboot as jest.Mock).mockRejectedValueOnce(new Error("relaunch failed"));
      mount();
      fireEvent.click(resetButton(), at(300, 200));
      fireEvent.click(confirmButton(), at(300, 230));
      const retry = await screen.findByRole("button", { name: "Retry restart" });
      fireEvent.click(retry, at(300, 200));
      await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(2));
    });
  });

  it("Cancel is the last button of the confirmation", () => {
    mount();
    fireEvent.click(resetButton());
    const buttons = within(screen.getByRole("group", { name: "Confirm reset" })).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Yes, reset and restart", "Cancel"]);
    // The group keeps to the right edge, so the last button takes the place the reset button had, also when wrapped.
    expect(getComputedStyle(buttons[1].parentElement as HTMLElement).justifyContent).toBe("flex-end");
    expect(getComputedStyle(buttons[1].parentElement as HTMLElement).flexWrap).toBe("wrap");
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("Enter on Yes, reset and restart still confirms", async () => {
    mount();
    fireEvent.click(resetButton());
    const confirm = confirmButton();
    confirm.focus();
    // A browser activates a focused button on Enter with a click whose detail is 0.
    fireEvent.keyDown(confirm, { key: "Enter" });
    fireEvent.click(confirm, { detail: 0 });
    fireEvent.keyUp(confirm, { key: "Enter" });
    await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("replay-cursor-settings")).toBeNull();
    expect(localStorage.getItem("osu-settings")).toBeNull();
  });

  it("a double-click on Retry restart does not restart again", async () => {
    (frontendAPI.reboot as jest.Mock).mockRejectedValueOnce(new Error("relaunch failed"));
    mount();
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    const retry = await screen.findByRole("button", { name: "Retry restart" });
    fireEvent.click(retry, { detail: 2 });
    expect(frontendAPI.reboot).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retry restart" })).toBeTruthy();
    fireEvent.click(retry, { detail: 1 });
    await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(2));
  });

  it("Cancel keeps every setting and restores the row", () => {
    mount();
    fireEvent.click(resetButton());
    fireEvent.click(cancelButton());
    expect(screen.queryByRole("group", { name: "Confirm reset" })).toBeNull();
    expect(document.activeElement).toBe(resetButton());
    expect(localStorage.getItem("replay-cursor-settings")).not.toBeNull();
    expect(localStorage.getItem("osu-settings")).not.toBeNull();
    expect(frontendAPI.reboot).not.toHaveBeenCalled();
  });

  it("Escape cancels the confirmation without closing Settings", () => {
    mount();
    fireEvent.click(resetButton());
    fireEvent.keyDown(cancelButton(), { key: "Escape" });
    expect(screen.getByTestId("mode").textContent).toBe("settings");
    expect(screen.queryByRole("group", { name: "Confirm reset" })).toBeNull();
    expect(document.activeElement).toBe(resetButton());
    expect(localStorage.getItem("replay-cursor-settings")).not.toBeNull();
    expect(localStorage.getItem("osu-settings")).not.toBeNull();
    expect(frontendAPI.reboot).not.toHaveBeenCalled();
    // With nothing pending, Escape still closes Settings.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("mode").textContent).toBe("incidents");
  });

  it("clears every saved setting and restarts once confirmed", async () => {
    const order: string[] = [];
    jest.spyOn(Storage.prototype, "clear").mockImplementation(function (this: Storage) {
      order.push("clear");
      for (const key of Object.keys(this)) this.removeItem(key);
    });
    (frontendAPI.reboot as jest.Mock).mockImplementation(async () => {
      order.push("reboot");
    });
    mount();
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("replay-cursor-settings")).toBeNull();
    expect(localStorage.getItem("osu-settings")).toBeNull();
    expect(order).toEqual(["clear", "reboot"]);
  });

  it("says so when the restart fails and retries only the restart", async () => {
    (frontendAPI.reboot as jest.Mock).mockRejectedValueOnce(new Error("relaunch failed"));
    mount();
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Settings were cleared. Hindsight could not restart; close and reopen it.");
    expect(localStorage.getItem("osu-settings")).toBeNull();
    const retry = confirmButton("Retry restart") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(retry);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    localStorage.setItem("written-after-clear", "x");
    const clear = jest.spyOn(Storage.prototype, "clear");
    fireEvent.click(retry);
    await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(2));
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem("written-after-clear")).toBe("x");
  });

  it("ignores a second confirm click while restarting", async () => {
    let finish: () => void = () => undefined;
    (frontendAPI.reboot as jest.Mock).mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount();
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    const restarting = confirmButton("Restarting Hindsight…") as HTMLButtonElement;
    expect(restarting.disabled).toBe(true);
    expect((cancelButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(restarting);
    fireEvent.click(restarting);
    expect(frontendAPI.reboot).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("ignores a confirm click that arrives before the button is disabled", async () => {
    const pending = deferred();
    (frontendAPI.reboot as jest.Mock).mockReturnValue(pending.promise);
    const clear = jest.spyOn(Storage.prototype, "clear");
    mount();
    fireEvent.click(resetButton());
    const confirm = confirmButton();
    // Both clicks land in one batch, before React has re-rendered the button as disabled.
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(frontendAPI.reboot).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
  });

  it("asks again, focused on Cancel, when the saved settings cannot be cleared", () => {
    jest.spyOn(Storage.prototype, "clear").mockImplementation(() => {
      throw new Error("storage locked");
    });
    mount();
    fireEvent.click(resetButton());
    // Keyboard activation: the destructive button has focus, and focus must leave it for the safe one.
    confirmButton().focus();
    expect(document.activeElement).toBe(confirmButton());
    fireEvent.click(confirmButton());
    expect(frontendAPI.reboot).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Could not clear the saved settings. Try again.");
    expect(screen.getByRole("group", { name: "Confirm reset" }).textContent).toContain(question);
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(cancelButton());
    expect(localStorage.getItem("osu-settings")).not.toBeNull();
  });

  it("keeps the restart failure visible after the tab is left and reopened", async () => {
    const pending = deferred();
    (frontendAPI.reboot as jest.Mock).mockReturnValue(pending.promise);
    const first = mount();
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    // Left while the restart is pending: the reopened tab still shows it, and shows the failure when it comes.
    first.unmount();
    const second = mount();
    expect((confirmButton("Restarting Hindsight…") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Reset and restart" })).toBeNull();
    await act(async () => pending.reject(new Error("relaunch failed")));
    expect(screen.getByRole("alert").textContent).toBe(
      "Settings were cleared. Hindsight could not restart; close and reopen it.",
    );
    expect(confirmButton("Retry restart")).toBeTruthy();
    // Left again after the failure: still there when reopened, not a clean row.
    second.unmount();
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Settings were cleared.");
    expect(confirmButton("Retry restart")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset and restart" })).toBeNull();
  });

  it("brings Settings back to General when the restart fails after the user left", async () => {
    const pending = deferred();
    (frontendAPI.reboot as jest.Mock).mockReturnValue(pending.promise);
    mountShell();
    expect(probe("tab").textContent).toBe("general");
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    fireEvent.click(probe("probe-playback"));
    fireEvent.click(probe("probe-close"));
    expect(probe("mode").textContent).toBe("incidents");
    expect(probe("tab").textContent).toBe("playback");
    expect(screen.queryByRole("group", { name: "Confirm reset" })).toBeNull();
    await act(async () => pending.reject(new Error("relaunch failed")));
    expect(probe("mode").textContent).toBe("settings");
    expect(probe("tab").textContent).toBe("general");
    expect(screen.getByRole("alert").textContent).toContain("Settings were cleared.");
    expect(confirmButton("Retry restart")).toBeTruthy();
  });

  it("Escape does not close Settings while restarting or after a failed restart", async () => {
    const pending = deferred();
    (frontendAPI.reboot as jest.Mock).mockReturnValue(pending.promise);
    mount();
    fireEvent.click(resetButton());
    fireEvent.click(confirmButton());
    fireEvent.keyDown(screen.getByRole("group", { name: "Confirm reset" }), { key: "Escape" });
    expect(probe("mode").textContent).toBe("settings");
    expect(confirmButton("Restarting Hindsight…")).toBeTruthy();
    await act(async () => pending.reject(new Error("relaunch failed")));
    fireEvent.keyDown(confirmButton("Retry restart"), { key: "Escape" });
    expect(probe("mode").textContent).toBe("settings");
    expect(screen.getByRole("alert").textContent).toContain("Settings were cleared.");
    expect(confirmButton("Retry restart")).toBeTruthy();
  });

  it("describes the group by the question and wraps its buttons instead of overflowing", () => {
    mount();
    expect(getComputedStyle(resetButton()).marginLeft).toBe("auto");
    expect(getComputedStyle(resetButton().parentElement as HTMLElement).flexWrap).toBe("wrap");
    fireEvent.click(resetButton());
    const group = screen.getByRole("group", { name: "Confirm reset" });
    const describedBy = group.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)?.textContent).toBe(question);
    expect(getComputedStyle(group).flexWrap).toBe("wrap");
    const buttons = getComputedStyle(confirmButton().parentElement as HTMLElement);
    expect(buttons.flexWrap).toBe("wrap");
    expect(buttons.justifyContent).toBe("flex-end");
    expect(buttons.minWidth).toBe("0");
    expect(buttons.maxWidth).toBe("100%");
    expect(buttons.marginLeft).toBe("auto");
    for (const button of [cancelButton(), confirmButton()]) {
      expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(button).maxWidth).toBe("100%");
    }
  });

  it("forgets a pending confirmation when the tab is left and reopened", () => {
    const first = mount();
    fireEvent.click(resetButton());
    expect(screen.getByRole("group", { name: "Confirm reset" })).toBeTruthy();
    first.unmount();
    mount();
    expect(screen.queryByRole("group", { name: "Confirm reset" })).toBeNull();
    expect(resetButton()).toBeTruthy();
    expect(localStorage.getItem("osu-settings")).not.toBeNull();
  });
});
