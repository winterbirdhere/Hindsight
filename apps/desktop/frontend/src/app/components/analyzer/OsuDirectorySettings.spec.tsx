import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { access } from "fs/promises";
import { frontendAPI } from "../../api";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { OsuFolderService } from "../../services/common/local/OsuFolderService";
import { OsuDirectorySettings } from "./OsuDirectorySettings";

jest.mock("../../api", () => ({ frontendAPI: { selectDirectory: jest.fn(), reboot: jest.fn() } }));
jest.mock("electron", () => ({ ipcRenderer: { send: jest.fn() } }));
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn(), useCommonManagers: jest.fn() }));
jest.mock("fs/promises", () => ({ ...jest.requireActual("fs/promises"), access: jest.fn() }));
jest.mock("@rewind/osu-local/utils", () => ({
  ...jest.requireActual("@rewind/osu-local/utils"),
  determineSongsFolder: jest.fn().mockResolvedValue("Songs"),
}));
jest.mock("username", () => ({ __esModule: true, default: jest.fn().mockResolvedValue("User") }));

const oldFolder = "D:\\Games\\osu!";
const newFolder = "E:\\Rhythm Games\\osu! [new]";
let folders: OsuFolderService;

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  (access as jest.Mock).mockResolvedValue(undefined);
  (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue(newFolder);
  (frontendAPI.reboot as jest.Mock).mockResolvedValue(undefined);
  folders = new OsuFolderService();
  folders.setOsuFolder(oldFolder);
  localStorage.setItem("unrelated-setting", "keep-me");
  (useAnalysisApp as jest.Mock).mockReturnValue({ osuFolderService: folders });
  (useCommonManagers as jest.Mock).mockReturnValue({ appInfoService: { version: "test" } });
});

it("shows the selected path and the restart hint", () => {
  render(<OsuDirectorySettings />);
  expect(screen.getByText(oldFolder)).toBeTruthy();
  expect(screen.getByText("Hindsight restarts to apply a new folder.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();
});

it("shows Not selected without a folder", () => {
  folders.setOsuFolder("");
  render(<OsuDirectorySettings />);
  expect(screen.getByText("Not selected")).toBeTruthy();
});

it("shows a long path in full", () => {
  const longPath = ("D:\\" + "osu-folder-segment\\".repeat(11) + "osu!").slice(0, 200);
  expect(longPath).toHaveLength(200);
  folders.setOsuFolder(longPath);
  render(<OsuDirectorySettings />);
  expect(screen.getByText(longPath).textContent).toBe(longPath);
});

it("validates and stages a choice, then persists only the folder before restarting", async () => {
  render(<OsuDirectorySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  expect(await screen.findByText(newFolder)).toBeTruthy();
  expect(folders.getOsuFolder()).toBe(oldFolder);
  expect(frontendAPI.reboot).not.toHaveBeenCalled();
  let folderAtRestart: string | undefined;
  let preferenceAtRestart: string | null = null;
  (frontendAPI.reboot as jest.Mock).mockImplementation(async () => {
    folderAtRestart = JSON.parse(localStorage.getItem("osu-settings") ?? "{}").osuStablePath;
    preferenceAtRestart = localStorage.getItem("unrelated-setting");
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply and restart" }));
  await waitFor(() => expect(folders.getOsuFolder()).toBe(newFolder));
  expect(frontendAPI.reboot).toHaveBeenCalledTimes(1);
  expect(folderAtRestart).toBe(newFolder);
  expect(preferenceAtRestart).toBe("keep-me");
});

it("leaves the current folder untouched when the picker is cancelled", async () => {
  (frontendAPI.selectDirectory as jest.Mock).mockResolvedValue(null);
  render(<OsuDirectorySettings />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change…" })));
  expect(folders.getOsuFolder()).toBe(oldFolder);
  expect(screen.queryByRole("button", { name: "Apply and restart" })).toBeNull();
  expect(frontendAPI.reboot).not.toHaveBeenCalled();
});

it("rejects invalid folders without saving or restarting", async () => {
  (access as jest.Mock).mockRejectedValue(new Error("missing osu!.db"));
  render(<OsuDirectorySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  expect((await screen.findByRole("alert")).textContent).toContain("osu!.db");
  expect(folders.getOsuFolder()).toBe(oldFolder);
  expect(screen.queryByRole("button", { name: "Apply and restart" })).toBeNull();
  expect(frontendAPI.reboot).not.toHaveBeenCalled();
});

it("allows cancelling a valid staged change", async () => {
  render(<OsuDirectorySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  await screen.findByText(newFolder);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(newFolder)).toBeNull();
  expect(folders.getOsuFolder()).toBe(oldFolder);
});

it("reports picker failures and allows another attempt", async () => {
  (frontendAPI.selectDirectory as jest.Mock).mockRejectedValueOnce(new Error("dialog failed"));
  render(<OsuDirectorySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not open");
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  expect(await screen.findByText(newFolder)).toBeTruthy();
});

it("does not restart if saving fails", async () => {
  render(<OsuDirectorySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  await screen.findByText(newFolder);
  const save = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage full");
  });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Apply and restart" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save");
    expect(frontendAPI.reboot).not.toHaveBeenCalled();
    expect(folders.getOsuFolder()).toBe(oldFolder);
  } finally {
    save.mockRestore();
  }
});

it("explains a restart failure after the folder was saved", async () => {
  (frontendAPI.reboot as jest.Mock).mockRejectedValue(new Error("relaunch failed"));
  render(<OsuDirectorySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Change…" }));
  await screen.findByText(newFolder);
  fireEvent.click(screen.getByRole("button", { name: "Apply and restart" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Folder saved");
  expect(JSON.parse(localStorage.getItem("osu-settings") ?? "{}").osuStablePath).toBe(newFolder);
  expect(localStorage.getItem("unrelated-setting")).toBe("keep-me");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect((screen.getByRole("button", { name: "Change…" }) as HTMLButtonElement).disabled).toBe(true);
  const save = jest.spyOn(folders, "setOsuFolder");
  (frontendAPI.reboot as jest.Mock).mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Retry restart" }));
  await waitFor(() => expect(frontendAPI.reboot).toHaveBeenCalledTimes(2));
  expect(save).not.toHaveBeenCalled();
});
