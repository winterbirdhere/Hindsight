import type { CSSProperties } from "react";
import type { LibrarySort } from "../../../../../shared/library-query";

export interface LibraryListColumn {
  key: LibrarySort | "grade" | "artwork" | "mods" | "save";
  label: string;
  width: number;
  flexible?: boolean;
  align: "left" | "right" | "center";
  sort?: LibrarySort;
  pin?: "title" | "sort";
}

export const LIBRARY_LIST_COLUMNS: readonly LibraryListColumn[] = [
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
export const LIBRARY_LIST_HEADER_HEIGHT = 36;
export const LIBRARY_LIST_ROW_HEIGHT = 54;

/** Use the available space beside the sidebar, rail and inspector, regardless of window size. */
export function libraryListLayout(sort: LibrarySort, resultsWidth: number) {
  // Keep the established full-width table, adding the otherwise absent estimate only when requested.
  const fc: LibraryListColumn = { key: "fc", label: "PP if FC", width: 98, align: "right", sort: "fc" };
  const wide = sort === "fc" ? LIBRARY_LIST_COLUMNS.flatMap(column => column.key === "peak" ? [column, fc] : [column]) : LIBRARY_LIST_COLUMNS;
  const wideWidth = wide.reduce((sum, column) => sum + column.width, 0);
  let columns = wide;
  let titleWidth = 0;
  let pinnedWidth = 0;
  if (resultsWidth > 0 && resultsWidth < wideWidth) {
    const title = wide.find(column => column.key === "title");
    const active = wide.find(column => column.sort === sort);
    if (!title || !active) throw new Error(`Missing replay comparison column for ${sort}`);
    titleWidth = Math.min(256, Math.max(112, Math.floor(resultsWidth * 0.34)));
    const pinned: LibraryListColumn[] = [{ ...title, width: titleWidth, flexible: false, pin: "title" }];
    if (active.key !== "title") {
      pinned.push({ ...active, width: Math.max(active.width, sort === "date" ? 122 : 98), pin: "sort" });
    }
    pinnedWidth = pinned.reduce((sum, column) => sum + column.width, 0);
    columns = [...pinned, ...wide.filter(column => column.key !== "title" && column.key !== sort)];
  }
  const tracks = columns.map(column => column.flexible ? `minmax(${column.width}px,1fr)` : `${column.width}px`).join(" ");
  const style = {
    "--lib-list-tracks": tracks,
    "--lib-list-min-width": `${columns.reduce((sum, column) => sum + column.width, 0)}px`,
    "--lib-list-title-width": `${titleWidth}px`,
    "--lib-list-pinned-width": `${pinnedWidth}px`,
  } as CSSProperties;
  return { columns, style };
}
