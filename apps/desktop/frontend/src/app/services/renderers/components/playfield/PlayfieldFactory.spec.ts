import { Container } from "pixi.js";
import { PlayfieldFactory } from "./PlayfieldFactory";

describe("Playfield layers", () => {
  function playfield() {
    const layers = {
      border: new Container(),
      spinners: new Container(),
      objects: new Container(),
      approachCircles: new Container(),
      errorOutline: new Container(),
      judgements: new Container(),
      judgementComponents: new Container(),
      cursors: new Container(),
    };
    const calls: string[] = [];
    const factory = new PlayfieldFactory(
      { createPlayfieldBorder: () => ({ graphics: layers.border }) } as never,
      {
        createHitObjectsContainer: () => ({
          spinnerProxies: layers.spinners,
          hitObjectContainer: layers.objects,
          approachCircleContainer: layers.approachCircles,
          updateHitObjects: () => calls.push("objects"),
        }),
      } as never,
      { getContainer: () => layers.cursors, updateCursors: () => calls.push("cursors") } as never,
      {
        getContainer: () => layers.judgements,
        getComponentContainer: () => layers.judgementComponents,
        updateJudgements: () => calls.push("judgements"),
      } as never,
      { container: layers.errorOutline, update: () => calls.push("errorOutline") } as never,
    );
    return { playfield: factory.createPlayfield(), layers, calls };
  }

  it("draws the error outline above the objects and below the hit results and the cursor", () => {
    const { playfield: field, layers } = playfield();
    expect(field.container.children).toEqual([
      layers.border,
      layers.spinners,
      layers.objects,
      layers.approachCircles,
      layers.errorOutline,
      layers.judgements,
      layers.judgementComponents,
      layers.cursors,
    ]);
  });

  it("updates the outline with the rest of the playfield, every frame", () => {
    const { playfield: field, calls } = playfield();
    field.updatePlayfield();
    field.updatePlayfield();
    expect(calls.filter((call) => call === "errorOutline")).toHaveLength(2);
    expect([...calls].sort()).toEqual(
      ["cursors", "cursors", "errorOutline", "errorOutline", "judgements", "judgements", "objects", "objects"],
    );
  });
});
