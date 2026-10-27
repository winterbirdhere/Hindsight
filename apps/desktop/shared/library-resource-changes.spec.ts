import { appendLibraryResourceChanges, readLibraryResourceChanges } from "./library-resource-changes";

const delta = { from: "1:7", to: "1:9", scope: "replays" as const, replayIds: ["two", "one", "one"] };
it("copies bounded replay IDs and accepts raw or matching owner-qualified intervals without Number rounding", () => {
  expect(readLibraryResourceChanges(delta, "1:9")).toEqual({ ...delta, replayIds: ["one", "two"] });
  expect(readLibraryResourceChanges({ ...delta, from: "9007199254740992", to: "9007199254740993" }, "9007199254740993")).toBeDefined();
  const copied = readLibraryResourceChanges(delta, "1:9"); delta.replayIds.push("later");
  expect(copied).toEqual({ ...delta, replayIds: ["one", "two"] }); delta.replayIds.pop();
});
it.each([
  null, [], { ...delta, from: "2:7" }, { ...delta, from: "1:10" }, { ...delta, to: "1:8" },
  { ...delta, from: "01:7" }, { ...delta, from: "1:7\n" }, { ...delta, scope: ["replays"] }, { ...delta, scope: Object.create(null) }, { ...delta, extra: true },
  { ...delta, replayIds: [["one"]] }, { ...delta, replayIds: [] }, { ...delta, replayIds: new Array(1) }, { ...delta, replayIds: ["private/path"] }, { ...delta, replayIds: ["one\n"] },
  { ...delta, replayIds: ["x".repeat(129)] }, { ...delta, replayIds: Array.from({ length: 257 }, (_, i) => "id" + i) },
  { from: "1:7", to: "1:9", scope: "all", replayIds: [] },
])("rejects an unusable scope without certifying freshness: %j", value => {
  expect(readLibraryResourceChanges(value, "1:9")).toBeUndefined();
});
it("unions contiguous changes, with global fallback for gaps, missing evidence and overflow", () => {
  const first = { from: "7", to: "8", scope: "replays" as const, replayIds: ["one"] };
  expect(appendLibraryResourceChanges(first, "8", "9", { ...first, from: "8", to: "9", replayIds: ["two"] }))
    .toEqual({ from: "7", to: "9", scope: "replays", replayIds: ["one", "two"] });
  for (const next of [undefined, { ...first, from: "6", to: "9" }, { from: "8", to: "9", scope: "all" }])
    expect(appendLibraryResourceChanges(first, "8", "9", next)).toEqual({ from: "7", to: "9", scope: "all" });
  const full = { ...first, replayIds: Array.from({ length: 256 }, (_, i) => "id" + i) };
  expect(appendLibraryResourceChanges(full, "8", "9", { ...first, from: "8", to: "9" }).scope).toBe("all");
  expect(appendLibraryResourceChanges({ from: "7", to: "8", scope: "all" }, "8", "9", { ...first, from: "8", to: "9" }).scope).toBe("all");
});
