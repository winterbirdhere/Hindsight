import { farReturnCalls } from "./fixtures/ReviewedFarReturnCalls";
import { CircleEvidence, EvidenceBoundary } from "../src/gameplay/miss-explanation/CircleEvidence";
import { analyzePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproach";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";

function outsideFlow(profile: "stable" | "lazer" | "classic", repair=false, rotation=false, late=false) {
  const coords=[[700,296],[970,296],[980,297],[990,298],[1000,300],[1010,303],[1020,310],[1030,320],[1040,340],[1060,360],[1080,380],
    ...(late?[[1090,390],[1100,400]]:[]),[1200,450]];
  const tap=late?1080:1000,frames=coords.map(([t,x])=>{
    const y=repair&&t===tap?192:236,px=repair&&t===tap?300:x,position=rotation?{x:300+y-192,y:192-(px-300)}:{x:px,y};
    return {...traceFrame(t,x,t>=tap&&t<tap+70?[0]:[]),position};
  });
  return {...errorFixture("300,192,1000,1,0",frames,profile==="stable"?"stable":"lazer",[],profile==="classic"?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]),frames};
}
describe("source-local completed outside traversal",()=>{
  it.each(["stable","lazer","classic"] as const)("recognizes %s lateral flow without requiring a radial landing",profile=>{
    for(const kind of ["ordinary","rotation","late"] as const){
      const f=outsideFlow(profile,false,kind==="rotation",kind==="late"),e=deriveCircleEvidence(f.trace,f.map,"0"),before=JSON.stringify(f.trace);
      expect(e.terminal?.result).toBe("MISS");expect(e.directRejections).toEqual([]);
      const input=e.inputs.find(i=>i.record.freshActions.length)!;
      const ep=analyzePrimaryApproaches(e,{pressIds:[input.record.id]}).episodes[0];
      expect(ep.contacts).toEqual([]);expect(ep.spatialCandidates.map(s=>s.code)).toContain("wide-aim");
      expect(ep.lateralTraversal).toMatchObject({basis:"source-local-outside-traversal"});
      expect(ep.timingIndependent).toBe(false);expect(ep.lateralTraversal!.eventIds).toContain(input.record.id);
      expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Wide aim");
      expect(outsideFlow(profile,true,kind==="rotation",kind==="late").state.hitCircleVerdict["0"].type).toBe(kind==="late"?"MEH":"GREAT");
      expect(JSON.stringify(f.trace)).toBe(before);
    }
  });
  it.each(["source","parsed","raw","history","mask","fresh","unknown","context","placement","terminal","instant","not-live"])(
    "withholds local traversal across %s fence",fault=>{
      const f=outsideFlow("stable"),e=JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace,f.map,"0"))) as CircleEvidence,press=e.inputs.find(i=>i.record.timeMs===1000)!,next=e.inputs.find(i=>i.record.timeMs===1010)!;
      const context={pressIds:[press.record.id],contextBoundaryInputIds:fault==="context"?[next.record.id]:[],
        inputScopes:fault==="placement"?{[press.record.id]:{placementEnd:{timeMs:1000,inclusive:true}}}:undefined};
      if(press.record.source.origin!=="parsed")throw Error("fixture");
      if(fault==="source")press.record.source.discontinuityBefore=["source-gap"];
      if(fault==="parsed")press.record.source.parsedFrameIndex++;
      if(fault==="raw"){e.inputs.forEach(i=>{if(i.record.source.origin==="parsed")i.record.source.rawTokenIndex=i.record.source.parsedFrameIndex;});press.record.source.rawTokenIndex!++;}
      if(fault==="history")press.record.previousActions=[1];
      if(fault==="mask")press.record.rawButtonMask=2;
      if(fault==="fresh"){next.record.actions=[0,1];next.record.freshActions=[1];}
      if(fault==="unknown")next.freshActionsKnown=false;
      if(fault==="terminal"){e.terminal!.timeMs=1000;e.terminal!.sequence=press.record.sequence;}
      if(fault==="instant")next.record.timeMs=1000;
      if(fault==="not-live")press.inLiveSuccess=false;
      expect(analyzePrimaryApproaches(e,context).episodes[0].spatialCandidates.map(s=>s.code)).not.toContain("wide-aim");
    },
  );
  it.each(["turn","next-landing","short","future-only","no-cross","contact","endpoint"])("does not invent a traversal from %s geometry",fault=>{
    const original=outsideFlow("stable"),frames=original.frames.map(f=>({...f,position:{...f.position}})).filter(f=>fault!=="short"||[700,970,1000,1040,1200].includes(f.time));
    frames.forEach(f=>{
      if(fault==="turn"&&f.time>=1010)f.position.y=236+(f.time-1000)*2;
      if(fault==="next-landing"&&f.time>=1040)f.position={x:300,y:192};
      if(fault==="future-only"&&f.time<=1000)f.position.x=260;
      if(fault==="no-cross")f.position.x+=30;
      if(fault==="contact")f.position.y=224;
      if(fault==="endpoint")f.actions=f.time>=1080?[0]:[];
    });
    const f=errorFixture("300,192,1000,1,0",frames),e=deriveCircleEvidence(f.trace,f.map,"0"),press=e.inputs.find(i=>i.record.freshActions.length)!;
    expect(analyzePrimaryApproaches(e,{pressIds:[press.record.id]}).episodes[0].spatialCandidates.map(s=>s.code)).not.toContain("wide-aim");
  });
});

type Point = [number, number, number?];
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected positive evidence");
  return value;
}
function evidence(points: Point[], press: number, extras: Partial<CircleEvidence> = {}): CircleEvidence {
  const value = {
    status: "supported",
    identity: { analysisProfileId: "stable" },
    targetId: "target",
    target: { hitTimeMs: 1000, spawnTimeMs: 500 },
    geometry: { position: { x: 0, y: 0 }, radius: 1, profile: "stable", hitWindows: [19, 59, 99, 399] },
    domains: {
      nominalSuccess: { state: "nonempty" },
      liveSuccess: { state: "nonempty" },
      interaction: {
        state: "nonempty",
        start: { timeMs: 500, inclusive: true },
        end: { timeMs: 1100, sequence: 999, inclusive: false },
      },
    },
    inputs: points.map(([time, x, y = 0], i) => ({
      record: {
        id: `p${i}`,
        sequence: i + 1,
        kind: "input",
        timeMs: 1000 + time,
        phase: "input",
        position: { x, y },
        actions: i === press ? [0] : [],
        freshActions: i === press ? [0] : [],
        previousActions: [],
        source: { origin: "parsed", parsedFrameIndex: i },
        groupMemberIndex: 0,
      },
      inside: x * x + y * y <= 1,
      freshActionsKnown: true,
      inInteraction: true,
      inLiveSuccess: true,
      pathGroup: 0,
      postTerminal: false,
    })),
    attempts: [],
    routing: [],
    insideIntervals: [],
    terminalReferences: [],
    terminal: { id: "terminal", sequence: 999, timeMs: 1100, kind: "resolution", result: "MISS" },
    dependencies: Object.fromEntries(
      ["input", "geometry", "routing", "lifecycle"].map((name) => [name, { status: "complete", reasons: [] }]),
    ),
    limitations: [],
    limits: { maxInputs: 4096, maxIntervals: 2048, maxRelatedRecords: 32768, truncated: false },
  } as unknown as CircleEvidence;
  return { ...value, ...extras };
}
const analyze = (e: CircleEvidence, press: number, contextBoundaryInputIds: string[] = []) =>
  analyzePrimaryApproaches(e, { pressIds: [`p${press}`], contextBoundaryInputIds }).episodes[0];
const labels = (e: CircleEvidence, press: number) => analyze(e, press).spatialCandidates.map((x) => x.label);

