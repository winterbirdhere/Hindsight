import { act, fireEvent, render, screen } from "@testing-library/react";
import username from "username";
import { useNavigate } from "react-router-dom";
import { frontendAPI } from "../../api";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { checkOsuFolder } from "../../services/setup/osu-folder-checks";
import { SetupScreen } from "./SetupScreen";

jest.mock("../../api", () => ({ frontendAPI: { selectDirectory: jest.fn() } }));
jest.mock("react-router-dom", () => ({ useNavigate: jest.fn() }));
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("username", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../services/setup/osu-folder-checks", () => ({
  checkOsuFolder: jest.fn(),
  osuFolderReady: (checks: { songs: boolean; replays: boolean; core: boolean }) => checks.songs && checks.core,
}));

const READY = { songs: true, replays: true, core: true };
const NOTHING = { songs: false, replays: false, core: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let navigate: jest.Mock;
let setOsuFolder: jest.Mock;

const continueButton = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
const field = () => screen.getByLabelText("osu! folder") as HTMLInputElement;

async function browse() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  navigate = jest.fn();
  setOsuFolder = jest.fn();
  (useNavigate as jest.Mock).mockReturnValue(navigate);
  (useAnalysisApp as jest.Mock).mockReturnValue({ osuFolderService: { setOsuFolder } });
  (username as unknown as jest.Mock).mockResolvedValue("Player");
  (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue(null);
  (checkOsuFolder as jest.Mock).mockResolvedValue(READY);
});

