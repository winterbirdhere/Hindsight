import { Beatmap } from "../../beatmap/Beatmap";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { InitiatingChain } from "./InterceptionChain";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import { PrimaryCandidate, rankPrimaryCandidates } from "./PrimaryDiagnosisPolicy";
import { selectCadenceAttribution } from "./PrimaryAttribution";
import { PrimaryInputEvidence } from "./PrimaryInputEvidence";
import { cadenceFlowApplicable, TargetCadenceEvidence } from "./StreamCadenceEvidence";

const MAXIMUM_VARIANT_BYTES=8*1024*1024;

/** Cadence is one target observation in every allocation, never copied to taps. */
export function compareTargetCadence(e:CircleEvidence,map:Beatmap,association:PrimaryInputEvidence,cadence:TargetCadenceEvidence,chain?:InitiatingChain) {
  const inputs=e.inputs.filter(i=>cadence.binding.rawLiveInputIds.includes(i.record.id));
  const ambiguous=new Set(association.associations.filter(a=>a.role==="ambiguous").map(a=>a.inputId));
  const mandatory=association.relevantInputIds.filter(id=>inputs.some(i=>i.record.id===id)&&!ambiguous.has(id));
  const optional=inputs.map(i=>i.record.id).filter(id=>!mandatory.includes(id));
  const compare=(ids:string[])=>comparePrimaryApproaches(e,map,{pressIds:ids,
    contextBoundaryInputIds:e.inputs.filter(i=>i.record.freshActions.length&&!ids.includes(i.record.id)).map(i=>i.record.id),
    inputScopes:association.stream?.inputScopes?Object.fromEntries(Object.entries(association.stream.inputScopes).filter(([id])=>mandatory.includes(id)&&ids.includes(id))):undefined});
  const compared=compare(inputs.map(i=>i.record.id));
  type Episode=typeof compared.approaches.episodes[number];
  const approachVariants:Episode[]=[],candidates:PrimaryCandidate[]=[],variantKeys=new Map<string,number>(),candidateKeys=new Map<string,number>();
  let variantBytes=0,resourceLimited=false;
  // Intern complete descriptors/candidates once. Allocations retain exact scope
  // and indexes into those pools instead of duplicating their full source links.
  const intern=<T>(value:T,pool:T[],keys:Map<string,number>)=>{
    const decision=(value as PrimaryCandidate).attribution;
    const key=JSON.stringify([value,decision?{...decision}:undefined]),found=keys.get(key);if(found!==undefined)return found;
    if(variantBytes+2*key.length>MAXIMUM_VARIANT_BYTES){resourceLimited=true;return -1;}
    variantBytes+=2*key.length;const index=pool.length;pool.push(value);keys.set(key,index);return index;
  };
  const hypotheses:Array<{inputIds:string[];contextInputIds:string[];complete:boolean;counterevidenceComplete:boolean;approachVariantIds:number[];candidateIds:number[];
    selected:PrimaryCandidate[];scores:Array<{code:string;strength:number}>;limitations:string[];candidateAbsenceCompatible:boolean}>=[];
  const withinLimits=optional.length<=8&&inputs.length<=16;
  if(withinLimits)for(let bits=0;bits<2**optional.length;bits++){
    const admitted=new Set([...mandatory,...optional.filter((_,k)=>bits&(1<<k))]);
    const ids=inputs.filter(i=>admitted.has(i.record.id)).map(i=>i.record.id);
    // An excluded edge is context in this allocation. Its neighbouring landing
    // or correction must not be borrowed from the all-input approach.
    const branch=ids.length===inputs.length?compared:compare(ids),ranked=branch.ranking;
    const approachVariantIds=branch.approaches.episodes.map(ep=>intern(ep,approachVariants,variantKeys));
    const candidateIds=branch.candidates.map(c=>intern(c,candidates,candidateKeys));
    const candidateAbsenceCompatible=branch.approaches.episodes.length===ids.length&&branch.approaches.limitations.length===0&&
      ranked.reason!=="primary-candidate-limit"&&branch.approaches.episodes.every(ep=>ep.status==="supported"&&
        ep.limitations.every(l=>l==="no-positive-local-placement")&&
        (branch.candidates.some(c=>c.inputIds.includes(ep.inputId))||
          (ep.placement==="unproven"&&ep.limitations.includes("no-positive-local-placement"))));
    hypotheses.push({inputIds:ids,contextInputIds:e.inputs.filter(i=>i.record.freshActions.length&&!ids.includes(i.record.id)).map(i=>i.record.id),
      candidateAbsenceCompatible,
      counterevidenceComplete:!resourceLimited&&(ids.length===0||branch.structuralComplete),
      complete:!resourceLimited&&(ids.length===0||branch.complete),approachVariantIds,candidateIds,selected:ranked.selected,
      scores:ranked.scores.map(s=>({code:s.code,strength:s.inputs.reduce((sum,i)=>sum+i.strength,0)/Math.max(1,ids.length)})),
      limitations:[...new Set([...branch.approaches.limitations,...branch.approaches.episodes.flatMap(ep=>ep.limitations)])]});
    if(resourceLimited)break;
  }
  const complete=withinLimits&&!resourceLimited&&hypotheses.every(h=>h.complete);
  const contenders=[...candidates,...(chain?.causes??[])];
  const ordinaryRanking=rankPrimaryCandidates(candidates,inputs.map(i=>i.record.id));
  const positiveCadence=withinLimits&&!resourceLimited&&!e.limits.truncated&&Object.values(e.dependencies).every(d=>d.status==="complete")&&
    inputs.every(i=>i.freshActionsKnown&&i.inLiveSuccess&&!i.postTerminal&&i.record.freshActions.length>0&&
      [i.record.timeMs,i.record.position.x,i.record.position.y].every(Number.isFinite))&&
    compared.structuralComplete&&hypotheses.length===2**optional.length&&hypotheses.every(h=>h.counterevidenceComplete||h.candidateAbsenceCompatible)&&
    cadenceFlowApplicable(cadence);
  // Structural coverage can support this separately validated cadence only.
  // If cadence is ineligible, ordinary fallback still requires strict complete.
  const decision=selectCadenceAttribution(cadence.candidate,positiveCadence,ordinaryRanking,chain?.causes);
  const selected=complete||positiveCadence?decision.selected:[];
  return {policyVersion:"target-cadence-comparison-v7",complete,positiveCadence,cadence,approaches:compared.approaches,approachVariants,candidates,
    resources:{variantBytes,maximumVariantBytes:MAXIMUM_VARIANT_BYTES,limited:resourceLimited},
    hypotheses,contenders,selected,comparisonEventIds:[...new Set([...cadence.candidate.eventIds,...candidates.flatMap(c=>c.eventIds),...(chain?.eventIds??[])])],
    attribution:decision,
    reason:resourceLimited?"cadence-variant-resource-limit":!complete&&!positiveCadence?"incomplete-cadence-counterevidence":decision.reason};
}
