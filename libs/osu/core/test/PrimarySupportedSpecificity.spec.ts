import { PrimaryCandidate, rankSupportedPrimaryCandidates } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { selectCursorDescription } from "../src/gameplay/error-analysis/PrimaryAttribution";

const witness=(code:string,inputId="press"):PrimaryCandidate=>({
  code,headline:code,family:"placement",strength:1.9,independent:false,
  relationId:"placement:"+inputId,inputIds:[inputId],eventIds:[code+"-geometry"],
  support:{correction:{kind:"same-time-aim",inputId,sampleId:inputId,timeMs:1000,
    prefix:{parentCount:2,throughComponentId:"1",latestTerminalId:"terminal"},
    headRoutingPreservation:[{componentId:"4",eventIds:[code+"-routing"]}],eventIds:[code+"-proof"]}},
});
// Channel/press selection is already settled. Test description specificity
// using the exact same-time correction, never legacy candidate magnitudes.
const codes=(rows:PrimaryCandidate[])=>{
  const base=rows.find(c=>c.code==="misaim"&&c.inputIds[0]==="press")??rows[0];
  const selected=selectCursorDescription(rows,"press",base.support?.correction);
  return selected?[selected.code]:[];
};

describe("specificity of the same certified aim intervention",()=>{
  it("does not count a broad copy again when compatible arrival and direction refine the same repair",()=>{
    const broad:PrimaryCandidate={...witness("misaim"),strength:2.49149344,placementBasis:"moving-outside",relationId:"aim-correction:press"},
      arrival:PrimaryCandidate={...witness("aim-late"),family:"arrival",strength:4.72934175,relationId:"tap-phase:press"},
      direction={...witness("undershoot"),strength:2.49149338},older={...witness("misaim","older"),strength:2.91962317};
    expect(codes([broad,arrival,direction,older])).toEqual(["undershoot"]);
    expect(codes([{...broad,strength:6},{...arrival,strength:2},{...arrival,strength:2,code:"left-early"}])).toEqual(["misaim"]);
  });
  it("retains measured direction when a narrower moving run lacks that subtype at the same repair",()=>{
    const broad=Object.assign({...witness("misaim"),strength:3.7,relationId:"aim-correction:press"},{placementBasis:"moving-outside" as const}),
      specific={...witness("undershoot"),strength:3.6};
    for(const independent of [false,true])expect(codes([broad,{...specific,independent}])).toEqual(["undershoot"]);
  });
  it.each(["aim-late","left-early"])("keeps established placement when %s is also observed for the same correction",code=>{
    const broad:PrimaryCandidate={...witness("misaim"),strength:4,placementBasis:"moving-outside",relationId:"aim-correction:press"},
      arrival:PrimaryCandidate={...witness(code),family:"arrival",strength:2,relationId:"tap-phase:press"};
    expect(codes([broad,arrival])).toEqual(["misaim"]);
    expect(codes([broad,{...arrival,inputIds:["other"]}])).toEqual(["misaim"]);
  });
  it("keeps a directional witness when the broader witness has the same intervention and departure",()=>{
    const broad=witness("misaim"),specific=witness("wide-aim");
    for(const rows of [[broad,specific],[specific,broad],[broad,specific,broad]]){
      expect(codes(rows)).toEqual(["wide-aim"]);
      expect(rankSupportedPrimaryCandidates(rows).candidates).toEqual(rows);
    }
  });
  it("does not let a larger broad distance erase a supported subtype",()=>{
    expect(codes([{...witness("misaim"),strength:2.1},witness("wide-aim")])).toEqual(["wide-aim"]);
  });
  it("keeps broad evidence from another action in the full comparison",()=>{
    expect(codes([witness("misaim"),witness("misaim","other"),witness("wide-aim")])).toEqual(["wide-aim"]);
  });
  it.each(["relation","sample","time","prefix","routing"])("does not subsume a different %s witness",fault=>{
    const broad=witness("misaim"),specific=witness("wide-aim"),proof=specific.support?.correction;
    if(!proof)throw Error("fixture");
    if(fault==="relation")specific.relationId="different-placement";
    if(fault==="sample")proof.sampleId="other";
    if(fault==="time")proof.timeMs++;
    if(fault==="prefix")proof.prefix.latestTerminalId="other-terminal";
    if(fault==="routing")proof.headRoutingPreservation![0].componentId="5";
    expect(codes([broad,specific])).toEqual([fault==="relation"?"wide-aim":"misaim"]);
  });
  it("does not use an unsupported directional hypothesis",()=>{
    expect(codes([witness("misaim"),{...witness("wide-aim"),support:undefined}])).toEqual(["misaim"]);
  });
  it("keeps the broader diagnosis when directional witnesses conflict",()=>{
    expect(codes([witness("misaim"),witness("undershoot"),witness("overshoot")])).toEqual(["misaim"]);
    expect(codes([witness("misaim"),witness("undershoot"),{...witness("overshoot"),strength:1.8}])).toEqual(["misaim"]);
  });
  it("preserves established causal roles before specificity",()=>{
    const broad=witness("misaim"),specific=witness("wide-aim");
    if(!broad.support)throw Error("fixture");
    broad.support.context={role:"cadence-continuation",phaseMs:30,residualMs:0,eventIds:["anchor"]};
    expect(codes([broad,specific])).toEqual(["wide-aim"]);
  });
  it("does not discard separately supported independence",()=>{
    expect(codes([{...witness("misaim"),independent:true},witness("wide-aim")])).toEqual(["wide-aim"]);
  });
  it("keeps conflicting phase evidence at the same role",()=>{
    const broad=witness("misaim"),specific=witness("wide-aim");
    if(!broad.support||!specific.support)throw Error("fixture");
    broad.support.context={role:"cadence-continuation",phaseMs:30,residualMs:0,eventIds:["anchor"]};
    specific.support.context={role:"cadence-continuation",phaseMs:40,residualMs:0,eventIds:["other-anchor"]};
    expect(codes([broad,specific])).toEqual(["wide-aim"]);
  });
});