describe("SetupScreen", () => {
  it("starts with no check rows and a disabled Continue", () => {
    render(<SetupScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Where is osu! installed?");
    expect(field().placeholder).toBe("Choose your osu! folder");
    expect(screen.queryByText(/folder found/)).toBeNull();
    expect(screen.queryByText(/folder here/)).toBeNull();
    expect(continueButton().disabled).toBe(true);
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(checkOsuFolder).not.toHaveBeenCalled();
  });

  it("checks the browsed folder, enables Continue, then saves and navigates", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
    render(<SetupScreen />);
    await browse();

    expect(frontendAPI.selectDirectory).toHaveBeenCalledWith("");
    expect(checkOsuFolder).toHaveBeenCalledWith("D:\\osu!", "Player");
    expect(field().value).toBe("D:\\osu!");
    expect(screen.getByText("Songs folder found")).toBeTruthy();
    expect(screen.getByText("Replays folder found")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Songs folder found");
    expect(continueButton().disabled).toBe(false);

    fireEvent.click(continueButton());
    expect(setOsuFolder).toHaveBeenCalledWith("D:\\osu!");
    expect(navigate).toHaveBeenCalledWith("/app/analyzer");
    expect(setOsuFolder.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });

  it("passes the current text to the picker as its starting folder", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
    render(<SetupScreen />);
    await browse();
    await browse();
    expect((frontendAPI.selectDirectory as jest.Mock).mock.calls[1][0]).toBe("D:\\osu!");
  });

  it("marks a folder with neither Songs nor Replays invalid and keeps Continue disabled", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\Games");
    (checkOsuFolder as jest.Mock).mockResolvedValue({ songs: false, replays: false, core: true });
    render(<SetupScreen />);
    await browse();

    expect(screen.getByText("No Songs folder here")).toBeTruthy();
    expect(screen.getByText("No Replays folder here. You can still open replay files.")).toBeTruthy();
    expect(screen.queryByText("osu!.db, scores.db or the Skins folder is missing")).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(setOsuFolder).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("continues without a Replays folder", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
    (checkOsuFolder as jest.Mock).mockResolvedValue({ songs: true, replays: false, core: true });
    render(<SetupScreen />);
    await browse();

    const row = screen.getByText("No Replays folder here. You can still open replay files.");
    expect(row.textContent).toBe("No Replays folder here. You can still open replay files.");
    expect(getComputedStyle(row).color).toBe("rgb(168, 165, 158)");
    const icon = row.querySelector("svg");
    expect(icon?.getAttribute("width")).toBe("12");
    expect(icon?.getAttribute("height")).toBe("12");
    const dot = icon?.querySelector("circle");
    expect(dot?.getAttribute("r")).toBe("2");
    expect(dot?.getAttribute("fill")).toBe("#6a675f");
    expect(icon?.querySelector("path, polyline")).toBeNull();
    expect(screen.getByText("Songs folder found")).toBeTruthy();
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(continueButton().disabled).toBe(false);

    fireEvent.click(continueButton());
    expect(setOsuFolder).toHaveBeenCalledWith("D:\\osu!");
    expect(navigate).toHaveBeenCalledWith("/app/analyzer");
  });

  it("adds a row and blocks Continue when only the core files are missing", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
    (checkOsuFolder as jest.Mock).mockResolvedValue({ songs: true, replays: true, core: false });
    render(<SetupScreen />);
    await browse();

    expect(screen.getByText("Songs folder found")).toBeTruthy();
    expect(screen.getByText("Replays folder found")).toBeTruthy();
    expect(screen.getByText("osu!.db, scores.db or the Skins folder is missing")).toBeTruthy();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(continueButton().disabled).toBe(true);
  });

  it("ignores a check that finishes after a newer one started", async () => {
    const first = deferred<typeof READY>();
    const second = deferred<typeof NOTHING>();
    (checkOsuFolder as jest.Mock).mockImplementation((path: string) =>
      path === "D:\\first" ? first.promise : second.promise,
    );
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValueOnce("D:\\first").mockResolvedValueOnce("D:\\second");
    render(<SetupScreen />);
    await browse();
    await browse();
    expect(checkOsuFolder).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(NOTHING));
    expect(screen.getByText("No Songs folder here")).toBeTruthy();
    await act(async () => first.resolve(READY));

    expect(field().value).toBe("D:\\second");
    expect(screen.getByText("No Songs folder here")).toBeTruthy();
    expect(screen.queryByText("Songs folder found")).toBeNull();
    expect(continueButton().disabled).toBe(true);
  });

  it("checks a typed path 200 ms after the last keystroke", async () => {
    jest.useFakeTimers();
    try {
      render(<SetupScreen />);
      fireEvent.change(field(), { target: { value: "D:\\os" } });
      await act(async () => {
        jest.advanceTimersByTime(150);
      });
      fireEvent.change(field(), { target: { value: "D:\\osu!" } });
      await act(async () => {
        jest.advanceTimersByTime(199);
      });
      expect(checkOsuFolder).not.toHaveBeenCalled();
      expect(continueButton().disabled).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(checkOsuFolder).toHaveBeenCalledTimes(1);
      expect(checkOsuFolder).toHaveBeenCalledWith("D:\\osu!", "Player");
      expect(continueButton().disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("hides the rows and disables Continue as soon as the text changes", async () => {
    jest.useFakeTimers();
    try {
      (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
      render(<SetupScreen />);
      await browse();
      expect(continueButton().disabled).toBe(false);

      fireEvent.change(field(), { target: { value: "D:\\osu" } });
      expect(screen.queryByText("Songs folder found")).toBeNull();
      expect(continueButton().disabled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("clears the result and skips the check when the field is emptied", async () => {
    jest.useFakeTimers();
    try {
      (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
      render(<SetupScreen />);
      await browse();
      (checkOsuFolder as jest.Mock).mockClear();
      fireEvent.change(field(), { target: { value: "" } });
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(checkOsuFolder).not.toHaveBeenCalled();
      expect(screen.queryByText(/folder (found|here)/)).toBeNull();
      expect(continueButton().disabled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("continues with Enter in the field only when the folder is ready", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
    render(<SetupScreen />);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(navigate).not.toHaveBeenCalled();

    await browse();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(setOsuFolder).toHaveBeenCalledWith("D:\\osu!");
    expect(navigate).toHaveBeenCalledWith("/app/analyzer");
  });

  it("uses an empty user name when the name lookup rejects", async () => {
    (username as unknown as jest.Mock).mockRejectedValue(new Error("no user"));
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
    render(<SetupScreen />);
    await browse();
    expect(checkOsuFolder).toHaveBeenCalledWith("D:\\osu!", "");
    expect(continueButton().disabled).toBe(false);
  });

  it("shows local setup guidance without opening a website or changing the selected folder", async () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    try {
      (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue("D:\\osu!");
      render(<SetupScreen />);
      await browse();
      const help = screen.getByRole("button", { name: "Setup help" });
      expect(help.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(help);
      const guide = screen.getByRole("region", { name: "Find your osu! folder" });
      expect(help.getAttribute("aria-expanded")).toBe("true");
      expect(help.getAttribute("aria-controls")).toBe(guide.id);
      expect(guide.textContent).toContain("%LOCALAPPDATA%\\osu!");
      expect(guide.textContent).toContain("Open osu! folder");
      expect(guide.textContent).toContain("Open file location");
      expect(guide.textContent).toContain("osu!.db");
      expect(guide.textContent).toContain("scores.db");
      expect(guide.textContent).toContain("lazer");
      expect(guide.querySelector("a[href]")).toBeNull();
      expect(open).not.toHaveBeenCalled();
      expect(field().value).toBe("D:\\osu!");
      expect(continueButton().disabled).toBe(false);
      expect(setOsuFolder).not.toHaveBeenCalled();
      fireEvent.click(help);
      expect(screen.queryByRole("region", { name: "Find your osu! folder" })).toBeNull();
      expect(help.getAttribute("aria-expanded")).toBe("false");
    } finally {
      open.mockRestore();
    }
  });

  it("closes help with Escape and returns keyboard focus without enabling Continue", () => {
    render(<SetupScreen />);
    const help = screen.getByRole("button", { name: "Setup help" });
    fireEvent.click(help);
    field().focus();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Find your osu! folder" })).toBeNull();
    expect(document.activeElement).toBe(help);
    expect(continueButton().disabled).toBe(true);
    expect(checkOsuFolder).not.toHaveBeenCalled();
  });

  it("checks and saves the trimmed path", async () => {
    jest.useFakeTimers();
    try {
      render(<SetupScreen />);
      fireEvent.change(field(), { target: { value: "  D:osu! " } });
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(checkOsuFolder).toHaveBeenCalledTimes(1);
      expect(checkOsuFolder).toHaveBeenCalledWith("D:osu!", "Player");
      expect(continueButton().disabled).toBe(false);
      fireEvent.click(continueButton());
      expect(setOsuFolder).toHaveBeenCalledWith("D:osu!");
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows no rows for a whitespace-only field", async () => {
    jest.useFakeTimers();
    try {
      render(<SetupScreen />);
      fireEvent.change(field(), { target: { value: "   " } });
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(checkOsuFolder).not.toHaveBeenCalled();
      expect(screen.queryByText(/folder (found|here)/)).toBeNull();
      expect(field().getAttribute("aria-invalid")).toBeNull();
      expect(continueButton().disabled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("starts no check when the picker answers after unmount", async () => {
    const picker = deferred<string | null>();
    (frontendAPI.selectDirectory as jest.Mock).mockReturnValue(picker.promise);
    const { unmount } = render(<SetupScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    unmount();
    await act(async () => picker.resolve("D:osu!"));
    expect(checkOsuFolder).not.toHaveBeenCalled();
  });

  it("keeps an empty status region mounted before any check", () => {
    render(<SetupScreen />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("changes nothing when the picker is cancelled", async () => {
    (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue(null);
    render(<SetupScreen />);
    await browse();
    expect(field().value).toBe("");
    expect(checkOsuFolder).not.toHaveBeenCalled();
    expect(screen.queryByText(/folder (found|here)/)).toBeNull();
    expect(continueButton().disabled).toBe(true);
  });

  it("does not render the logo", () => {
    render(<SetupScreen />);
    expect(document.querySelector("svg[aria-label], img")).toBeNull();
  });
});
