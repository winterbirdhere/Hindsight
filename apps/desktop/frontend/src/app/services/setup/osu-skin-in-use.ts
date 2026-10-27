import { readFile } from "fs/promises";
import { join } from "path";

const SEPARATOR = " = ";

/**
 * The value of the `Skin` line in the text of an osu! user config. `osuUserConfigParse` (libs/osu-local/utils) cannot
 * be used here: it splits a line on every `" = "` and keeps only the part before the second one, so it would cut a
 * skin named `a = b` to `a`. This reads the line the same way (comments skipped, key and value split at the first
 * `" = "`) but keeps the whole rest of the line.
 */
function skinLine(text: string): string | undefined {
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const at = line.indexOf(SEPARATOR);
    if (at !== -1 && line.slice(0, at) === "Skin") return line.slice(at + SEPARATOR.length);
  }
  return undefined;
}

/**
 * The `Skin = …` value of `osu!.<userName>.cfg`, or undefined when the file or the line is missing or empty. Never
 * throws.
 */
export async function readOsuSkinInUse(osuFolder: string, userName: string): Promise<string | undefined> {
  if (osuFolder.trim() === "" || userName.trim() === "") return undefined;
  try {
    const text = await readFile(join(osuFolder, `osu!.${userName}.cfg`), "utf8");
    const value = skinLine(text)?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}
