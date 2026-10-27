import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { ReplayFrame } from "../src/replays/Replay";

export const traceMapText = (objects: string) => `osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:9
ApproachRate:9
SliderMultiplier:1
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
${objects}
`;
export const traceFrame = (time: number, x = 300, actions: number[] = [], rawButtonMask?: number): ReplayFrame => ({
  time,
  position: { x, y: 192 },
  actions,
  rawButtonMask,
});
export const traceFixtures = [
  {
    name: "boundary-two-sides",
    objects: "300,192,1000,1,0\n300,192,1110,1,0",
    frames: [traceFrame(900), traceFrame(1110, 300, [0, 1])],
    mechanism: "input-miss",
  },
  {
    name: "expiry",
    objects: "300,192,1000,1,0",
    frames: [traceFrame(900), traceFrame(1200)],
    mechanism: "automatic-expiry",
  },
  {
    name: "early-input",
    objects: "300,192,1000,1,0",
    frames: [traceFrame(700), traceFrame(800, 300, [0]), traceFrame(1200)],
    mechanism: "input-miss",
  },
  {
    name: "selected-without-result",
    objects: "300,192,1000,1,0",
    frames: [traceFrame(450), traceFrame(500, 300, [0])],
    mechanism: "selection-only",
  },
  {
    name: "zero-delta",
    objects: "100,192,1000,1,0\n300,192,1000,1,0",
    frames: [traceFrame(900), traceFrame(1000, 100, [0]), traceFrame(1000, 300), traceFrame(1000, 300, [0])],
    mechanism: "successful-input",
  },
  {
    name: "physical-held",
    objects: "300,192,1000,1,0\n300,192,1050,1,0",
    frames: [
      traceFrame(900),
      traceFrame(1000, 300, [0], 1),
      traceFrame(1010, 300, [0], 5),
      traceFrame(1050, 300, [0, 1], 7),
    ],
    mechanism: "logical-edges-only",
  },
  {
    name: "blocked-then-success",
    objects: "100,192,1000,1,0\n300,192,1050,1,0",
    frames: [
      traceFrame(900),
      traceFrame(950, 300, [0]),
      traceFrame(951),
      traceFrame(960, 300, [0]),
      traceFrame(970),
      traceFrame(1000, 100, [0]),
      traceFrame(1001),
      traceFrame(1050, 300, [0]),
    ],
    mechanism: "policy-history",
  },
  {
    name: "ordered-force",
    objects: "100,192,1000,1,0\n300,192,1050,1,0",
    frames: [traceFrame(900), traceFrame(1050, 300, [0])],
    mechanism: "ordered-force-miss-native",
  },
  {
    name: "slider-overlap",
    objects: "300,192,1000,2,0,L|340:192,1,40\n300,192,1111,1,0",
    frames: [
      traceFrame(900),
      traceFrame(1000, 300, [0]),
      traceFrame(1100, 320, [0]),
      traceFrame(1110),
      traceFrame(1111, 300, [1]),
      traceFrame(1300),
    ],
    mechanism: "surrounding-slider",
  },
  {
    name: "partial-replay",
    objects: "300,192,1000,1,0\n300,192,5000,1,0",
    frames: [traceFrame(900), traceFrame(1000, 300, [0])],
    mechanism: "future-unjudged",
  },
  {
    name: "spinner",
    objects: "256,192,1000,8,0,1300",
    frames: [traceFrame(900), traceFrame(1000, 300, [0]), traceFrame(1100, 200, [0]), traceFrame(1400)],
    mechanism: "unsupported-component-state-parity",
  },
  {
    name: "long-dense",
    objects: Array.from({ length: 400 }, (_, i) => `300,192,${1000 + i * 20},1,0`).join("\n"),
    frames: Array.from({ length: 802 }, (_, i) => traceFrame(990 + i * 10, 300, i % 2 ? [0] : [])),
    mechanism: "mixed-resolutions",
  },
];
export function traceBeatmap(objects: string) {
  return buildBeatmap(parseBlueprint(traceMapText(objects)), { addStacking: false, mods: [] });
}
/** Preserve insertion order of Maps/Sets and every order-relevant array. */
export function normalizeTraceState(value: unknown): unknown {
  if (value === undefined) return { $value: "undefined" };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (value instanceof Map) return { map: Array.from(value, ([k, v]) => [k, normalizeTraceState(v)]) };
  if (value instanceof Set) return { set: Array.from(value, normalizeTraceState) };
  if (Array.isArray(value)) return value.map(normalizeTraceState);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeTraceState(v)]));
  return value;
}
