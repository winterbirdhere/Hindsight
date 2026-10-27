import { dominantBeatLength, invariantDominantBeatLength } from "./TempoSummary";

it("weights elapsed map duration rather than timing point count", () => {
  expect(dominantBeatLength([{ time: 0, beatLength: 500 }, { time: 30000, beatLength: 250 }], 120000)).toBe(250);
});
it("groups to 0.001ms and keeps the earliest tempo on duration ties", () => {
  expect(dominantBeatLength([{ time: 0, beatLength: 500.0001 }, { time: 10000, beatLength: 500.0002 },
    { time: 30000, beatLength: 250 }], 60000)).toBe(500);
});
it("clips prezero and postcompletion intervals and preserves equal-time ordering", () => {
  expect(dominantBeatLength([{ time: -1000, beatLength: 1000 }, { time: -500, beatLength: 500 },
    { time: 0, beatLength: 250 }, { time: 100000, beatLength: 100 }], 30000)).toBe(250);
  expect(dominantBeatLength([{ time: 0, beatLength: 500 }, { time: 0, beatLength: 250 }], 30000)).toBe(250);
});
it("preserves the viewer's invalid-point filtering and absent-horizon fallback", () => {
  expect(dominantBeatLength([], null)).toBeNull();
  expect(dominantBeatLength([{ time: 0, beatLength: 0 }, { time: NaN, beatLength: 500 }], 10)).toBeNull();
  expect(dominantBeatLength([{ time: 0, beatLength: 500 }, { time: 100, beatLength: 250 }], null)).toBe(500);
});

it("certifies a dominant tempo across uncertain ends without choosing an approximate horizon", () => {
  const points=[{time:0,beatLength:500},{time:30000,beatLength:250},{time:101000,beatLength:100}];
  expect(invariantDominantBeatLength(points,100000,102500)).toBe(250);
  expect(invariantDominantBeatLength(points,120000,120000)).toBe(dominantBeatLength(points,120000));
});
it("does not confuse matching endpoint winners with a proof across intervening tempo changes", () => {
  const points=[{time:0,beatLength:500},{time:100,beatLength:250},{time:220,beatLength:500}];
  expect(dominantBeatLength(points,100)).toBe(500);expect(dominantBeatLength(points,400)).toBe(500);
  expect(dominantBeatLength(points,220)).toBe(250);
  expect(invariantDominantBeatLength(points,100,400)).toBeNull();
});
it("uses exact earliest ties and never admits an epsilon-sized loss", () => {
  const points=[{time:0,beatLength:500},{time:500,beatLength:250}];
  expect(invariantDominantBeatLength(points,1000-1e-10,1000)).toBe(500);
  expect(invariantDominantBeatLength(points,1000,1000+1e-10)).toBeNull();
});
it("retains grouping, prezero clipping and duplicate ordering in the certificate", () => {
  const points=[{time:-1000,beatLength:1000},{time:-500,beatLength:500.0001},{time:0,beatLength:500.0002},
    {time:30000,beatLength:250},{time:30000,beatLength:500.0001},{time:40000,beatLength:250}];
  const copy=JSON.parse(JSON.stringify(points));
  expect(invariantDominantBeatLength(points,50000,60000)).toBe(500);expect(points).toEqual(copy);
});
it.each([[0,1],[-1,2],[2,1],[1,Infinity],[NaN,2]])("rejects unproven interval bounds %s..%s", (lower,upper) => {
  expect(invariantDominantBeatLength([{time:0,beatLength:500}],lower,upper)).toBeNull();
});
it("bounds certificate work and rejects missing or malformed consumed evidence", () => {
  expect(invariantDominantBeatLength([],1,2)).toBeNull();
  expect(invariantDominantBeatLength([{time:0,beatLength:500},{time:NaN,beatLength:250}],1,2)).toBeNull();
  expect(invariantDominantBeatLength(Array.from({length:8193},(_,time)=>({time,beatLength:500})),9000,10000)).toBeNull();
});
