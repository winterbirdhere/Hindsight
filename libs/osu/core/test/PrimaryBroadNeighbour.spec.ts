import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { analyzePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproach";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(mode:"broad"|"material"|"consumed") {
  const objects="100,192,900,1,0\n300,192,1010,1,0",reference=errorFixture(objects,[traceFrame(0),traceFrame(1200)]),object=reference.map.hitObjects[0];
  if(!(object instanceof HitCircle))throw Error("fixture");
  const r=stableGameplayRadius(object.radius),start=mode==="material"?-1.3:-.7,
    knots=[[0,start],[810,start],[840,-.5],[870,-.3],[900,-.1],[930,0],[950,.2],[952,.21],[960,.5]],
    frames=[...knots.map(([t,x])=>({...traceFrame(t,0,t===950?[0]:[]),
      position:mode==="consumed"&&t===950?{x:100,y:192}:{x:100+x*r,y:192+1.005*r}})),
      traceFrame(970,200),traceFrame(990,280),traceFrame(1010,300),traceFrame(1040,350,[1]),traceFrame(1200,400)],
    f=errorFixture(objects,frames),e=deriveCircleEvidence(f.trace,f.map,"1"),p=e.inputs.find(i=>i.record.timeMs===950);
  if(!p)throw Error("fixture press");
  return {f,e,p,association:derivePrimaryInputEvidence(e,f.map,f.trace).associations.find(a=>a.inputId===p.record.id),
    neighbour:analyzePrimaryApproaches(deriveCircleEvidence(f.trace,f.map,"0"),{pressIds:[p.record.id]}).episodes[0]};
}

describe("broad movement does not establish input ownership",()=>{
  it("retains an unconsumed target alternative despite a broad-only neighbouring lobe",()=>{
    const {f,p,association,neighbour}=fixture("broad");
    expect(neighbour.boundedOutsideLobe).toBeDefined();
    expect(f.trace.records.find(r=>r.kind==="selection"&&r.timeMs===950)).toMatchObject({componentId:null});
    expect(association?.role).toBe("relevant");
    expect(association?.inputId).toBe(p.record.id);
  });
  it("preserves a material neighbouring landing",()=>{
    const {association,neighbour}=fixture("material");
    expect(neighbour.boundedOutsideLobe).toBeUndefined();
    expect(association).toMatchObject({role:"context",reasons:["neighbour-local-approach"]});
  });
  it("preserves the actual successful receiver's ownership",()=>{
    const {f,association}=fixture("consumed");
    expect(f.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(association).toMatchObject({role:"context",reasons:["successful-neighbour-input"]});
  });
});
