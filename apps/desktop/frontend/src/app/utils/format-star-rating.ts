/** Mirrors osu! FormatUtils.FormatStarRating: never round up a difficulty threshold. */
export function formatStarRating(starRating: number): string {
  return (Math.floor(starRating * 100) / 100).toFixed(2);
}