describe("directional landing requires central approach and a proper earlier pass", () => {
  it.each([[.74, "Overshoot"], [.75, "Misaim"], [.9, "Misaim"]] as const)(
    "describes a braked far-side landing at transverse %sR as %s", (side, label) => {
      const e = evidence([[-60,-4,side],[-40,-2,side],[-20,0,side],[-5,1.3,side],
        [5,1.35,side],[10,1.35,side],[20,1.2,side]],4);
      expect(labels(e,4)).toEqual([label]);
    });
  it.each([[.74, "Undershoot"], [.75, "Misaim"], [.9, "Misaim"]] as const)(
    "describes a braked near-side landing at transverse %sR as %s", (side, label) => {
      const e = evidence([[-60,-4,side],[-40,-2,side],[-20,-1.3,side],[-5,-1.3,side],
        [5,-1.35,side],[20,-2,side]],4);
      expect(labels(e,4)).toEqual([label]);
    });
  it("retains the shallow-rim braking witness without calling its sideways landing Overshoot", () => {
    const R = stableGameplayRadius(34.2400016784668);
    const world = [[-139,312.3333,41.66667],[-123,312.3333,28],[-106,307.3333,23],
      [-90,298.6667,24],[-73,285,34],[-67,279.3333,40.33333],[-57,270,52.66667],
      [-39,245,83.33334],[-23,220.6667,106.3333],[-6,198.3333,126.3333],
      [10,183.6667,141],[21,181.6667,145.6667],[28,184,147],[44,205,147.3333],
      [60,247.3333,147.6667],[72,286.3333,149],[77,298.3333,149.3333],[94,343.6667,149]];
    const e = evidence(world.map(([t,x,y]) => [t,(x-217)/R,(y-151)/R]),11);
    e.geometry!.hitWindows = [26,68,110,399];
    const ep = analyze(e,11);
    expect(ep.landing?.transverseR).toBeCloseTo(.938711,4);
    expect(ep.landing?.alongR).toBeCloseTo(.388601,4);
    expect(ep.contacts[0].minRadialR).toBeCloseTo(.894532,4);
    expect(ep.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
  });
  it("requires a proper earlier contact even when the later landing is central", () => {
    const e=evidence([[-80,-4,.8],[-60,-2,.8],[-50,0,.8],[-35,1.1,.8],
      [-20,1.3,.2],[-10,1.32,.2],[0,1.32,.2],[20,1.2,.2]],6);
    const ep=analyze(e,6);
    expect(ep.landing?.transverseR).toBeCloseTo(.2,6);
    expect(ep.contacts[0].minRadialR).toBeCloseTo(.8,6);
    expect(ep.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
  });
});

// A deep crossing whose surrounding motion bends consistently: the chord is
// y=.1, while the two observed directed headings meet at (0,.8). These literal
// geometry expectations do not assume that the unrecorded mouse followed a curve.
const curvedContactPoints = (): Point[] => [
  [-40, -2, -.6], [-20, -1, .1], [-19, -1, .1], [20, 1, .1], [40, 2, -.6],
];

describe("completed outside lobe crest membership", () => {
  const points = (pressX: number): Point[] => [[-95,-4,.4],[-80,pressX,.4],[-60,-4,.5],
    [-40,-3,.7],[-20,-2,1.1],[0,-.2,1.3],[20,.3,1.35],[40,1,1.7],[70,2,2]];
  function value(profile: "stable" | "lazer", pressX: number) {
    const e = evidence(points(pressX),1); e.geometry!.profile=profile;
    e.inputs.forEach((i,k)=>{
      const actions=k===1?[0]:k===5?[1]:[];
      i.record.previousActions=k?e.inputs[k-1].record.actions:[];
      i.record.actions=actions;i.record.freshActions=actions.filter(a=>!i.record.previousActions.includes(a));
    });
    return e;
  }
  it.each(["stable", "lazer"] as const)("retains an earlier tap within the full crest noise band in %s", profile => {
    for(const x of [-4.015,-4.005]) {
      const e=value(profile,x),before=JSON.stringify(e),r=analyzePrimaryApproaches(e,{pressIds:["p1","p5"]});
      expect(r.episodes.map(p=>p.spatialCandidates.map(s=>s.label))).toEqual([["Misaim"],["Misaim"]]);
      for(const ep of r.episodes) {
        expect(ep.landing!.radialR).toBeCloseTo(1.313449051,7);
        expect(ep.landing!.eventIds).toContain(ep.inputId);
        expect(ep.contacts).toEqual([]);
      }
      expect(JSON.stringify(e)).toBe(before);
    }
  });
  it.each(["stable", "lazer"] as const)("does not attach a materially earlier outward tap to the later lobe in %s", profile => {
    const r=analyzePrimaryApproaches(value(profile,-3.8),{pressIds:["p1","p5"]});
    // The short earlier approach/retreat now supplies broad placement, but it
    // must never borrow the later, much deeper lobe or its directional claim.
    expect(r.episodes[0].boundedOutsideLobe?.eventIds).toEqual(["p0","p1","p2"]);
    expect(r.episodes[0].landing?.eventIds).toEqual(["p0","p1","p2"]);
    expect(r.episodes[0].landing?.radialR).toBeCloseTo(3.8209946,6);
    expect(r.episodes[0].spatialCandidates.map(s=>s.label)).toEqual(["Misaim"]);
    expect(r.episodes[1].spatialCandidates.map(s=>s.label)).toEqual(["Misaim"]);
  });
  it.each(["stable", "lazer"] as const)("respects each source and ownership fence across a crest in %s", profile => {
    for(const stop of ["source","unknown","fresh","context","placement"] as const) {
      const e=value(profile,-4.005);
      const ctx={pressIds:["p1","p5"],contextBoundaryInputIds:stop==="context"?["p2"]:[],
        inputScopes:stop==="placement"?{p1:{placementEnd:{timeMs:930,inclusive:true}}}:undefined};
      if(stop==="source"&&e.inputs[2].record.source.origin==="parsed")e.inputs[2].record.source.discontinuityBefore=["source-gap"];
      if(stop==="unknown")e.inputs[2].freshActionsKnown=false;
      if(stop==="fresh")e.inputs[2].record.freshActions=[1];
      expect(analyzePrimaryApproaches(e,ctx).episodes[0].placement).toBe("unproven");
    }
  });
});

describe("material near-side completed lobe",()=>{
  it("keeps a completed material lobe when its crest also borders a short broad lobe",()=>{
    const e=evidence([[-124,4.845236,-3.984479],[-121,4.442622,-4.387089],[-105,3.651281,-5.164548],
      [-90,3.068186,-5.761526],[-87,3.068186,-5.761526],[-70,2.832173,-6.094723],
      [-55,2.762755,-6.205790],[-39,2.748873,-6.219672],[-37,2.748873,-6.219672],
      [-21,2.721106,-6.178024],[-4,2.526742,-5.386679],[-1,2.318493,-4.706405],
      [14,2.013062,-3.984479],[28,1.416085,-2.748873],[46,.944057,-1.77705],
      [61,.69416,-1.180072],[62,.652510,-1.041239],[79,.638627,-.971823],
      [80,.638627,-.971823],[96,.902408,-1.346670]],7);
    e.inputs.forEach((i,k)=>{
      const actions=k===7?[0]:k===16?[1]:[];
      i.record.previousActions=k?e.inputs[k-1].record.actions:[];
      i.record.actions=actions;i.record.freshActions=actions.filter(a=>!i.record.previousActions.includes(a));
    });
    const ep=analyzePrimaryApproaches(e,{pressIds:["p7","p16"]}).episodes[0];
    expect(ep.lobeAlternatives).toHaveLength(2);
    expect(ep.spatialCandidates.map(c=>c.code)).toEqual(["undershoot"]);
    expect(ep.landing?.radialR).toBeCloseTo(1.162878,5);
    expect(ep.landing?.eventIds).toContain("p7");
    expect(ep.boundedOutsideDwell).toBeUndefined();
  });
  function fixture(profile:"stable"|"lazer",x=-.31) {
    const e=evidence([[-90,-4,.96],[-60,-3,.96],[-30,-2,.96],[0,-1,.96],[30,x,.96],[60,-1,.96],[90,-2,.96]],1);
    e.geometry!.profile=profile;
    e.inputs.forEach((i,k)=>{i.record.previousActions=k?e.inputs[k-1].record.actions:[];});return e;
  }
  it.each(["stable","lazer"] as const)("retains material %s placement with a sideways landing beyond the central corridor",profile=>{
    const e=fixture(profile),r=analyze(e,1),before=JSON.stringify(e);
    expect(r.contacts).toEqual([]);expect(r.reconstructedMinimumRadius).toBeCloseTo(Math.sqrt(.31**2+.96**2),6);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(r.landing?.alongR).toBeCloseTo(-.31,6);expect(r.landing?.transverseR).toBeCloseTo(.96,6);
    expect(JSON.stringify(e)).toBe(before);
  });
  it.each(["stable","lazer"] as const)("preserves the %s material direction threshold and actual containment",profile=>{
    const broad=analyze(fixture(profile,-.30),1);
    expect(broad.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(broad.boundedOutsideLobe).toBeDefined();
    expect(broad.limitations).toContain("directional-subtype-below-noise");
    expect(analyze(fixture(profile,-.27),1).spatialCandidates).toEqual([]);
    expect(analyze(fixture(profile,-.40),1).spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
  });
  it.each((["stable","lazer"] as const).flatMap(profile=>["gap","fresh","context","placement","terminal"].map(fault=>[profile,fault] as const)))(
    "does not use %s departure across %s",(profile,fault)=>{
      const e=fixture(profile),ctx={pressIds:["p1"],contextBoundaryInputIds:fault==="context"?["p5"]:[],
        inputScopes:fault==="placement"?{p1:{placementEnd:{timeMs:1030,inclusive:true}}}:undefined};
      if(fault==="gap"&&e.inputs[5].record.source.origin==="parsed")e.inputs[5].record.source.discontinuityBefore=["test-gap"];
      if(fault==="fresh"){e.inputs[5].record.actions=[1];e.inputs[5].record.freshActions=[1];}
      if(fault==="terminal")e.terminal={...required(e.terminal),timeMs:1040};
      expect(analyzePrimaryApproaches(e,ctx).episodes[0].spatialCandidates).toEqual([]);
    },
  );
});

describe("shallow contact heading-band corroboration", () => {
  const points = (y=.96): Point[] => [[-80,-4,y],[-60,-3,y],[-40,-2,y],[-10,-.5,y],
    [10,.5,y],[40,2,y],[60,3,y],[80,4,y]];
  function fixture(profile: "stable" | "lazer", data=points()) {
    const e=evidence(data,1);e.geometry!.profile=profile;
    e.inputs.forEach((i,k)=>{
      const actions=k===1?[0]:k===e.inputs.length-2?[1]:[];
      i.record.previousActions=k?e.inputs[k-1].record.actions:[];
      i.record.actions=actions;i.record.freshActions=actions.filter(a=>!i.record.previousActions.includes(a));
    });return e;
  }
  it.each([0, Math.PI/2, Math.PI/5, Math.PI])("corroborates a shallow inside normal band under rotation %s", angle=>{
    for(const profile of ["stable","lazer"] as const) {
      const e=fixture(profile,points().map(([t,x,y=0])=>[t,x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)])),before=JSON.stringify(e);
      const result=analyzePrimaryApproaches(e,{pressIds:["p1","p6"]});
      for(const ep of result.episodes) {
        expect(ep.placement).toBe("unproven");expect(ep.properPass).toBeUndefined();expect(ep.spatialCandidates).toEqual([]);
        expect(ep.contacts[0]).toMatchObject({placementSupport:"reconstructed-coherent",sampledEventIds:[],deepSampled:false,
          headingBand:{maximumNormalR:expect.closeTo(.96,6),clearanceR:expect.closeTo(.04,6)}});
        expect(ep.contacts[0].entryTimeMs).toBeCloseTo(994.4,4);expect(ep.contacts[0].exitTimeMs).toBeCloseTo(1005.6,4);
        expect(ep.contacts[0].eventIds).toEqual(expect.arrayContaining(["p2","p3","p4","p5"]));
      }
      expect(JSON.stringify(e)).toBe(before);
    }
  });
  it.each(["stable","lazer"] as const)("retains exact key-only duplicates in %s band provenance",profile=>{
    const p=points();p.splice(4,0,[-9,-.5,.96]);const e=fixture(profile,p),r=analyzePrimaryApproaches(e,{pressIds:["p1","p7"]});
    expect(r.episodes[0].contacts[0]?.placementSupport).toBe("reconstructed-coherent");
    expect(r.episodes[0].contacts[0]?.eventIds).toEqual(expect.arrayContaining(["p2","p3","p4","p5","p6"]));
  });
  it.each(["stable","lazer"] as const)("does not infer a %s crossing from a tangent or outside heading band",profile=>{
    const shallow=fixture(profile,points(.99));expect(analyzePrimaryApproaches(shallow,{pressIds:["p1","p6"]}).episodes.every(e=>!e.contacts.some(c=>c.placementSupport==="reconstructed-coherent"))).toBe(true);
    const p=points();p[2][2]=.7;p[5][2]=.7;
    const e=fixture(profile,p),r=analyzePrimaryApproaches(e,{pressIds:["p1","p6"]});
    expect(r.episodes[0].contacts[0].minRadialR).toBeCloseTo(.96,6);expect(r.episodes.every(e=>!e.contacts.some(c=>c.placementSupport==="reconstructed-coherent"))).toBe(true);
  });
  it.each((["stable","lazer"] as const).flatMap(profile=>["absent","complete","partial"].map(metadata=>[profile,metadata] as const)))(
    "retains %s heading evidence with consistent %s raw metadata",(profile,metadata)=>{
      const e=fixture(profile);
      e.inputs.forEach((i,k)=>{
        i.record.rawButtonMask=i.record.actions.includes(0)?4:i.record.actions.includes(1)?8:16;
        if(metadata!=="absent" && (metadata!=="partial" || k!==3) && i.record.source.origin==="parsed")i.record.source.rawTokenIndex=100+k;
      });
      expect(analyzePrimaryApproaches(e,{pressIds:["p1","p6"]}).episodes[0].contacts[0]?.headingBand).toBeDefined();
    },
  );
  it.each(["stable","lazer"] as const)("preserves ignored high raw mask bits in %s source evidence",profile=>{
    const e=fixture(profile);
    e.inputs.forEach(i=>{i.record.rawButtonMask=2**32+(i.record.actions.includes(0)?5:i.record.actions.includes(1)?10:16);});
    expect(analyzePrimaryApproaches(e,{pressIds:["p1","p6"]}).episodes[0].contacts[0]?.headingBand).toBeDefined();
  });
  const fences=["gap","raw-gap","raw-hidden-gap","raw-invalid","raw-mask","parsed-invalid","synthetic","unknown","unlisted","history","context","placement","terminal","instant"] as const;
  it.each((["stable","lazer"] as const).flatMap(profile=>fences.map(stop=>[profile,stop] as const)))(
    "%s band requires complete own evidence across %s",(profile,stop)=>{
      const p=points();if(stop==="instant")p.splice(4,0,[-10,-.49,.96]);const e=fixture(profile,p);
      const ctx={pressIds:["p1",`p${e.inputs.length-2}`],contextBoundaryInputIds:stop==="context"?["p3"]:[],
        inputScopes:stop==="placement"?{p1:{placementEnd:{timeMs:980,inclusive:true}}}:undefined};
      if(stop==="gap"&&e.inputs[3].record.source.origin==="parsed")e.inputs[3].record.source.discontinuityBefore=["source-gap"];
      if(stop==="raw-gap"&&e.inputs[2].record.source.origin==="parsed"&&e.inputs[3].record.source.origin==="parsed") {
        e.inputs[2].record.source.rawTokenIndex=102;e.inputs[3].record.source.rawTokenIndex=104;
      }
      if(stop==="raw-hidden-gap")e.inputs.forEach((i,k)=>{if(i.record.source.origin==="parsed"&&k!==3)i.record.source.rawTokenIndex=k<3?100+k:102+k;});
      if(stop==="raw-invalid"&&e.inputs[3].record.source.origin==="parsed")e.inputs[3].record.source.rawTokenIndex=-1;
      if(stop==="raw-mask")e.inputs[3].record.rawButtonMask=1;
      if(stop==="parsed-invalid")e.inputs.forEach(i=>{if(i.record.source.origin==="parsed")i.record.source.parsedFrameIndex+=.5;});
      if(stop==="synthetic")e.inputs[3].record.source={origin:"synthetic",reason:"test"};
      if(stop==="unknown")e.inputs[3].freshActionsKnown=false;
      if(stop==="unlisted"){e.inputs[3].record.actions=[1];e.inputs[3].record.freshActions=[1];}
      if(stop==="history")e.inputs[3].record.previousActions=[0];
      if(stop==="terminal")e.terminal={...required(e.terminal),timeMs:1010,sequence:5};
      expect(analyzePrimaryApproaches(e,ctx).episodes[0].contacts.some(c=>c.placementSupport==="reconstructed-coherent")).toBe(false);
    },
  );
});

describe("curved contact corroboration", () => {
  it.each([0, Math.PI / 2, Math.PI, 3 * Math.PI / 2])("keeps a same-turn deep crossing under rotation %s", angle => {
    for (const profile of ["stable", "lazer"] as const) {
      const points = curvedContactPoints().map(([t,x,y=0]) =>
        [t, x*Math.cos(angle)-y*Math.sin(angle), x*Math.sin(angle)+y*Math.cos(angle)] as Point);
      const e = evidence(points,1);
      e.geometry!.profile=profile;
      const before=JSON.stringify(e), r=analyze(e,1);
      expect(r.placement).toBe("proper-pass");
      expect(r.properPass).toMatchObject({placementSupport:"reconstructed-coherent",sampledEventIds:[],deepSampled:false});
      expect(r.properPass!.minRadialR).toBeCloseTo(.1,6);
      expect(r.properPass!.entryTimeMs).toBeCloseTo(981.097745,4);
      expect(r.properPass!.exitTimeMs).toBeCloseTo(1019.902255,4);
      expect(r.properPass!.eventIds).toEqual(expect.arrayContaining(["p0","p1","p2","p3","p4"]));
      expect(JSON.stringify(e)).toBe(before);
    }
  });
  it("rejects an envelope outside the receptor although its crossing chord stays deep",()=>{
    const e=evidence(curvedContactPoints().map(([t,x,y=0])=>[t,x,y+.25]),1);
    expect(analyze(e,1).contacts[0].minRadialR).toBeCloseTo(.35,6);
    expect(analyze(e,1).properPass).toBeUndefined();
  });
  it("rejects an opposing turn instead of treating any curved chord as coherent",()=>{
    const p=curvedContactPoints();p[4]=[40,2,.8];
    expect(analyze(evidence(p,1),1).properPass).toBeUndefined();
  });
  it("does not borrow the previous action's heading to certify a curved contact",()=>{
    const e=evidence(curvedContactPoints(),1);
    e.inputs[0].record.freshActions=[1];
    expect(analyze(e,1,["p0"]).properPass).toBeUndefined();
  });
  it("requires continuous own source on both sides of the curved crossing",()=>{
    const e=evidence(curvedContactPoints(),1);
    e.inputs[4].record.source={origin:"parsed",parsedFrameIndex:7};
    expect(analyze(e,1).properPass).toBeUndefined();
  });
  it("does not import the outgoing heading after the live terminal",()=>{
    const e=evidence(curvedContactPoints(),1);
    e.terminal!.timeMs=1030;e.inputs[4].postTerminal=true;
    expect(analyze(e,1).properPass).toBeUndefined();
  });
  it("does not use outgoing motion beyond an explicit approach scope",()=>{
    const e=evidence(curvedContactPoints(),1);
    const r=analyzePrimaryApproaches(e,{pressIds:["p1"],end:{timeMs:1030,inclusive:false}}).episodes[0];
    expect(r.properPass).toBeUndefined();
  });
  it("does not turn an instantaneous incoming position jump into a curved heading",()=>{
    const p=curvedContactPoints();p[0][0]=-20;
    expect(analyze(evidence(p,1),1).properPass).toBeUndefined();
  });
  it("does not import a multi-radius ongoing inward correction as the later tap's settled landing",()=>{
    const e=evidence([[-80,10,10],[-70,7,10],[-50,4,9],[-49,4,9],[-30,2,7],[-10,0,5],
      [1,-1,4],[2,-1.5,3.2],[18,-2,2],[34,-2,1],[50,-1,-.2],[51,-1,-.2],[67,1,-.8],[85,3,-.7]],10);
    e.inputs[2].record.freshActions=[1];
    const r=analyzePrimaryApproaches(e,{pressIds:["p2","p10"]}).episodes[1];
    // The source continues inward from >3R to1.02R between the purported
    // landing and this tap, then crosses. Its older slowdown is not a halt or
    // lateral footprint at this tap. The genuine early attempt remains separate.
    expect(r.spatialCandidates).toEqual([]);
    expect(r.placement).toBe("proper-pass");
    expect(r.relation).toBe("before-pass");
    expect(r.properPass?.minRadialR).toBeCloseTo(.4789131426,6);
  });
  it.each([false,true])("does not call a short continuing slowdown a placement footprint (duplicate=%s)",duplicate=>{
    const points:Point[]=[[-80,8,8],[-60,5,5],[-52,3,1],[-36,2.7,.9],
      ...(duplicate ? [[-35,2.7,.9] as Point] : []),
      [-28,2.3,.7],[-11,1.7,.5],[7,1.25,.4],[23,.8,.2],[40,.3,0],[60,-.4,-.2]];
    for(const profile of ["stable","lazer"] as const){
      const e=evidence(points,3);required(e.geometry).profile=profile;
      const r=analyze(e,3);
      // From the purported short slowdown3R to tap2.85R, pre-tap drop
      // is <.5R. The same uninterrupted recorded approach then reaches
      // the receptor; no outside hold or reversal separates a correction.
      expect(r.spatialCandidates).toEqual([]);
      expect(r.placement).toBe("proper-pass");
      expect(r.relation).toBe("before-pass");
    }
  });
  it("retains a genuine sustained outside landing followed by a separate correction",()=>{
    const e=evidence([[-80,8,8],[-60,5,5],[-45,3,1],[-30,2.8,1],[0,2.8,1],
      [20,2.8,1],[40,2.7,.9],[60,1.8,.5],[80,.7,.1],[95,.3,0]],4);
    expect(analyze(e,4).spatialCandidates.map(c=>c.code)).toContain("misaim");
    expect(analyze(e,4).landing?.footprintDurationMs).toBeGreaterThanOrEqual(19);
  });
  it.each([0,Math.PI/2,Math.PI,3*Math.PI/2])("retains continuous local flow across an old direction change under rotation %s",angle=>{
    const flow:Point[]=[[-90,4,-3],[-70,2,-3],[-60,1,-3],[-50,.5,-2.8],[-40,.4,-2.5],
      [-30,.3,-2.2],[-20,.2,-1.9],[0,0,-1.3],[20,-.2,-.7],[40,-.4,-.2],[60,-.6,.1]];
    for(const profile of ["stable","lazer"] as const){
      const e=evidence(flow.map(([t,x,y=0])=>[t,x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)]),4);
      required(e.geometry).profile=profile;e.inputs[6].record.freshActions=[1];
      const r=analyzePrimaryApproaches(e,{pressIds:["p4","p6"]}).episodes[0];
      expect(r.placement).toBe("proper-pass");
      expect(r.spatialCandidates).toEqual([]);
      expect(r.properPass?.entryTimeMs).toBeCloseTo(1010.172929,4);
    }
  });
  it.each(["context","unlisted-action","placement-fence","source-gap","terminal"] as const)("does not use continued contact beyond a %s boundary to erase an outside footprint",boundary=>{
    const e=evidence([[-90,4,-3],[-70,2,-3],[-60,1,-3],[-50,.5,-2.8],[-40,.4,-2.5],
      [-30,.3,-2.2],[-20,.2,-1.9],[0,0,-1.3],[20,-.2,-.7],[40,-.4,-.2],[60,-.6,.1]],4);
    if(boundary==="unlisted-action")e.inputs[6].record.freshActions=[1];
    if(boundary==="source-gap")e.inputs[6].record.source={origin:"parsed",parsedFrameIndex:6,discontinuityBefore:["source-gap"]};
    if(boundary==="terminal")required(e.terminal).timeMs=990;
    const r=analyzePrimaryApproaches(e,{pressIds:["p4"],
      ...(boundary==="context" ? {contextBoundaryInputIds:["p6"]} : {}),
      ...(boundary==="placement-fence" ? {inputScopes:{p4:{placementEnd:{timeMs:990,inclusive:true}}}} : {})}).episodes[0];
    expect(r.spatialCandidates.map(c=>c.code)).toContain("misaim");
  });
});

// Two independently visible passes. The exact repeated outside sample at
// +60/+65ms is bracketed by inward motion with a .124355rad local turn;
// an old heading change must not turn that five-ms repeat into a landing.
const duplicateContactPoints = (): Point[] => [
  [-90,5,-3],[-70,3,-3],[-50,1,-2],[-20,0,-.2],[10,0,.5],
  [30,.1,1.1],[50,.2,1.5],[60,0,1.2],[65,0,1.2],[76,-.5,.2],[86,-1,-.8],
];
describe("short repeated samples on a continuous return pass",()=>{
  it.each([0,Math.PI/2,Math.PI,3*Math.PI/2])("keeps two real passes under rotation %s",angle=>{
    for(const profile of ["stable","lazer"] as const){
      const points=duplicateContactPoints().map(([t,x,y=0])=>
        [t,x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)] as Point);
      const e=evidence(points,7);required(e.geometry).profile=profile;
      const before=JSON.stringify(e),r=analyze(e,7);
      expect(r.placement).toBe("proper-pass");expect(r.relation).toBe("between-passes");
      expect(r.spatialCandidates).toEqual([]);
      expect(r.contacts.map(c=>c.placementSupport)).toEqual(["sampled","sampled"]);
      expect(r.contacts[0].entryTimeMs).toBeCloseTo(968.046768,4);
      expect(r.contacts[0].exitTimeMs).toBeCloseTo(1026.552310,4);
      expect(r.contacts[1].entryTimeMs).toBeCloseTo(1067.258,3);
      expect(r.contacts[1].exitTimeMs).toBeCloseTo(1083.147,3);
      expect(r.continuingFlow?.eventIds).toEqual(["p6","p7","p8","p9"]);
      expect(JSON.stringify(e)).toBe(before);
    }
  });
  it.each(["turn","reversal","dwell","source-gap","unlisted-action","unknown-action","context","fence","terminal","shallow"] as const)(
    "does not suppress placement without adjacent continuous deep contact (%s)",boundary=>{
      for(const profile of ["stable","lazer"] as const){
        const points=duplicateContactPoints();
        if(boundary==="turn")points[9]=[76,.8,.2];
        if(boundary==="reversal")points[9]=[76,0,1.8];
        if(boundary==="dwell"){points[8]=[90,0,1.2];points[9]=[96,-.5,.2];points[10]=[99,-1,-.8];}
        if(boundary==="shallow"){points[9]=[76,0,.98];points[10]=[86,-1,.8];}
        const e=evidence(points,7);required(e.geometry).profile=profile;
        if(boundary==="source-gap")e.inputs[9].record.source={origin:"parsed",parsedFrameIndex:9,discontinuityBefore:["source-gap"]};
        if(boundary==="unlisted-action")e.inputs[8].record.freshActions=[1];
        if(boundary==="unknown-action")e.inputs[8].freshActionsKnown=false;
        if(boundary==="terminal")required(e.terminal).timeMs=1066;
        const r=analyzePrimaryApproaches(e,{pressIds:["p7"],
          ...(boundary==="context" ? {contextBoundaryInputIds:["p8"]} : {}),
          ...(boundary==="fence" ? {inputScopes:{p7:{placementEnd:{timeMs:1066,inclusive:true}}}} : {}),
        }).episodes[0];
        expect(r.continuingFlow).toBeUndefined();
        expect(r.spatialCandidates.map(c=>c.code)).toContain("misaim");
      }
    });
});

const outwardFlowPoints = (): Point[] => [
  [-100,3,-5],[-90,3,-2],[-60,2,-1],[-30,.5,-.2],
  [0,0,0],[20,.7,-.3],[40,1.2,-.5],[42,1.2,-.5],[50,1.45,-.6],[70,2,-.8],[90,2.5,-1],
];
describe("continuing departure after a real pass",()=>{
  it("gives an after-press candidate one bounded best window to show local continuation",()=>{
    const points:Point[]=[[-90,3,-3],[-80,3,-2],[-60,2,-1],[-30,.5,-.2],[0,0,0],
      [20,.7,-.3],[40,1.2,-.5],[55,2.1,-.86],[58,2.22,-.908],[70,2.7,-1.1],[90,3.3,-1.34]];
    for(const profile of ["stable","lazer"] as const){
      const e=evidence(points,6);required(e.geometry).profile=profile;
      const r=analyze(e,6);
      // The +55→58 segment's immediate speed ratio is2/3, not a brake.
      // +70 is within its +77 proof deadline, but beyond press+great(+59).
      expect(r.placement).toBe("proper-pass");expect(r.relation).toBe("after-pass");
      expect(r.spatialCandidates).toEqual([]);expect(r.continuingFlow?.basis).toBe("sampled-departure");
      expect(r.continuingFlow?.endTimeMs).toBe(1070);
    }
  });
  it.each(["brake","reversal","turn","context","fresh","source-gap","unknown","fence","late-witness","terminal","dwell"] as const)(
    "keeps the post-near continuation bounded by actual %s evidence",boundary=>{
      const points:Point[]=[[-90,3,-3],[-80,3,-2],[-60,2,-1],[-30,.5,-.2],[0,0,0],
        [20,.7,-.3],[40,1.2,-.5],[55,2.1,-.86],[58,2.22,-.908],[70,2.7,-1.1],[90,3.3,-1.34]];
      if(boundary==="brake")points[8]=[58,2.13,-.872];
      if(boundary==="reversal"){points[9]=[70,1.8,-.74];points[10]=[90,.6,-.2];}
      if(boundary==="turn")points[9]=[70,2.3,-1.5];
      if(boundary==="late-witness")points[9]=[78,2.7,-1.1];
      if(boundary==="terminal")for(let i=4;i<points.length;i++)points[i][0]+=40;
      if(boundary==="dwell"){points[8]=[58,2.1,-.86];points[9]=[74,2.1,-.86];points[10]=[75,2.7,-1.1];}
      for(const profile of ["stable","lazer"] as const){
        const e=evidence(points,6);required(e.geometry).profile=profile;
        if(boundary==="fresh"){e.inputs[9].record.freshActions=[1];e.inputs[9].record.actions=[1];}
        if(boundary==="source-gap")e.inputs[9].record.source={origin:"parsed",parsedFrameIndex:9,discontinuityBefore:["source-gap"]};
        if(boundary==="unknown")e.inputs[9].freshActionsKnown=false;
        if(boundary==="terminal")for(const i of e.inputs)if(i.record.timeMs>=1100)i.postTerminal=true;
        const r=analyzePrimaryApproaches(e,{pressIds:["p6"],
          ...(boundary==="context"?{contextBoundaryInputIds:["p9"]}:{}),
          ...(boundary==="fence"?{inputScopes:{p6:{placementEnd:{timeMs:1069,inclusive:true}}}}:{}),
        }).episodes[0];
        expect(r.continuingFlow?.basis).not.toBe("sampled-departure");expect(r.spatialCandidates.map(c=>c.code)).toContain("misaim");
      }
    });
  it.each([6,7,8])("preserves the whole small outside brake footprint for press %s",press=>{
    const points:Point[]=[[-90,3,-5],[-80,3,-2],[-60,2,-1],[-30,.5,-.2],[0,0,0],
      [20,.7,-.3],[40,1.2,-.5],[50,1.21,-.504],[54,1.215,-.506],[58,1.45,-.6],[90,2.5,-1]];
    for(const profile of ["stable","lazer"] as const){
      const e=evidence(points,press);required(e.geometry).profile=profile;
      const r=analyze(e,press);
      // Positive motion of .0107703R is small, but its immediate speed falls
      // to .04 of the preceding segment. It is not an exact repeated sample.
      expect(r.continuingFlow?.basis).not.toBe("sampled-departure");
      expect(r.spatialCandidates.map(c=>c.code)).toContain("misaim");
    }
  });
  it.each([0,Math.PI/2,Math.PI,3*Math.PI/2])("does not import an old turn into outward flow at rotation %s",angle=>{
    for(const profile of ["stable","lazer"] as const){
      const points=outwardFlowPoints().map(([t,x,y=0])=>
        [t,x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)] as Point);
      const e=evidence(points,6);required(e.geometry).profile=profile;
      const r=analyze(e,6);
      expect(r.spatialCandidates).toEqual([]);expect(r.placement).toBe("proper-pass");expect(r.relation).toBe("after-pass");
      expect(r.properPass?.exitTimeMs).toBeCloseTo(1028.856802,4);
      expect(r.continuingFlow?.basis).toBe("sampled-departure");
      expect(r.continuingFlow?.eventIds).toContain("p4");expect(r.continuingFlow?.eventIds).toContain("p8");
    }
  });
  it.each(["turn","reversal","dwell","brake","source-gap","unknown-action","unlisted-action","context","fence","terminal"] as const)(
    "retains separate placement when departure is not continuous (%s)",boundary=>{
      for(const profile of ["stable","lazer"] as const){
        const points=outwardFlowPoints();
        if(boundary==="turn"){points[8]=[50,1.3,-1];points[9]=[70,1.4,-1.4];}
        if(boundary==="reversal"){points[8]=[50,1.1,-.4];points[9]=[70,.7,-.2];points[10]=[90,.4,0];}
        if(boundary==="dwell"){points[7]=[52,1.2,-.5];points[8]=[64,1.2,-.5];points[9]=[80,2,-.8];points[10]=[95,2.5,-1];}
        if(boundary==="brake"){points[7]=[42,1.21,-.504];points[8]=[50,1.23,-.512];}
        const e=evidence(points,6);required(e.geometry).profile=profile;
        if(boundary==="source-gap")e.inputs[8].record.source={origin:"parsed",parsedFrameIndex:8,discontinuityBefore:["source-gap"]};
        if(boundary==="unknown-action")e.inputs[8].freshActionsKnown=false;
        if(boundary==="unlisted-action")e.inputs[8].record.freshActions=[1];
        if(boundary==="terminal")required(e.terminal).timeMs=1043;
        const r=analyzePrimaryApproaches(e,{pressIds:["p6"],
          ...(boundary==="context" ? {contextBoundaryInputIds:["p8"]} : {}),
          ...(boundary==="fence" ? {inputScopes:{p6:{placementEnd:{timeMs:1043,inclusive:true}}}} : {}),
        }).episodes[0];
        expect(r.continuingFlow?.basis).not.toBe("sampled-departure");
        // These boundaries remove the next heading which the old descriptor
        // used too. They must not fabricate either a landing or a departure.
        if(["source-gap","context","fence","terminal"].includes(boundary))expect(r.spatialCandidates).toEqual([]);
        else expect(r.spatialCandidates.map(c=>c.code)).toContain("misaim");
      }
    });
});

