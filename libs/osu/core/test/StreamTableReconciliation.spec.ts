import { reconcileStreamTables, StreamLocalTable } from "../src/gameplay/error-analysis/StreamTableReconciliation";

const table=(overrides:Partial<StreamLocalTable>={}):StreamLocalTable=>({familyId:"family",assignments:[],scopes:{},alternatives:[],...overrides});
const cadence={componentId:"47",inputId:"p",relation:"matched",confidence:"corroborated",basis:"cadence",eventIds:["p","a"]} as const;
const local={componentId:"48",inputId:"p",relation:"matched",confidence:"corroborated",basis:"scheduled-geometric",eventIds:["p","b"]} as const;
const matched=(row:typeof cadence|typeof local)=>({...row,eventIds:[...row.eventIds]});

describe("same physical stream reconciliation retains competing evidence",()=>{
  it("does not let cadence weight erase an otherwise supported different owner",()=>{
    const r=reconcileStreamTables("48",[table({assignments:[matched(cadence)]}),table({assignments:[matched(local)]})],["p"]);
    expect(r.assignments).toEqual([expect.objectContaining({inputId:"p",relation:"ambiguous",eventIds:["a","b","p"]})]);
    expect(r.assignments[0].competingClaims?.map(a=>a.componentId)).toEqual(["47","48"]);
    expect(r.scopes).toEqual({});
  });
  it("does not resurrect a conflicted family claim when a natural peer also overlaps",()=>{
    const r=reconcileStreamTables("48",[table({assignments:[matched(cadence)]}),
      table({assignments:[matched(local)]}),table({familyId:"natural"})],["p"]);
    expect(r.assignments[0].relation).toBe("ambiguous");
    expect(r.assignments[0].competingClaims?.map(a=>a.componentId)).toEqual(["47","48"]);
  });
  it("preserves established cadence priority between different physical families",()=>{
    const r=reconcileStreamTables("48",[table({assignments:[matched(cadence)]}),
      table({familyId:"natural",assignments:[matched(local)]})],["p"]);
    expect(r.assignments[0]).toMatchObject({componentId:"47",basis:"cadence",relation:"matched"});
    expect(r.assignments[0].competingClaims).toHaveLength(2);
  });
  it.each(["extra","ambiguous"] as const)("retains %s evidence against an inferred match and removes contradicted absence",relation=>{
    const a=table({assignments:[{inputId:"p",relation,confidence:"ambiguous",eventIds:["p","x"]},
      {componentId:"48",relation:"missing",confidence:"corroborated",eventIds:["missing"]}]}),
      b=table({assignments:[matched(local)]});
    const r=reconcileStreamTables("48",[a,b],["p"]);
    expect(r.assignments).toContainEqual(expect.objectContaining({inputId:"p",relation:"ambiguous",eventIds:expect.arrayContaining(["x","b"])}));
    expect(r.assignments.some(row=>row.componentId==="48"&&row.relation==="missing")).toBe(false);
  });
  it("preserves an actual successful receiver over an inferential disagreement",()=>{
    const a=table({assignments:[{...matched(cadence),confidence:"anchored"}]}),b=table({assignments:[matched(local)]});
    const r=reconcileStreamTables("48",[a,b],["p"]);
    expect(r.assignments[0]).toMatchObject({componentId:"47",relation:"matched",confidence:"anchored"});
    expect(r.assignments[0].competingClaims).toHaveLength(2);
  });
  it("keeps an active phase alternative and every witness when another scope calls it inactive",()=>{
    const alternative={phaseMs:-10,targetInputIds:["p"],reason:"one-slot-reception-shift" as const,active:true,recentAnchorCount:1,eventIds:["a"]};
    const r=reconcileStreamTables("48",[table({alternatives:[alternative]}),
      table({alternatives:[{...alternative,active:false,recentAnchorCount:3,eventIds:["b"]}]})],[]);
    expect(r.alternatives).toEqual([{...alternative,eventIds:["a","b"]}]);
  });
  it("never retains a disputed spatial fence and is immutable/order independent",()=>{
    const a=table({assignments:[matched(local)],scopes:{p:{placementEnd:{timeMs:10,inclusive:true},eventIds:["a"]}}}),
      b=table({assignments:[matched(local)],scopes:{p:{placementEnd:{timeMs:20,inclusive:true},eventIds:["b"]}}});
    const before=JSON.stringify([a,b]);
    const r=reconcileStreamTables("48",[a,b],["p"]);
    expect(r.scopes).toEqual({});
    expect(r).toEqual(reconcileStreamTables("48",[b,a],["p"]));
    expect(JSON.stringify([a,b])).toBe(before);
  });
  it("retains distinct phase/geometry metadata without choosing by table order",()=>{
    const a=table({assignments:[{...matched(local),basis:"cadence",phaseMs:35,anchorOffsetsMs:[35,35],
      contextEventIds:["context-a"],geometry:{minimumSampledR:1.2,pressR:1.3,closestTimeMs:100,eventIds:["geometry-a"]}}]}),
      b=table({assignments:[{...matched(local),basis:"cadence",phaseMs:40,anchorOffsetsMs:[40,40],
        contextEventIds:["context-b"],geometry:{minimumSampledR:1.4,pressR:1.5,closestTimeMs:105,eventIds:["geometry-b"]}}]});
    const r=reconcileStreamTables("48",[a,b],["p"]);
    expect(r).toEqual(reconcileStreamTables("48",[b,a],["p"]));
    expect(r.assignments[0].contextEventIds).toEqual(["context-a","context-b"]);
    expect(r.assignments[0].eventIds).toEqual(expect.arrayContaining(["geometry-a","geometry-b"]));
    expect(r.assignments[0]).toHaveProperty("competingEvidence",expect.arrayContaining([
      expect.objectContaining({phaseMs:35}),expect.objectContaining({phaseMs:40})]));
  });
  it("refuses a bounded union overflow rather than dropping competing input",()=>{
    const r=reconcileStreamTables("48",[table()],Array.from({length:513},(_,i)=>String(i)));
    expect(r.unavailable).toBe(true);
    expect(r.limitations).toContain("stream-action-limit");
    expect(r.assignments).toEqual([]);
  });
});
