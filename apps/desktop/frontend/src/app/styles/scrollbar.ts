/** A quiet 6 px scrollbar instead of the heavy native one with arrow buttons. */
export const thinScrollbar = {
  scrollbarWidth: "thin",
  scrollbarColor: "rgba(255,255,255,0.14) transparent",
  "&::-webkit-scrollbar": { width: 6 },
  "&::-webkit-scrollbar-button": { display: "none", height: 0 },
  "&::-webkit-scrollbar-track": { background: "transparent" },
  "&::-webkit-scrollbar-thumb": { backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 3 },
  "&::-webkit-scrollbar-thumb:hover": { backgroundColor: "rgba(255,255,255,0.24)" },
} as const;