function scoped(e: CircleEvidence, press: number, placementEnd: EvidenceBoundary) {
  const context = {
    pressIds: [`p${press}`],
    inputScopes: { [`p${press}`]: { placementEnd, eventIds: ["supported-stream-context"] } },
  };
  return analyzePrimaryApproaches(e, context).episodes[0];
}

// Raw coordinate/time excerpt from the independently decoded ANiMA753 case.
// The target is deliberately renamed/retimed; production must not know its identity.
function recordedFlow() {
  const e = evidence(
    [
      [-119, 388.3333, 69.33334],
      [-101, 376.3333, 59],
      [-93, 370.3333, 55],
      [-85, 366, 52.66667],
      [-68, 358.3333, 49.66667],
      [-52, 351.6667, 49],
      [-47, 349, 49],
      [-34, 343.6667, 50],
      [-18, 336.3333, 53],
      [-6, 329.3333, 57],
      [-2, 326, 59],
      [15, 315.6667, 67.33334],
      [33, 306, 76.66666],
      [37, 304, 79],
      [48, 300, 83],
      [65, 295.6667, 86.66666],
      [69, 295, 87],
      [81, 293.3333, 87.66666],
      [82, 293.3333, 87.66666],
      [99, 292.3333, 87.66666],
      [115, 287.6667, 85.33334],
    ],
    13,
  );
  e.geometry = {
    position: { x: 336, y: 52 },
    radius: 36.94314193725586,
    profile: "stable",
    hitWindows: [31, 75, 119, 399],
  };
  e.domains.interaction.end = { timeMs: 1120, inclusive: true };
  e.terminal = { ...required(e.terminal), timeMs: 1121 };
  return e;
}

