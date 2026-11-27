import { posix, win32 } from "path";

interface ProfileApplication {
  isPackaged: boolean;
  name: string;
  commandLine: { hasSwitch(name: string): boolean };
  getPath(name: "appData" | "userData" | "sessionData"): string;
  setPath(name: "userData" | "sessionData", path: string): void;
}

/** Public branding must not silently select a new development profile. */
export function preserveDevelopmentProfile(
  app: ProfileApplication,
  ensureDirectory: (directory: string) => void,
  platform: NodeJS.Platform = process.platform,
): void {
  // Packaged Hindsight already used Hindsight. Launchers and CLI profiles own
  // their paths; do not discover, merge or copy existing user directories.
  if (app.isPackaged !== false || !["hindsight", "rewind"].includes(app.name.toLowerCase())) return;
  if (app.commandLine.hasSwitch("user-data-dir")) return;
  const paths = platform === "win32" ? win32 : posix;
  const normalize = (value: string) =>
    platform === "win32" ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const initialUserData = app.getPath("userData");
  const defaultUserData = paths.join(app.getPath("appData"), app.name);
  if (normalize(initialUserData) !== normalize(defaultUserData)) return;
  const legacy = paths.join(app.getPath("appData"), "rewind");
  if (normalize(initialUserData) === normalize(legacy)) return;
  const initialSessionData = app.getPath("sessionData");
  ensureDirectory(legacy);
  app.setPath("userData", legacy);
  if (normalize(initialSessionData) === normalize(initialUserData)) app.setPath("sessionData", legacy);
}
