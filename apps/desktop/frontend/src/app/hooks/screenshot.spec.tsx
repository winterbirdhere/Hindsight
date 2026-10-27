import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScreenshotProvider, useScreenshot, type ScreenshotMenu } from "./screenshot";

const f12 = { key: "F12", code: "F12" };

function setup({ busy = false }: { busy?: boolean } = {}) {
  const state = { busy };
  const take = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  return { state, take, isBusy: () => state.busy };
}

/** A screen that has no dock: the provider is all there is of the screenshot. */
function mount(parts: ReturnType<typeof setup>, children?: React.ReactNode) {
  return render(
    <ScreenshotProvider takeScreenshot={parts.take} isBusy={parts.isBusy}>
      {children ?? <div>Home screen</div>}
    </ScreenshotProvider>,
  );
}

describe("F12", () => {
  it("takes a screenshot on a screen with no dock, and keeps the key from reaching the app", () => {
    const parts = setup();
    mount(parts);
    expect(fireEvent.keyDown(window, f12)).toBe(false);
    expect(parts.take).toHaveBeenCalledTimes(1);
  });

  it.each(["dialog", "presentation"])("takes one with a %s open, such as the full-map page or a comparison", (role) => {
    const parts = setup();
    mount(
      parts,
      <div role={role} aria-label="Full-map analysis">
        <button>inside</button>
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "inside" }), f12);
    expect(parts.take).toHaveBeenCalledTimes(1);
  });

  it("takes none while the Keyboard shortcuts dialog is open, and does not open the developer tools either", () => {
    const parts = setup();
    mount(parts, <div role="dialog" data-screenshot-blocked="" />);
    expect(fireEvent.keyDown(window, f12)).toBe(false);
    expect(parts.take).not.toHaveBeenCalled();
  });

  it("takes none while a clip is exporting", () => {
    const parts = setup({ busy: true });
    mount(parts);
    fireEvent.keyDown(window, f12);
    expect(parts.take).not.toHaveBeenCalled();
  });

  it("ignores a repeat, and Ctrl, Shift, Alt or Meta with F12", () => {
    const parts = setup();
    mount(parts);
    fireEvent.keyDown(window, { ...f12, repeat: true });
    for (const modifier of ["ctrlKey", "shiftKey", "altKey", "metaKey"]) fireEvent.keyDown(window, { ...f12, [modifier]: true });
    expect(parts.take).not.toHaveBeenCalled();
    // The modified keys are not taken over either.
    expect(fireEvent.keyDown(window, { ...f12, ctrlKey: true })).toBe(true);
  });

  it("takes one at a time", async () => {
    const parts = setup();
    let finish!: () => void;
    parts.take.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount(parts);
    fireEvent.keyDown(window, f12);
    fireEvent.keyDown(window, f12);
    expect(parts.take).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    fireEvent.keyDown(window, f12);
    expect(parts.take).toHaveBeenCalledTimes(2);
  });

  it("says when it could not, on any screen, and clears the message on the next try", async () => {
    const parts = setup();
    parts.take.mockRejectedValueOnce(new Error("capture failed"));
    mount(parts);
    await act(async () => void fireEvent.keyDown(window, f12));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not take a screenshot. Please try again.");
    await act(async () => void fireEvent.keyDown(window, f12));
    await waitFor(() => expect(parts.take).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("stops listening when it unmounts", () => {
    const parts = setup();
    mount(parts).unmount();
    fireEvent.keyDown(window, f12);
    expect(parts.take).not.toHaveBeenCalled();
  });
});

describe("with the three-dots menu open", () => {
  function Menu({ menu }: { menu: ScreenshotMenu }) {
    const screenshot = useScreenshot();
    return (
      <>
        <button onClick={() => screenshot.registerMenu(menu)}>register</button>
        <button onClick={screenshot.menuEntered}>entered</button>
        <button onClick={screenshot.menuExited}>exited</button>
        <output>{screenshot.capturing ? "capturing" : "idle"}</output>
      </>
    );
  }

  it("closes the menu first and captures once its exit transition is over", async () => {
    const parts = setup();
    const menu = { isOpen: jest.fn(() => true), close: jest.fn() };
    mount(parts, <Menu menu={menu} />);
    fireEvent.click(screen.getByText("register"));
    fireEvent.click(screen.getByText("entered"));
    fireEvent.keyDown(window, f12);
    expect(menu.close).toHaveBeenCalledTimes(1);
    expect(parts.take).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("capturing");
    // A second press while it waits changes nothing.
    fireEvent.keyDown(window, f12);
    expect(menu.close).toHaveBeenCalledTimes(1);
    await act(async () => void fireEvent.click(screen.getByText("exited")));
    expect(parts.take).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("idle");
  });

  it("captures at once when no menu is open", () => {
    const parts = setup();
    mount(parts, <Menu menu={{ isOpen: () => false, close: jest.fn() }} />);
    fireEvent.click(screen.getByText("register"));
    fireEvent.keyDown(window, f12);
    expect(parts.take).toHaveBeenCalledTimes(1);
  });
});

describe("without a provider", () => {
  it("does nothing and reports no capture in progress", () => {
    function Probe() {
      const screenshot = useScreenshot();
      screenshot.registerMenu(null);
      screenshot.menuEntered();
      screenshot.menuExited();
      return <output>{String(screenshot.capturing)}</output>;
    }
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("false");
  });
});
