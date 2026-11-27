import { stat } from "fs/promises";
import { join } from "path";
import { determineSongsFolder } from "@rewind/osu-local/utils";
import { osuFolderSanityCheck } from "../common/local/OsuFolderService";

export interface OsuFolderChecks {
  songs: boolean;
  replays: boolean;
  core: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function songsFolderExists(path: string, userName: string): Promise<boolean> {
  try {
    return await isDirectory(await determineSongsFolder(path, userName));
  } catch {
    return false;
  }
}

/**
 * Checks what the first-run screen shows for a candidate osu! folder. Every check resolves to a boolean; nothing
 * throws, and an empty path never touches the disk.
 */
export async function checkOsuFolder(path: string, userName: string): Promise<OsuFolderChecks> {
  if (path.trim() === "") return { songs: false, replays: false, core: false };
  const [songs, replays, core] = await Promise.all([
    songsFolderExists(path, userName),
    isDirectory(join(path, "Replays")),
    osuFolderSanityCheck(path).catch(() => false),
  ]);
  return { songs, replays, core };
}

/** Replays is optional: replay files can still be opened without the folder. */
export function osuFolderReady(checks: OsuFolderChecks): boolean {
  return checks.songs && checks.core;
}