describe("placement evidence fences for bounded stream episodes", () => {
  it("retains an adjacent context action only as the outside origin of a completed bypass",()=>{
    const e=evidence([[-70,-1.8,1.8],[-60,-1.1,1.8],[-50,-.3,1.8],[-40,.3,1.8],[-30,1.1,1.8],[-20,2,1.8],[-10,2.5,1.8]],5);
    e.inputs[0].record.freshActions=[1];e.inputs[0].record.actions=[1];
    const r=analyze(e,5,["p0"]);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(r.landing?.radialR).toBeCloseTo(1.8,6);
    expect(r.contacts).toEqual([]);
    expect(r.landing?.eventIds).toContain("p0");
    expect(r.landing?.timeMs).toBeGreaterThan(e.inputs[0].record.timeMs);
  });
  it.each(["gap","inside","outward","scope","terminal"])("does not borrow an origin across a %s boundary",kind=>{
    const e=evidence([[-70,-1.8,1.8],[-60,-1.1,1.8],[-50,-.3,1.8],[-40,.3,1.8],[-30,1.1,1.8],[-20,2,1.8],[-10,2.5,1.8]],5);
    e.inputs[0].record.freshActions=[1];e.inputs[0].record.actions=[1];
    if(kind==="gap")e.inputs[1].record.source={origin:"parsed",parsedFrameIndex:1,discontinuityBefore:["gap"]};
    if(kind==="inside" || kind==="outward")e.inputs[0].record.position={x:0,y:kind==="inside" ? .5 : 2};
    if(kind==="terminal")e.terminal={...required(e.terminal),timeMs:979};
    const r=kind==="scope" ? analyzePrimaryApproaches(e,{pressIds:["p5"],contextBoundaryInputIds:["p0"],start:{timeMs:935,inclusive:true}}).episodes[0] : analyze(e,5,["p0"]);
    if(kind==="terminal")expect(r.spatialCandidates).toEqual([]);
    else{
      // The origin remains excluded. A separate complete short lobe inside
      // the clean scope is geometric evidence only until correction-certified.
      expect(r.boundedOutsideLobe?.eventIds).toEqual(["p1","p2","p3","p4","p5","p6"]);
      expect(r.landing?.eventIds).not.toContain("p0");
      expect(r.landing?.radialR).toBeCloseTo(1.8,6);
      expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    }
  });
  it("does not let an origin bracket replace the current approach direction or erase a certified bypass",()=>{
    const e=evidence([[-73,340.3333,161],[-66,309.6667,194.3333],[-49,253.3333,262.6667],[-31,211.6667,323],
      [-16,201.3333,337.3333],[-12,201.3333,337.3333],[-8,201.6667,335.6667],[3,207.6667,320],
      [19,220.6667,280.3333],[34,231.3333,225],[51,235,152],[68,227.3333,74.33334],[83,214.6667,29.33333]],8);
    e.geometry={position:{x:253,y:339},radius:40.97679138183594,profile:"stable",hitWindows:[20,60,100,399]};
    e.inputs[0].record.freshActions=[1];e.inputs[0].record.actions=[1];
    const r=analyze(e,8,["p0"]);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(r.landing?.transverseR).toBeCloseTo(1.0266931684127232,6);
  });
  it("does not use an origin-only segment to certify the heading of an interpolation-only contact",()=>{
    const e=evidence([[-50,-3],[-40,-2],[-10,2],[10,3]],1);
    e.inputs[0].record.freshActions=[1];e.inputs[0].record.actions=[1];
    const r=analyze(e,1,["p0"]);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].minRadialR).toBe(0);
    expect(r.contacts[0].placementSupport).toBe("unproven");
    expect(r.properPass).toBeUndefined();
  });
  it("does not borrow a context origin's duration for a stationary footprint",()=>{
    const e=evidence([[-30,2.04],[-10,2.01],[0,2.025],[5,2.025]],2);
    e.geometry!.hitWindows=[25,70,115,399];
    e.inputs[0].record.freshActions=[1];e.inputs[0].record.actions=[1];
    expect(analyze(e,2,["p0"]).spatialCandidates).toEqual([]);
  });
  const lateralFlow=()=>evidence([...Array.from({length:7},(_,i)=>[30+i*10,.03*(i*10-60),1.8] as Point),[99,.27,1.8]],6);
  it("does not discard cumulative fine-sampled orthogonal travel as lateral-corridor noise",()=>{
    const points:Point[]=[[-150,-2.6,2],[-100,-1.6,2],[-50,-.6,2],[0,.4,2],
      ...Array.from({length:45},(_,i)=>[i+1,.4,2-.02*(i+1)] as Point)];
    const r=analyze(evidence(points,43),43);
    expect(r).not.toHaveProperty("lateralTraversal");
  });
  it("certifies an observed moving lateral traversal without requiring a halt or radial departure at expiry",()=>{
    const e=lateralFlow(),r=analyze(e,6);
    expect(r.contacts).toEqual([]);
    expect(r.reconstructedMinimumRadius).toBeCloseTo(1.8,6);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(r).toHaveProperty("lateralTraversal");
    expect(r.landing?.turnRadians).toBe(0);
    expect(r.landing?.footprintDurationMs).toBe(0);
    expect(r.landing?.alongR).toBeNull();
    expect(r.landing?.transverseR).toBeNull();
    expect(r.timingIndependent).toBe(false);
  });
  it("links a lateral traversal's context-only progress origin without borrowing its axis",()=>{
    const e=evidence([[-10,-.65,1.8],[30,-.27,1.8],[40,-.225,1.8],[50,-.18,1.8],[60,-.135,1.8],
      [70,-.09,1.8],[80,-.045,1.8],[90,0,1.8],[99,.27,1.8]],7);
    // Own progress <.5R; a legal origin can establish progress, but never heading.
    e.inputs[0].record.position.x=-1.5;e.inputs[0].record.position.y=1.8;
    e.inputs[0].record.freshActions=[1];e.inputs[0].record.actions=[1];
    const r=analyze(e,7,["p0"]);
    expect(r).toHaveProperty("lateralTraversal");
    expect(r.landing?.eventIds).toContain("p0");
  });
  it.each(["before-plane","gap","repair","context","origin-only","instant-change"])("does not invent a lateral traversal across %s",fault=>{
    const e=lateralFlow();
    if(fault==="gap")e.inputs[3].record.source={origin:"parsed",parsedFrameIndex:3,discontinuityBefore:["gap"]};
    if(fault==="repair")for(const i of e.inputs){i.record.position.y=.9;i.inside=Math.hypot(i.record.position.x,.9)<=1;}
    if(fault==="origin-only"){for(const i of e.inputs.slice(1)){i.record.position.x=0;i.record.position.y=1.8;}e.inputs[0].record.freshActions=[1];}
    if(fault==="instant-change")e.inputs[3].record.timeMs=e.inputs[2].record.timeMs;
    const context=fault==="context" ? ["p4"] : fault==="origin-only" ? ["p0"] : [];
    const r=fault==="before-plane" ? scoped(e,6,{timeMs:1080,inclusive:true}) : analyze(e,6,context);
    expect(r).not.toHaveProperty("lateralTraversal");
  });
  it("finds the completed press lobe despite an unrelated earlier closer departure",()=>{
    const points:Point[]=[[-100,-1.2],[-80,-4],[-60,-3.5],[-20,-2.5],[20,-2],[60,-3],[90,-4]];
    const e=evidence(points,2),r=analyze(e,2);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Undershoot"]);
    expect(r.landing?.eventIds).not.toContain("p0");
    expect(r.landing?.radialR).toBe(2);
    expect(labels(evidence(points.slice(0,5),2),2)).toEqual([]);
    expect(labels(evidence(points.map((p,i)=>i===4 ? [p[0],0] : p),2),2)).toEqual([]);
    expect(analyze(e,2,["p5"]).spatialCandidates).toEqual([]);
    e.inputs[5].record.source={origin:"parsed",parsedFrameIndex:8};
    expect(analyze(e,2).spatialCandidates).toEqual([]);
  });
  it.each(["stable", "lazer"] as const)("retains a %s live-boundary entry from adjacent pre-resolution source",profile=>{
    const e=evidence([[-20,-3],[80,-2],[98,-1.1],[110,-.5]],1);
    e.geometry={...required(e.geometry),profile,hitWindows:[23,65,107,399]};
    e.domains.liveSuccess={state:"nonempty",start:{timeMs:893,inclusive:true},end:{timeMs:1107,inclusive:true}};
    e.domains.interaction.end={timeMs:1108,inclusive:true};e.terminal={...required(e.terminal),timeMs:1110};
    const r=analyze(e,1);
    expect(r.placement).toBe("proper-pass");
    expect(r.properPass).toMatchObject({placementSupport:"reconstructed-boundary",
      exitTimeMs:1107,rightCensored:true,sampledEventIds:[],sampledMinimumRadius:null,deepSampled:false});
    expect(r.sampledMinimumRadius).toBeGreaterThan(1);
    expect(r.properPass?.entryTimeMs).toBeCloseTo(1100);
    expect(r.properPass?.minRadialR).toBeCloseTo(.65);
    expect(r.properPass?.eventIds).toEqual(expect.arrayContaining(["p1","p2","p3"]));
    expect(r.spatialCandidates).toEqual([]);
    const copy=()=>JSON.parse(JSON.stringify(e)) as CircleEvidence;
    const late=copy();late.inputs[3].record.position.x=-1.05;
    expect(analyze(late,1).placement).toBe("unproven");
    const gap=copy();gap.inputs[3].record.source={origin:"parsed",parsedFrameIndex:4};
    expect(analyze(gap,1).placement).toBe("unproven");
    const terminal=copy();terminal.terminal={...required(terminal.terminal),sequence:4};
    expect(analyze(terminal,1).placement).toBe("unproven");
    const action=copy();action.inputs[3].record.freshActions=[1];
    expect(analyze(action,1).placement).toBe("unproven");
    expect(analyze(e,1,["p3"]).placement).toBe("unproven");
    expect(analyzePrimaryApproaches(e,{pressIds:["p1"],end:{timeMs:1108,inclusive:true}}).episodes[0].placement).toBe("unproven");
  });
  it("clips a shallow live-boundary entry without borrowing the deeper raw endpoint",()=>{
    const e=evidence([[60,-2.125],[76,-1.625],[92,-1.125],[104,-.875]],1);
    e.domains.liveSuccess={state:"nonempty",start:{timeMs:901,inclusive:true},end:{timeMs:1099,inclusive:true}};
    e.domains.interaction.end={timeMs:1100,inclusive:true};e.terminal={...required(e.terminal),timeMs:1105};
    const r=analyze(e,1);expect(r.properPass).toBeUndefined();
    expect(r.contacts[0]?.entryTimeMs).toBe(1098);
    expect(r.contacts[0]?.exitTimeMs).toBe(1099);
    expect(r.contacts[0]?.minRadialR).toBeCloseTo(47/48);
    expect(r.sampledMinimumRadius).toBe(1.125);
    expect(r.closest?.provenance).toBe("reconstructed");
    expect(r.contacts[0]?.sampledEventIds).toEqual([]);
    const copy=()=>JSON.parse(JSON.stringify(e)) as CircleEvidence;
    const after=copy();after.inputs[3].record.position.x=-.9375;
    expect(analyze(after,1).contacts.some(c=>c.placementSupport!=="unproven")).toBe(false);
    const empty=copy();empty.domains.liveSuccess.end={timeMs:1098,inclusive:true};
    expect(analyze(empty,1).contacts.some(c=>c.placementSupport!=="unproven")).toBe(false);
    const discontinuity=copy();discontinuity.inputs[3].record.source={origin:"parsed",parsedFrameIndex:3,discontinuityBefore:["parser-negative-delta"]};
    expect(analyze(discontinuity,1).contacts.some(c=>c.placementSupport!=="unproven")).toBe(false);
    const synthetic=copy();synthetic.inputs[3].record.source={origin:"synthetic",reason:"test"};
    expect(analyze(synthetic,1).contacts.some(c=>c.placementSupport!=="unproven")).toBe(false);
    const turn=copy();turn.inputs[1].record.position={x:-1.125,y:1};
    expect(analyze(turn,1).contacts.some(c=>c.placementSupport!=="unproven")).toBe(false);
  });
  it.each([0, Math.PI / 3, Math.PI / 2, Math.PI])("recognizes a completed curved bypass independently of the fastest historical heading: %s", angle => {
    const points: Point[] = [[-60,2.5,2.7],[-50,1.4,2.7],[0,-1.17,.73],[40,-1.5,.86]];
    const rotated = points.map(([t,x,y=0]): Point => [t,x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)]);
    const e=evidence(rotated,2), r=analyze(e,2);
    // Analytic minimum of the inward chord is 1.291157975R at -7.4805918ms.
    // The following recorded point is farther away; neither chord enters the circle.
    expect(r.reconstructedMinimumRadius).toBeCloseTo(1.291157975);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(r.landing?.eventIds).toEqual(["p0","p1","p2","p3"]);
    const repaired=evidence(rotated.map((p,i)=>i===2 ? [p[0],0,0] : p),2);
    expect(analyze(repaired,2).placement).toBe("proper-pass");
    expect(analyze(repaired,2).spatialCandidates).toEqual([]);
    expect(labels(evidence(rotated.slice(0,3),2),2)).toEqual([]);
    expect(analyze(e,2,["p3"]).spatialCandidates).toEqual([]);
    e.inputs[3].record.source={origin:"parsed",parsedFrameIndex:4};
    expect(analyze(e,2).spatialCandidates).toEqual([]);
  });
  it.each([
    [[-250,9,-3],[-230,9,-1],[0,2,1.05],[18,.5,.5]],
    [[-250,9,1.3],[-230,7,1.3],[0,2,.5],[18,.5,.2]],
  ] as Point[][])("does not call a slow multi-radius inbound segment a settled footprint: %j",(...points)=>{
    const r=analyze(evidence(points,2),2);
    expect(r.placement).toBe("proper-pass");
    expect(r.relation).toBe("before-pass");
    expect(r.spatialCandidates).toEqual([]);
  });
  it("retains the connected inward precursor of an established slow outside footprint",()=>{
    const e=evidence([[-250,-6,1.3],[-210,-3,1.3],[-170,-.2,1.3],[-130,0,1.3],[-90,.08,1.28],[-50,.16,1.26],[-10,.24,1.24],[0,.26,1.235],[20,.30,1.225],[40,.34,1.215],[80,.42,1.195]],7);
    expect(labels(e,7)).toEqual(["Misaim"]);
    expect(analyze(e,7,["p3"]).spatialCandidates).toEqual([]);
    expect(analyzePrimaryApproaches(e,{pressIds:["p7"],inputScopes:{p7:{start:{timeMs:870,inclusive:true}}}}).episodes[0].spatialCandidates).toEqual([]);
  });
  it("shares an adjacent allowed contact bracket across presses with different horizons",()=>{
    const e=evidence([[-50,-3],[-15,-2],[80,-1.2],[97,-1.1],[108,-.6]],1);
    e.geometry={...required(e.geometry),hitWindows:[23,65,107,399]};
    e.domains.interaction.end={timeMs:1108,inclusive:true};e.terminal={...required(e.terminal),timeMs:1110};
    e.inputs[3].record.freshActions=[1];
    const result=analyzePrimaryApproaches(e,{pressIds:["p1","p3"]});
    for(const r of result.episodes){expect(r.placement).toBe("proper-pass");expect(r.properPass?.entryTimeMs).toBeCloseTo(1099.2);}
    e.inputs[4].record.timeMs=1109;
    expect(analyze(e,1).placement).toBe("unproven");
  });
  it("recognizes a sustained post-press stationary footprint without inventing an approach direction",()=>{
    const e=evidence([[-40,2,1.3],[0,2.05,1.3],[10,2.05,1.3],[20,2.05,1.3],[40,2.05,1.3]],1);
    const r=analyze(e,1);expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
    expect(r.landing?.alongR).toBeNull();expect(r.timingIndependent).toBe(false);
    expect(scoped(e,1,{timeMs:1005,inclusive:true}).spatialCandidates).toEqual([]);
    const through=evidence([[-40,2,1.3],[0,2.05,1.3],[4,2.05,1.3],[20,0,0]],1);
    expect(analyze(through,1).placement).toBe("proper-pass");
    expect(labels(through,1)).toEqual([]);
  });
  const reversal: Point[] = [[-70,-6],[-40,-5],[-17,-3.2],[-7,-2],[-1,-2],[15,-1.45],[32,-1.39],[50,-1.38],[66,-1.9],[85,-3.2]];
  const retreat: Point[] = [[-90,-4,.5],[-74,-2.4,-.14],[-58,-1.2,-.62],[-50,-.9,-.74],[-44,-.85,-.78],[-25,-.88,-.82],[-9,-1.01,-.83],[-2,-1.06,-.83],[6,-1.1,-.83],[22,-1.2,-.84]];
  it.each(["stable", "lazer"] as const)("recognizes a completed %s near-side reversal containing the press", profile => {
    const e = evidence(reversal,3); e.geometry = {...required(e.geometry),profile};
    const r = analyze(e,3);
    expect(r.contacts).toEqual([]);
    expect(r.reconstructedMinimumRadius).toBeCloseTo(1.38);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Undershoot"]);
    expect(r.spatialCandidates[0].eventIds).toEqual(expect.arrayContaining(["p0","p3","p7","p8"]));
  });
  it("recognizes a completed outside retreat without inventing a precise axis diagnosis", () => {
    const r = analyze(evidence(retreat,7),7);
    expect(r.contacts).toEqual([]);
    expect(r.reconstructedMinimumRadius).toBeCloseTo(1.15364639);
    expect(r.spatialCandidates.map(c=>c.label)).toEqual(["Misaim"]);
  });
  it("requires observed departure, not an unfinished or noisy minimum", () => {
    expect(labels(evidence(reversal.slice(0,8),3),3)).toEqual([]);
    expect(labels(evidence([...reversal.slice(0,8),[66,-1.39],[85,-1.40]],3),3)).toEqual([]);
    const through = analyze(evidence([...reversal.slice(0,7),[50,-1.2],[66,-.5],[85,.5]],3),3);
    expect(through.placement).toBe("proper-pass");
    expect(through.spatialCandidates).toEqual([]);
  });
  it.each(["scope","terminal","context","gap","synthetic","unassigned-action"])("does not borrow a departure across a %s boundary", boundary => {
    const e = evidence(reversal,3);
    if(boundary === "scope") { expect(scoped(e,3,{timeMs:1050,inclusive:true}).spatialCandidates).toEqual([]); return; }
    if(boundary === "terminal") e.terminal = {...required(e.terminal),timeMs:1051};
    if(boundary === "gap") e.inputs[8].record.source = {origin:"parsed",parsedFrameIndex:8,discontinuityBefore:["source-gap"]};
    if(boundary === "synthetic") e.inputs[8].record.source = {origin:"synthetic",reason:"test"};
    if(boundary === "unassigned-action") e.inputs[8].record.freshActions = [1];
    expect(analyze(e,3,boundary === "context" ? ["p8"] : []).spatialCandidates).toEqual([]);
  });
  it.each([0,Math.PI/2,Math.PI/5])("preserves completed-lobe rotation/translation/scale at %s",angle=>{
    const e=evidence(reversal,3);
    e.geometry={...required(e.geometry),profile:"lazer",position:{x:100,y:200},radius:32};
    for(const i of e.inputs){const {x,y}=i.record.position;i.record.position={x:100+32*(x*Math.cos(angle)-y*Math.sin(angle)),y:200+32*(x*Math.sin(angle)+y*Math.cos(angle))};}
    expect(labels(e,3)).toEqual(["Undershoot"]);
  });
  it.each(["stable", "lazer"] as const)("retains the whole continuous inward approach before a %s lateral bypass", (profile) => {
    // A late two-ms speed peak does not erase the preceding 1.95R approach.
    // Every sampled point and the whole horizontal path remain outside y=1.05R.
    const e = evidence([
      [-60, -3, 1.05], [-30, -1, 1.05], [-12, -0.9, 1.05],
      [-10, -0.15, 1.05], [0, 0, 1.05], [13, 0.6, 1.05], [30, 1.5, 1.05],
    ], 5);
    e.geometry = { ...required(e.geometry), profile };
    const result = analyze(e, 5);
    expect(result.contacts).toEqual([]);
    expect(result.reconstructedMinimumRadius).toBeCloseTo(1.05);
    expect(result.placement).toBe("misplaced");
    expect(result.spatialCandidates.map(c => c.label)).toEqual(["Misaim"]);
    expect(result.spatialCandidates[0].eventIds).toContain("p0");
    // A fence before the speed change removes both the brake and the bypass.
    expect(scoped(e, 5, { timeMs: 970, inclusive: true }).spatialCandidates).toEqual([]);
  });

  it.each(["stable", "lazer"] as const)("keeps %s coherent crossings across key-only duplicate positions", profile => {
    const e = evidence([[-30, -3], [-20, -1.5], [-19, -1.5], [0, 1.5], [2, 1.5], [20, 3]], 3);
    e.geometry = { ...required(e.geometry), profile };
    const result = analyze(e, 3);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].sampledEventIds).toEqual([]);
    expect(result.contacts[0].minRadialR).toBeCloseTo(0);
    expect(result.contacts[0].placementSupport).toBe("reconstructed-coherent");
    expect(result.placement).toBe("proper-pass");
    expect(result.spatialCandidates).toEqual([]);
  });

  it.each(["stable", "lazer"] as const)("does not treat one short repeated sample as a %s landing", (profile) => {
    // Same inbound speed before/after a four-ms duplicate: no brake or reversal.
    // The expected pass comes directly from the coordinates, not a diagnosis label.
    for (const press of [2, 3]) {
      const e = evidence(
        [
          [-40, -5],
          [-20, -3],
          [0, -1.4],
          [4, -1.4],
          [20, -0.12],
          [36, 1.16],
        ],
        press,
      );
      e.geometry = { ...required(e.geometry), profile };
      const result = analyze(e, press);
      expect(result.spatialCandidates).toEqual([]);
      expect(result.placement).toBe("proper-pass");
      expect(result.relation).toBe("before-pass");
    }
  });
  it("does not turn a short duplicate in continuing departure into overshoot", () => {
    const e = evidence(
      [
        [-40, -3],
        [-20, -1],
        [0, 1.4],
        [4, 1.4],
        [20, 3.32],
        [36, 5.24],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual([]);
    expect(analyze(e, 2).relation).toBe("after-pass");
  });
  it("retains the real flow pass while excluding the following receptor's later slowdown", () => {
    const e = recordedFlow(),
      result = scoped(e, 13, { timeMs: 1037, sequence: 14, inclusive: true });
    expect(result.spatialCandidates).toEqual([]);
    expect(result.placement).toBe("proper-pass");
    expect(result.relation).toBe("after-pass");
    expect(required(result.properPass).exitTimeMs).toBeCloseTo(1030.45226419263, 8);
    expect(required(result.properPass).minRadialR).toBeCloseTo(0.028469433911066926, 12);
    expect(result.eventIds).toContain("p15"); // Context remains visible; it cannot supply placement.
  });
  it("does not silently change default jump behavior without positive context", () => {
    expect(analyze(recordedFlow(), 13).spatialCandidates.map((c) => c.label)).toEqual(["Misaim"]);
  });
  it("a placement fence before the late press retains its eligibility and the contact exit bracket", () => {
    const e = recordedFlow(),
      result = scoped(e, 13, { timeMs: 1015, sequence: 12, inclusive: true });
    expect(result.status).toBe("supported");
    expect(result.pressOffsetMs).toBe(37);
    expect(required(result.properPass).eventIds).toContain("p12");
    expect(required(result.properPass).exitTimeMs).toBeCloseTo(1030.45226419263, 8);
  });
  it.each([1, 2.5])("keeps curved and spaced flow at time scale %s without demanding a stop", (scale) => {
    const e = recordedFlow();
    for (const item of e.inputs) item.record.timeMs = 1000 + (item.record.timeMs - 1000) * scale;
    e.geometry = { ...required(e.geometry), hitWindows: required(e.geometry).hitWindows.map((x) => x * scale) };
    e.domains.interaction.end = { timeMs: 1000 + 120 * scale, inclusive: true };
    e.terminal = { ...required(e.terminal), timeMs: 1000 + 121 * scale };
    const result = scoped(e, 13, { timeMs: 1000 + 37 * scale, inclusive: true });
    expect(result.placement).toBe("proper-pass");
    expect(result.spatialCandidates).toEqual([]);
  });
  it("preserves a genuine lateral landing before the fence and later corrective contact", () => {
    const e = evidence(
      [
        [-80, -6, 1.3],
        [-60, -4, 1.3],
        [-40, -2, 1.3],
        [-20, -0.2, 1.3],
        [-5, 0, 1.25],
        [5, 0, 1.2],
        [20, 0, 0.5],
        [40, 0, 0],
      ],
      4,
    );
    const result = scoped(e, 4, { timeMs: 1005, inclusive: true });
    expect(result.spatialCandidates.map((c) => c.label)).toEqual(["Misaim"]);
    expect(result.contacts.some((c) => c.relation === "later-correction")).toBe(true);
    expect(
      result.spatialCandidates[0].eventIds.every(
        (id) => required(e.inputs.find((i) => i.record.id === id)).record.timeMs <= 1005,
      ),
    ).toBe(true);
  });
  it("does not confirm an undershoot using a reversal beyond the placement fence", () => {
    const e = evidence(
      [
        [-60, -4],
        [-30, -2],
        [-10, -1.5],
        [0, -1.3],
        [10, -1.15],
        [20, -1.2],
        [40, -1.5],
      ],
      3,
    );
    const result = scoped(e, 3, { timeMs: 1000, inclusive: true });
    expect(result.spatialCandidates).toEqual([]);
  });
  it("does not confirm a stationary outside footprint using post-fence samples", () => {
    const e = evidence(
      [
        [-40, 1.2],
        [-20, 1.2],
        [0, 1.2],
        [20, 1.2],
      ],
      2,
    );
    expect(scoped(e, 2, { timeMs: 1000, inclusive: true }).spatialCandidates).toEqual([]);
  });
  it("does not confirm a completed bypass with a post-fence departure", () => {
    const e = evidence(
      [
        [-60, -4, 1.2],
        [-40, -2, 1.2],
        [-20, 0, 1.2],
        [0, 2, 1.2],
        [20, 4, 1.2],
      ],
      2,
    );
    expect(scoped(e, 2, { timeMs: 980, inclusive: true }).spatialCandidates).toEqual([]);
  });
  it("keeps per-input episode bounds separate and refuses a press outside its own scope", () => {
    const e = recordedFlow();
    const context = {
      pressIds: ["p6", "p13"],
      inputScopes: {
        p6: { end: { timeMs: 940, inclusive: true } },
        p13: { start: { timeMs: 950, inclusive: true }, placementEnd: { timeMs: 1037, inclusive: true } },
      },
    };
    const result = analyzePrimaryApproaches(e, context);
    expect(result.episodes[0].status).toBe("unavailable");
    expect(result.episodes[1].placement).toBe("proper-pass");
    expect(result.episodes[1].eventIds).not.toContain("p5");
  });
  it("fails closed for an invalid placement boundary", () => {
    expect(scoped(recordedFlow(), 13, { timeMs: NaN, inclusive: true }).status).toBe("unavailable");
  });
  it("does not use a slow segment crossing the fence as an interpolated landing", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, -1.25],
        [-10, -1.2],
        [0, -1.2],
        [20, -1.6],
      ],
      3,
    );
    // -20 to -10 would be the first confirmed brake. The fence cuts that segment.
    const result = scoped(e, 3, { timeMs: 985, inclusive: true });
    expect(result.spatialCandidates).toEqual([]);
    expect(result.status).toBe("supported");
  });
  it("uses sequence at a same-time fence rather than admitting a later position", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, -1.25],
        [-10, -1.2],
        [0, -1.2],
        [20, -1.6],
      ],
      3,
    );
    expect(scoped(e, 3, { timeMs: 990, sequence: 3, inclusive: true }).spatialCandidates).toEqual([]);
    expect(scoped(e, 3, { timeMs: 990, sequence: 4, inclusive: true }).spatialCandidates.map((c) => c.label)).toEqual([
      "Undershoot",
    ]);
  });
  it("preserves a completed true overshoot within the allowed placement span", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, 0],
        [-5, 1.3],
        [5, 1.35],
        [10, 1.35],
        [20, 1.2],
      ],
      4,
    );
    const result = scoped(e, 4, { timeMs: 1010, inclusive: true });
    expect(result.spatialCandidates.map((c) => c.label)).toEqual(["Overshoot"]);
    expect(
      required(result.landing).eventIds.every(
        (id) => required(e.inputs.find((i) => i.record.id === id)).record.timeMs <= 1010,
      ),
    ).toBe(true);
  });
  it("retains curved off-centre valid flow in a spaced stream", () => {
    const e = evidence(
      [
        [-80, -4, 1],
        [-40, -2, 0.6],
        [-20, -1, 0.3],
        [0, 0, 0.2],
        [20, 1, 0.3],
        [40, 2, 0.6],
        [55, 2.1, 0.65],
        [70, 2.1, 0.65],
      ],
      5,
    );
    const result = scoped(e, 5, { timeMs: 1040, inclusive: true });
    expect(result.spatialCandidates).toEqual([]);
    expect(result.placement).toBe("proper-pass");
    expect(result.relation).toBe("after-pass");
    expect(required(result.properPass).sampledEventIds).toContain("p3");
  });
  it("copies the scope provenance without mutating input or sharing nested references", () => {
    const e = recordedFlow(),
      context = {
        pressIds: ["p13"],
        inputScopes: { p13: { placementEnd: { timeMs: 1037, inclusive: true }, eventIds: ["rhythm-anchor"] } },
      };
    const before = JSON.stringify({ e, context }),
      result = analyzePrimaryApproaches(e, context).episodes[0];
    expect(JSON.stringify({ e, context })).toBe(before);
    expect(result.inputScope).toEqual(context.inputScopes.p13);
    expect(result.inputScope).not.toBe(context.inputScopes.p13);
    expect(required(result.inputScope).placementEnd).not.toBe(context.inputScopes.p13.placementEnd);
    expect(required(result.inputScope).eventIds).not.toBe(context.inputScopes.p13.eventIds);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it("does not let scope metadata bypass the bounded witness count", () => {
    const e = recordedFlow(),
      context = {
        pressIds: ["p13"],
        inputScopes: { p13: { eventIds: Array.from({ length: 4097 }, (_, i) => String(i)) } },
      };
    expect(analyzePrimaryApproaches(e, context).episodes[0].status).toBe("unavailable");
  });
});

