import type { LibrarySort } from "../../../../../shared/library-query";

/** Header and virtual rows share tracks, cell insets and scroll content width. */
export const LIBRARY_LIST_COLUMNS: readonly {
  key: string;
  label: string;
  width: number;
  flexible?: boolean;
  align: "left" | "right" | "center";
  sort?: LibrarySort;
}[] = [
  { key: "grade", label: "Grade", width: 44, align: "center" },
  { key: "artwork", label: "Artwork", width: 72, align: "left" },
  { key: "title", label: "Replay", width: 192, flexible: true, align: "left", sort: "title" },
  { key: "mods", label: "Mods", width: 116, align: "left" },
  { key: "sr", label: "Stars", width: 72, align: "right", sort: "sr" },
  { key: "bpm", label: "BPM", width: 60, align: "right", sort: "bpm" },
  { key: "len", label: "Length", width: 76, align: "right", sort: "len" },
  { key: "acc", label: "Accuracy", width: 88, align: "right", sort: "acc" },
  { key: "combo", label: "Combo", width: 82, align: "right", sort: "combo" },
  { key: "miss", label: "Miss", width: 56, align: "right", sort: "miss" },
  { key: "ur", label: "UR", width: 80, align: "right", sort: "ur" },
  { key: "pp", label: "PP", width: 62, align: "right", sort: "pp" },
  { key: "peak", label: "Peak", width: 66, align: "right", sort: "peak" },
  { key: "date", label: "Played", width: 96, align: "right", sort: "date" },
  { key: "save", label: "Save", width: 44, align: "center" },
];
export const LIBRARY_LIST_TRACKS = LIBRARY_LIST_COLUMNS.map(column =>
  column.flexible ? `minmax(${column.width}px,1fr)` : `${column.width}px`,
).join(" ");
export const LIBRARY_LIST_MIN_WIDTH = LIBRARY_LIST_COLUMNS.reduce((sum, column) => sum + column.width, 0);
export const LIBRARY_LIST_HEADER_HEIGHT = 36;
export const LIBRARY_LIST_ROW_HEIGHT = 54;
