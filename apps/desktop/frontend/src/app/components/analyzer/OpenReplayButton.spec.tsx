import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { frontendAPI } from "../../api";
import { OpenReplayButton } from "./OpenReplayButton";

let mockPlatform = "win32";
jest.mock("../../api", () => ({ frontendAPI: { runAppMenuAction: jest.fn() } }));
jest.mock("../../hooks/app-info", () => ({ useAppInfo: () => ({ platform: mockPlatform, version: "test" }) }));

describe("OpenReplayButton", () => {
  const runAppMenuAction = frontendAPI.runAppMenuAction as jest.Mock;
  beforeEach(() => {
    mockPlatform = "win32";
    runAppMenuAction.mockClear();
  });

  it("draws the 3a folder glyph as a decorative svg inside the named button", () => {
    render(<OpenReplayButton disabled={false} />);
    const button = screen.getByRole("button", { name: "Open replay" });
    const svgs = button.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute("aria-hidden")).toBe("true");
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 14 12");
    expect(svgs[0].getAttribute("data-testid")).toBeNull();
  });

  it("stays disabled until an osu! folder is configured", () => {
    render(<OpenReplayButton disabled />);
    const button = screen.getByRole("button", { name: "Open replay" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(runAppMenuAction).not.toHaveBeenCalled();
  });

  it("opens the native picker through the allowlisted bridge", () => {
    render(<OpenReplayButton disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
    expect(runAppMenuAction).toHaveBeenCalledWith("openReplay");
  });

  it("releases activation focus after the native picker resolves", async () => {
    let resolveDialog!: () => void;
    runAppMenuAction.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveDialog = resolve)));
    render(<OpenReplayButton disabled={false} />);
    const button = screen.getByRole("button", { name: "Open replay" });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(document.body);
    button.focus();
    await act(async () => resolveDialog());
    expect(document.activeElement).toBe(document.body);
  });

  it("announces F2 on Windows and macOS", () => {
    render(<OpenReplayButton disabled={false} />);
    expect(screen.getByRole("button", { name: "Open replay" }).getAttribute("aria-keyshortcuts")).toBe("F2");
    mockPlatform = "darwin";
    render(<OpenReplayButton disabled={false} />);
    expect(screen.getAllByRole("button", { name: "Open replay" })[1].getAttribute("aria-keyshortcuts")).toBe("F2");
  });

  it("shows F2 in the replay button tooltip", async () => {
    render(<OpenReplayButton disabled={false} />);
    fireEvent.mouseOver(screen.getByRole("button", { name: "Open replay" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Open replay · F2");
  });
});
