import { preserveDevelopmentProfile } from "./application-profile";

function fixture(
  overrides: Partial<{
    name: string;
    isPackaged: boolean;
    userData: string;
    sessionData: string;
    explicit: boolean;
  }> = {},
) {
  const options = {
    name: "Hindsight",
    isPackaged: false,
    userData: "C:\\Roaming\\Hindsight",
    sessionData: "C:\\Roaming\\Hindsight",
    explicit: false,
    ...overrides,
  };
  const paths = { appData: "C:\\Roaming", userData: options.userData, sessionData: options.sessionData };
  const app = {
    name: options.name,
    isPackaged: options.isPackaged,
    commandLine: { hasSwitch: jest.fn(() => options.explicit) },
    getPath: jest.fn((key: keyof typeof paths) => paths[key]),
    setPath: jest.fn((key: "userData" | "sessionData", value: string) => {
      paths[key] = value;
    }),
  };
  const ensureDirectory = jest.fn();
  return { app, paths, ensureDirectory, run: () => preserveDevelopmentProfile(app, ensureDirectory, "win32") };
}

describe("stable development profile", () => {
  it("keeps the legacy user data and default session before consumers initialize", () => {
    const f = fixture();
    f.run();
    expect(f.paths).toEqual({
      appData: "C:\\Roaming",
      userData: "C:\\Roaming\\rewind",
      sessionData: "C:\\Roaming\\rewind",
    });
    expect(f.ensureDirectory).toHaveBeenCalledTimes(1);
    expect(f.ensureDirectory).toHaveBeenCalledWith("C:\\Roaming\\rewind");
    expect(f.ensureDirectory.mock.invocationCallOrder[0]).toBeLessThan(f.app.setPath.mock.invocationCallOrder[0]);
  });
  it.each([{ isPackaged: true }, { explicit: true }, { name: "Electron" }])(
    "does not redirect a different launch boundary: %j",
    (options) => {
      const f = fixture(options);
      f.run();
      expect(f.app.setPath).not.toHaveBeenCalled();
      expect(f.ensureDirectory).not.toHaveBeenCalled();
    },
  );
  it("keeps existing rewind defaults without filesystem work", () => {
    const f = fixture({ name: "rewind", userData: "C:\\Roaming\\rewind", sessionData: "C:\\Roaming\\rewind" });
    f.run();
    expect(f.app.setPath).not.toHaveBeenCalled();
    expect(f.ensureDirectory).not.toHaveBeenCalled();
  });
  it("preserves custom user and session paths", () => {
    const f = fixture({ userData: "D:\\trial\\userData", sessionData: "D:\\trial\\sessionData" });
    f.run();
    expect(f.app.setPath).not.toHaveBeenCalled();
  });
  it("does not alter a custom session when redirecting default user data", () => {
    const f = fixture({ sessionData: "D:\\session" });
    f.run();
    expect(f.paths.userData).toBe("C:\\Roaming\\rewind");
    expect(f.paths.sessionData).toBe("D:\\session");
    expect(f.app.setPath).toHaveBeenCalledTimes(1);
  });
  it("preserves an explicit user path even when session still equals the original default", () => {
    const f = fixture({ userData: "D:\\user" });
    f.run();
    expect(f.app.setPath).not.toHaveBeenCalled();
  });
  it("compares Windows defaults with normalized case and separators", () => {
    const f = fixture({ userData: "c:/roaming/HINDSIGHT/", sessionData: "C:/ROAMING/hindsight" });
    f.run();
    expect(f.paths.userData).toBe("C:\\Roaming\\rewind");
    expect(f.paths.sessionData).toBe("C:\\Roaming\\rewind");
  });
});
