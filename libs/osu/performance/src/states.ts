import type { CumulativePerformanceState } from "./types";

/** Preserve this play's 100s/50s, convert misses to hits, and omit its actual ScoreV1 total. */
export function fullComboPerformanceState(final:CumulativePerformanceState,maxCombo:number):CumulativePerformanceState {
  const s=final.statistics;
  return{time:final.time,passedObjects:final.passedObjects,maxCombo,statistics:{great:s.great+s.miss,ok:s.ok,meh:s.meh,miss:0,
    large_tick_hit:s.large_tick_hit+s.large_tick_miss,large_tick_miss:0,small_tick_hit:s.small_tick_hit+s.small_tick_miss,small_tick_miss:0,
    slider_tail_hit:s.slider_tail_hit+s.slider_tail_miss,slider_tail_miss:0},isFinal:true};
}
