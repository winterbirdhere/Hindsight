import type { LazerMod, ParsedReplayFrames } from "@osujs/core";
import type { LibraryReplayData } from "../../../../../shared/library-replay-data";
import type { OsuReplay } from "../../model/OsuReplay";
import { replayFromParsedSource } from "../../model/replay-from-source";

function nativeMods(value: unknown): readonly LazerMod[] {
  if (!Array.isArray(value) || value.some(mod => !mod || typeof mod !== "object" || Array.isArray(mod) ||
      typeof mod.acronym !== "string" || !mod.acronym.trim() || (mod.settings !== undefined &&
        (!mod.settings || typeof mod.settings !== "object" || Array.isArray(mod.settings)))))
    throw new Error("Native mod settings are unavailable or invalid");
  return value as LazerMod[];
}

export function replayFromLibrarySource(data: LibraryReplayData, parsed: ParsedReplayFrames): OsuReplay {
  const native = data.nativeSource && !data.nativeSource.isLegacyScore;
  const source = native && data.lazerMods === undefined ? { ...data, lazerMods: nativeMods(data.nativeSource?.mods) } : data;
  const replay = replayFromParsedSource(source, parsed);
  if (native && replay.sourceProvenance !== "user-confirmed") {
    replay.sourceClient = "lazer"; replay.sourceProvenance = "native-database";
  }
  return replay;
}
