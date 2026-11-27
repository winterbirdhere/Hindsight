export interface OnlineBeatmap {
  beatmapId: number;
  beatmapsetId: number;
}

export type BeatmapLookupResult =
  | { status: "FOUND"; beatmap: OnlineBeatmap }
  | { status: "NOT_FOUND" }
  | { status: "UNAVAILABLE" };