describe("primary approach geometry, independent analytic controls", () => {
  it("is RED until the descriptor module exists", () => {
    expect(typeof analyzePrimaryApproaches).toBe("function");
  });
  it("recognizes a near-side braked landing without a 20 ms stop", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, -1.25],
        [-10, -1.2],
        [-5, -1.2],
        [10, -1.4],
      ],
      3,
    );
    expect(labels(e, 3)).toEqual(["Undershoot"]);
    expect(required(analyze(e, 3).landing).footprintDurationMs).toBeLessThan(20);
    expect(required(analyze(e, 3).landing).radialR).toBeGreaterThan(1);
  });
  it("recognizes a far-side braked landing after a sampled crossing", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, 0],
        [-5, 1.3],
        [5, 1.35],
        [10, 1.35],
        [20, 1.2],
      ],
      4,
    );
    expect(labels(e, 4)).toEqual(["Overshoot"]);
  });
  it("does not call continuing normal departure an overshoot", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, 0],
        [0, 2],
        [20, 4],
      ],
      3,
    );
    expect(labels(e, 3)).toEqual([]);
    expect(analyze(e, 3).placement).toBe("proper-pass");
    expect(analyze(e, 3).relation).toBe("after-pass");
  });
  it("does not use a previous fast correction to call constant-speed crossing and departure an overshoot",()=>{
    const e=evidence([[-30,-7],[-24,0],[-16,.2],[-8,.4],[0,.6],[8,.8],[16,1],[24,1.2],[32,1.4],[40,1.6]],8);
    const r=analyze(e,8);
    expect(r.spatialCandidates).toEqual([]);
    expect(r.placement).toBe("proper-pass");
    expect(r.relation).toBe("after-pass");
  });
  it("does not call an ongoing incoming approach undershoot", () => {
    const e = evidence(
      [
        [-60, -5],
        [-40, -3],
        [-20, -1.3],
        [0, 0],
        [20, 1.3],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual([]);
    expect(analyze(e, 2).relation).toBe("before-pass");
  });
  it("does not convert normal inward braking before valid arrival into undershoot", () => {
    const e = evidence(
      [
        [-80, -4],
        [-40, -1.6],
        [-20, -1.2],
        [0, 0],
        [20, 1.2],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual([]);
    expect(analyze(e, 2).properPass).toBeDefined();
  });
  it("retains one observed lateral placement across two nearby taps during the same curved correction", () => {
    const e = evidence(
      [
        [-60, -4, 1.3],
        [-40, -2, 1.3],
        [-20, -0.2, 1.3],
        [-5, 0, 1.25],
        [1, 0.1, 1.1],
        [3, 0.22, 1.03],
        [20, 1, 1.2],
      ],
      3,
    );
    const r = analyzePrimaryApproaches(e, { pressIds: ["p3", "p5"] });
    expect(r.episodes.map((x) => x.spatialCandidates.map((c) => c.label))).toEqual([["Misaim"], ["Misaim"]]);
    expect(required(r.episodes[0].landing).timeMs).toBe(required(r.episodes[1].landing).timeMs);
  });
  it("accepts deep flow without a stop or dwell", () => {
    const e = evidence(
      [
        [-40, -4],
        [-20, -2],
        [0, 0],
        [10, 1],
        [20, 2],
      ],
      4,
    );
    expect(required(analyze(e, 4).properPass).closestOffsetMs).toBe(0);
    expect(analyze(e, 4).timingIndependent).toBe(true);
  });
  it("retains shallow sampled contact without treating it as attribution coverage", () => {
    const e = evidence(
      [
        [-40, -4, 0.98],
        [-20, -2, 0.98],
        [0, 0, 0.98],
        [20, 2, 0.98],
        [40, 4, 0.98],
      ],
      3,
    );
    expect(labels(e, 3)).toEqual([]);
    expect(analyze(e, 3).properPass).toBeUndefined();
    expect(required(analyze(e, 3).contacts[0]).deepSampled).toBe(false);
    expect(required(analyze(e, 3).contacts[0]).sampledMinimumRadius).toBeCloseTo(0.98);
  });
  it("keeps proper on-time arrival after a 50 ms early press", () => {
    const e = evidence(
      [
        [-60, -1.65],
        [-50, -1.5],
        [-20, -1.5],
        [0, 0],
        [80, 0],
      ],
      1,
    );
    expect(labels(e, 1)).toEqual([]);
    expect(required(analyze(e, 1).properPass).closestOffsetMs).toBe(0);
    expect(analyze(e, 1).relation).toBe("before-pass");
  });
  it("reports late arrival without inventing an outside landing", () => {
    const e = evidence(
      [
        [-10, -1.4],
        [1, -1.1],
        [10, -0.5],
        [20, 0],
        [80, 0],
      ],
      1,
    );
    expect(labels(e, 1)).toEqual([]);
    expect(required(analyze(e, 1).properPass).entryTimeMs).toBeGreaterThan(1001);
  });
  it("recognizes lateral braked placement followed by a correction", () => {
    const e = evidence(
      [
        [-80, -6, 1.3],
        [-60, -4, 1.3],
        [-40, -2, 1.3],
        [-20, -0.2, 1.3],
        [-5, 0, 1.25],
        [5, 0, 1.2],
        [20, 0, 0.5],
        [40, 0, 0],
      ],
      4,
    );
    expect(labels(e, 4)).toEqual(["Misaim"]);
    expect(analyze(e, 4).placement).toBe("misplaced");
    expect(analyze(e, 4).properPass).toBeUndefined();
    expect(analyze(e, 4).contacts.some((x) => x.relation === "later-correction")).toBe(true);
  });
  it("does not substitute a shallow interpolation-only graze for proper landing", () => {
    const e = evidence(
      [
        [-40, -4, 1.2],
        [-20, -2, 1.2],
        [0, -0.15, 0.99],
        [10, 0.15, 0.99],
        [20, 2, 1.2],
      ],
      2,
    );
    // Chord reaches .99R, only .01R penetration: inadequate proper placement.
    expect(analyze(e, 2).properPass).toBeUndefined();
    expect(analyze(e, 2).sampledMinimumRadius).toBeGreaterThan(0.99);
  });
  it("keeps a reconstructed deep crossing separate from sampled penetration", () => {
    const e = evidence(
      [
        [-40, -4],
        [-20, -2],
        [20, 2],
        [40, 4],
      ],
      2,
    );
    expect(required(analyze(e, 2).properPass).placementSupport).toBe("reconstructed-coherent");
    expect(required(analyze(e, 2).properPass).deepSampled).toBe(false);
    expect(analyze(e, 2).reconstructedMinimumRadius).toBe(0);
    expect(analyze(e, 2).sampledMinimumRadius).toBe(2);
    expect(analyze(e, 2).contacts[0].sampledMinimumRadius).toBeNull();
    expect(JSON.parse(JSON.stringify(analyze(e, 2)))).toEqual(analyze(e, 2));
  });
  it("does not treat a lone crossing chord as a corroborated flowing landing", () => {
    const e = evidence(
      [
        [-20, -2],
        [20, 2],
      ],
      1,
    );
    expect(analyze(e, 1).properPass).toBeUndefined();
  });
  it("does not treat shallow reconstructed flow as a proper landing", () => {
    const e = evidence(
      [
        [-40, -4, 0.99],
        [-20, -2, 0.99],
        [20, 2, 0.99],
        [40, 4, 0.99],
      ],
      2,
    );
    expect(analyze(e, 2).properPass).toBeUndefined();
  });
  it("does not hide an abrupt correction behind a deep crossing chord", () => {
    const e = evidence(
      [
        [-40, -2, -2],
        [-20, -2],
        [20, 2],
        [40, 2, 2],
      ],
      2,
    );
    expect(analyze(e, 2).properPass).toBeUndefined();
  });
  it("does not bridge a source gap to infer a crossing or landing", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, 0],
        [-5, 1.3],
        [5, 1.35],
        [10, 1.35],
      ],
      4,
    );
    e.inputs[3].record.source = { origin: "parsed", parsedFrameIndex: 20, discontinuityBefore: ["test-gap"] };
    expect(labels(e, 4)).toEqual([]);
  });
  it("does not bridge a zero-time position jump", () => {
    const e = evidence(
      [
        [-40, -4],
        [-20, -2],
        [-20, 2],
        [0, 2.1],
        [10, 2.1],
      ],
      3,
    );
    expect(labels(e, 3)).toEqual([]);
    expect(analyze(e, 3).contacts).toEqual([]);
  });
  it("retains an ordered small outside update but never creates its missing time interval", () => {
    const e = evidence(
      [
        [-60, -3],
        [-40, -2],
        [-30, -1.2],
        [-20, -1.05],
        [-20, -1.03],
        [-10, -0.8],
        [0, 0],
        [20, 1.5],
      ],
      2,
    );
    const result = analyze(e, 2);
    expect(required(result.properPass).entryTimeMs).toBeGreaterThan(980);
    expect(result.limitations).toContain("ordered-zero-time-position-change");
    expect(result.contacts.every((c) => c.entryTimeMs > 980)).toBe(true);
  });
  it("excludes post-terminal position and same-time later input by sequence", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, 0],
        [-5, 1.3],
        [5, 1.35],
        [10, 0.5],
      ],
      4,
    );
    e.terminal = { ...required(e.terminal), timeMs: 1005, sequence: 4 };
    expect(analyze(e, 4).status).toBe("unavailable");
  });
  it("enforces the interaction end even when the terminal record is later", () => {
    const e = evidence(
      [
        [-40, -3],
        [-20, -2],
        [0, -1.2],
        [20, -1.2],
      ],
      2,
    );
    e.domains.interaction.end = { timeMs: 990, inclusive: false };
    expect(analyze(e, 2).status).toBe("unavailable");
  });
  it("cannot assign an approach when the live interaction boundary is unknown", () => {
    const e = evidence(
      [
        [-40, -3],
        [-20, -2],
        [0, -1.2],
        [20, -1.2],
      ],
      2,
    );
    e.domains.interaction.state = "unknown";
    expect(analyze(e, 2).status).toBe("unavailable");
  });
  it("a successfully assigned neighbouring input bounds correction evidence", () => {
    const e = evidence(
      [
        [-40, -3],
        [-20, -2],
        [0, -1.5],
        [10, -1.3],
        [20, 0],
      ],
      2,
    );
    expect(analyze(e, 2, ["p3"]).properPass).toBeUndefined();
  });
  it("does not use a prior pass across an assigned neighbouring action", () => {
    const e = evidence(
      [
        [-80, 0],
        [-60, 2],
        [-40, 3],
        [-20, 2.2],
        [0, 2.1],
        [10, 2.1],
      ],
      4,
    );
    const r = analyze(e, 4, ["p2"]);
    expect(r.contacts).toEqual([]);
    expect(r.spatialCandidates.some((x) => x.code === "overshoot")).toBe(false);
  });
  it("cannot create a direction for a stationary stack", () => {
    const e = evidence(
      [
        [-40, 1.2],
        [-20, 1.2],
        [0, 1.2],
        [20, 1.2],
      ],
      2,
    );
    expect(analyze(e, 2).spatialCandidates.some((c) => c.code === "undershoot" || c.code === "overshoot")).toBe(false);
  });
  it("positively describes a repeated stationary misplaced footprint without inventing an approach axis", () => {
    const e = evidence(
      [
        [-40, 1.2],
        [-20, 1.2],
        [0, 1.2],
        [20, 1.2],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual(["Misaim"]);
    expect(required(analyze(e, 2).landing).alongR).toBeNull();
    expect(required(analyze(e, 2).landing).transverseR).toBeNull();
  });
  it("preserves exact just-outside stationary placement rather than inflating the receptor", () => {
    const e = evidence(
      [
        [-40, 1.001],
        [-20, 1.001],
        [0, 1.001],
        [20, 1.001],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual(["Misaim"]);
    expect(required(analyze(e, 2).landing).radialR).toBeGreaterThan(1);
  });
  it("does not infer a static footprint from an isolated or one-sided coordinate", () => {
    expect(labels(evidence([[0, 1.2]], 0), 0)).toEqual([]);
    expect(
      labels(
        evidence(
          [
            [-40, 1.2],
            [0, 1.2],
          ],
          1,
        ),
        1,
      ),
    ).toEqual([]);
  });
  it("keeps independent timing support for an established outside footprint", () => {
    const e = evidence(
      [
        [-100, -5, 1.3],
        [-80, -2, 1.3],
        [-60, -0.1, 1.3],
        [-40, 0, 1.3],
        [-25, 0, 1.3],
        [-5, 0, 0.8],
        [20, 0, 0],
      ],
      4,
    );
    expect(labels(e, 4)).toEqual(["Misaim"]);
    expect(analyze(e, 4).timingIndependent).toBe(true);
  });
  it("does not claim independent late tapping from newly late misplaced arrival", () => {
    const e = evidence(
      [
        [-40, -5, 1.3],
        [-20, -3, 1.3],
        [0, -1, 1.3],
        [20, 0, 1.3],
        [38, 0.03, 1.3],
        [50, 0.03, 1.3],
      ],
      4,
    );
    expect(labels(e, 4)).toEqual(["Misaim"]);
    expect(analyze(e, 4).timingIndependent).toBe(false);
  });
  it("allows a witnessed short landing just after an on-time tap, without borrowing post-terminal movement", () => {
    const e = evidence(
      [
        [-60, -4],
        [-30, -2],
        [-10, -1.5],
        [0, -1.3],
        [10, -1.15],
        [20, -1.2],
        [40, -1.5],
      ],
      3,
    );
    expect(labels(e, 3)).toEqual(["Undershoot"]);
  });
  it("supports a completed lateral bypass without a mandatory stop", () => {
    const e = evidence(
      [
        [-60, -4, 1.2],
        [-40, -2, 1.2],
        [-20, 0, 1.2],
        [0, 2, 1.2],
        [20, 4, 1.2],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual(["Misaim"]);
    expect(analyze(e, 2).timingIndependent).toBe(false);
  });
  it("does not use an unfinished lateral approach as a completed bypass", () => {
    const e = evidence(
      [
        [-60, -4, 1.2],
        [-40, -2, 1.2],
        [-20, 0, 1.2],
      ],
      2,
    );
    expect(labels(e, 2)).toEqual([]);
  });
  it.each([0, Math.PI / 2, Math.PI, Math.PI / 5])("is translation, scale and rotation invariant at %s", (angle) => {
    const original = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, -1.25],
        [-10, -1.2],
        [-5, -1.2],
        [10, -1.4],
      ],
      3,
    );
    const moved = JSON.parse(JSON.stringify(original)) as CircleEvidence;
    moved.geometry = { ...required(moved.geometry), profile: "lazer", position: { x: 100, y: 200 }, radius: 32 };
    for (const item of moved.inputs) {
      const { x, y } = item.record.position;
      item.record.position = {
        x: 100 + 32 * (x * Math.cos(angle) - y * Math.sin(angle)),
        y: 200 + 32 * (x * Math.sin(angle) + y * Math.cos(angle)),
      };
    }
    expect(labels(moved, 3)).toEqual(labels(original, 3));
  });
  it("rejects truncation rather than silently treating a subset as complete", () => {
    const e = evidence(
      [
        [-40, -3],
        [-20, -1.2],
        [0, -1.2],
      ],
      2,
    );
    e.limits.truncated = true;
    expect(analyze(e, 2).status).toBe("unavailable");
  });
  it("bounds radial lobes by cumulative turns rather than chaining tiny per-sample reversals", () => {
    const radii: number[] = [];
    for (const [from, to] of [[5,1.2],[1.2,4],[4,2],[2,4]]) {
      const count=Math.round(Math.abs(to-from)/0.02);
      for(let i=0;i<count;i++)radii.push(from+(to-from)*i/count);
    }
    radii.push(4);
    const secondStart=radii.findIndex((r,i)=>i>190 && Math.abs(r-4)<1e-9), press=secondStart+50;
    const xy=radii.map((r,i)=>[r*Math.cos(i*.03),r*Math.sin(i*.03)]);
    let time=0;
    const times=xy.map((p,i)=>{
      if(i)time+=Math.hypot(p[0]-xy[i-1][0],p[1]-xy[i-1][1])*5;
      return time;
    });
    const points=xy.map((p,i)=>[times[i]-times[press]-20,...p] as Point);
    const e=evidence(points,press), result=analyze(e,press);
    expect(Math.abs(points[190][0]-points[press][0])).toBeGreaterThan(38);
    expect(result.landing?.radialR).toBeGreaterThan(1.99);
    expect(result.landing?.radialR).toBeLessThanOrEqual(2.01);
    expect(result.landing?.eventIds).not.toContain("p190");
    expect(result.eventIds).toContain("p190");
  });
  it("preserves the supplied evidence exactly", () => {
    const e = evidence(
      [
        [-60, -4],
        [-40, -2],
        [-20, -1.25],
        [-10, -1.2],
        [-5, -1.2],
        [10, -1.4],
      ],
      3,
    );
    const before = JSON.stringify(e);
    analyze(e, 3);
    expect(JSON.stringify(e)).toBe(before);
  });
});

describe("recorded prepress far-edge return", () => {
  it.each(farReturnCalls)("$name keeps its own crest and press", facts => {
    const e = evidence(facts.points.map((p): Point => [p[0],p[1],p[2]]), facts.press);
    const ep = analyze(e, facts.press) as unknown as { farEdgeReturn?: { crest: { excursionR: number; returnedR: number } } };
    if (facts.name === "1265") {
      expect(ep.farEdgeReturn).toBeDefined();
      expect(ep.farEdgeReturn!.crest.excursionR).toBeCloseTo(.0632922,5);
      expect(ep.farEdgeReturn!.crest.returnedR).toBeCloseTo(.0347807,5);
    } else expect(ep.farEdgeReturn).toBeUndefined();
  });
  it.each(["placement","context","source"])("withholds far-edge return at a %s fence", fault => {
    const facts=farReturnCalls[0],e=evidence(facts.points.map(p=>[p[0],p[1],p[2]]),facts.press),id=`p${facts.press}`;
    const source=e.inputs[facts.press].record.source;
    if(fault==="source" && source.origin==="parsed") source.discontinuityBefore=["source-gap"]; 
    const ep=analyzePrimaryApproaches(e,{pressIds:[id],contextBoundaryInputIds:fault==="context"?[`p${facts.press-1}`]:[],inputScopes:fault==="placement"?{[id]:{placementEnd:{timeMs:995,inclusive:true}}}:undefined}).episodes[0];
    expect((ep as unknown as {farEdgeReturn?:unknown}).farEdgeReturn).toBeUndefined();
  });
});
