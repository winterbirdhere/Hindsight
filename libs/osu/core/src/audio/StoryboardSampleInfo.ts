export type StoryboardSampleLayer = 0 | 1 | 2 | 3;

/** A timed audio sample declared in an `.osu` or `.osb` storyboard. */
export interface StoryboardSampleInfo {
  time: number;
  layer: StoryboardSampleLayer;
  filename: string;
  volume: number;
}

export interface BeatmapBreakPeriod {
  startTime: number;
  endTime: number;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function replaceVariables(value: string, variables: ReadonlyMap<string, string>): string {
  let result = value;
  const names = Array.from(variables.keys()).sort((left, right) => right.length - left.length);
  for (const name of names) result = result.split(name).join(variables.get(name) ?? name);
  return result;
}

/** Parses only storyboard sample declarations; visual storyboard commands remain outside Rewind's audio path. */
export function parseStoryboardSampleEvents(data: string): StoryboardSampleInfo[] {
  const variables = new Map<string, string>();
  const sampleLines: string[] = [];
  let section = "";

  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (!line || line.startsWith("//")) continue;
    if (section === "variables" && line.startsWith("$")) {
      const separator = line.indexOf("=");
      if (separator > 1) variables.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1)));
    } else if (section === "events" && /^(?:Sample|5)\s*,/i.test(line)) {
      sampleLines.push(line);
    }
  }

  const samples: StoryboardSampleInfo[] = [];
  const samplePattern =
    /^(?:Sample|5)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*([0-3])\s*,\s*(?:"([^"]+)"|([^,]+?))(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*$/i;
  for (const line of sampleLines) {
    const match = line.match(samplePattern);
    if (!match) continue;
    const time = Number(match[1]);
    const layer = Number(match[2]) as StoryboardSampleLayer;
    const filename = replaceVariables((match[3] ?? match[4] ?? "").trim(), variables);
    const parsedVolume = match[5] === undefined ? 100 : Number(match[5]);
    if (!Number.isFinite(time) || !filename || !Number.isFinite(parsedVolume)) continue;
    samples.push({
      time,
      layer,
      filename,
      volume: Math.max(0, Math.min(100, parsedVolume)),
    });
  }
  return samples.sort((left, right) => left.time - right.time || left.filename.localeCompare(right.filename));
}

/** Parses legacy storyboard break declarations from the beatmap's Events section. */
export function parseBeatmapBreakPeriods(data: string): BeatmapBreakPeriod[] {
  const breaks: BeatmapBreakPeriod[] = [];
  let section = "";
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (section !== "events" || !line || line.startsWith("//")) continue;
    const match = line.match(/^(?:Break|2)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i);
    if (!match) continue;
    const startTime = Number(match[1]);
    const endTime = Number(match[2]);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) continue;
    breaks.push({ startTime, endTime });
  }
  return breaks.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
}
