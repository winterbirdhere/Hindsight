import type { StreamAssignment, StreamInputEvidence } from "./StreamInputEvidence";

export interface StreamLocalTable {
  familyId: string;
  assignments: StreamAssignment[];
  scopes: NonNullable<StreamInputEvidence["inputScopes"]>;
  alternatives: NonNullable<StreamInputEvidence["phaseAlternatives"]>;
}
export interface ReconciledStreamTables {
  assignments: StreamAssignment[];
  scopes: StreamLocalTable["scopes"];
  alternatives: StreamLocalTable["alternatives"];
  limitations: string[];
  unavailable?: boolean;
}

/** Immutable table seam for bounded scopes of one physical stream. */
export function reconcileStreamTables(
  targetId:string,tables:readonly StreamLocalTable[],rawIds:readonly string[],
  compareIds:(a:string,b:string)=>number=(a,b)=>a.localeCompare(b),
):ReconciledStreamTables {
  const claims=tables.flatMap(table=>table.assignments);
  const ordered=(ids:readonly string[])=>[...new Set(ids)].sort(compareIds);
  const inputIds=ordered([...claims.flatMap(row=>row.inputId ? [row.inputId] : []),...rawIds]);
  const result:ReconciledStreamTables={assignments:[],scopes:{},alternatives:[],limitations:[]};
  if(inputIds.length>512)return {...result,unavailable:true,limitations:["stream-action-limit"]};
  const claimKey=(row:StreamAssignment)=>JSON.stringify({...row,eventIds:[],contextEventIds:[],competingClaims:undefined,
    competingEvidence:undefined,geometry:row.geometry ? {...row.geometry,eventIds:[]} : undefined});
  const deduplicateClaims=(rows:StreamAssignment[])=>{
    const grouped=new Map<string,StreamAssignment>();
    for(const row of rows) {
      const key=claimKey(row),old=grouped.get(key);
      grouped.set(key,{...row,eventIds:ordered([...(old?.eventIds ?? []),...row.eventIds]),
        ...(row.contextEventIds || old?.contextEventIds ? {contextEventIds:ordered([...(old?.contextEventIds ?? []),...(row.contextEventIds ?? [])])} : {}),
        ...(row.geometry ? {geometry:{...row.geometry,eventIds:ordered([...(old?.geometry?.eventIds ?? []),...row.geometry.eventIds])}} : {})});
    }
    return [...grouped.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,row])=>row);
  };
  const competing=(rows:StreamAssignment[])=>deduplicateClaims(rows).map(row=>({componentId:row.componentId!,
    confidence:row.confidence,basis:row.basis,eventIds:row.eventIds}));
  for(const id of inputIds) {
    const rows=claims.filter(row=>row.inputId===id),matched=rows.filter(row=>row.relation==="matched"&&row.componentId);
    const direct=matched.filter(row=>row.confidence==="anchored");
    const strength=(row:StreamAssignment)=>row.confidence==="anchored" ? 3 : row.basis==="cadence" ? 2 : 1;
    const strongest=direct.length ? direct : matched.filter(row=>strength(row)===Math.max(...matched.map(strength)));
    const owners=new Set(strongest.map(row=>row.componentId));
    const familyConflict=[...new Set(tables.map(table=>table.familyId))].some(family=>{
      const local=tables.filter(table=>table.familyId===family).flatMap(table=>table.assignments).filter(row=>row.inputId===id),
        proposed=local.filter(row=>row.relation==="matched");
      return new Set(proposed.map(row=>row.componentId)).size>1 ||
        (proposed.length>0&&local.some(row=>row.relation==="extra"||row.relation==="ambiguous"));
    });
    const missingConflict=matched.some(row=>claims.some(other=>other.componentId===row.componentId&&other.relation==="missing"));
    const events=ordered(rows.flatMap(row=>[...row.eventIds,...(row.contextEventIds ?? []),...(row.geometry?.eventIds ?? [])]));
    if(owners.size>1 || (!direct.length && matched.length && (familyConflict||missingConflict))) {
      result.assignments.push({inputId:id,relation:"ambiguous",confidence:"ambiguous",eventIds:events,
        competingClaims:competing(matched),competingEvidence:deduplicateClaims(rows)});
      continue;
    }
    if(!matched.length) {
      if(rows.length)result.assignments.push({inputId:id,relation:rows.every(row=>row.relation==="extra") ? "extra" : "ambiguous",
        confidence:"ambiguous",eventIds:events,competingEvidence:deduplicateClaims(rows)});
      continue;
    }
    const winners=deduplicateClaims(strongest);
    // Equivalent ownership can have differently sized source contexts. Keep
    // every witness and choose metadata deterministically, never by query order.
    winners.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const contexts=ordered(rows.flatMap(row=>row.contextEventIds ?? []));
    const winner={...winners[0],eventIds:events,...(contexts.length ? {contextEventIds:contexts} : {}),
      ...(matched.length>1 ? {competingClaims:competing(matched),competingEvidence:deduplicateClaims(rows)} : {})};
    result.assignments.push(winner);
    const support=tables.filter(table=>table.assignments.some(row=>row.inputId===id&&row.relation==="matched"&&row.componentId===winner.componentId));
    const scopes=support.map(table=>table.scopes[id]);
    const boundaryKey=(scope:NonNullable<typeof scopes[number]>)=>JSON.stringify([scope.start,scope.end,scope.placementEnd]);
    if(scopes.length&&scopes.every(scope=>scope&&boundaryKey(scope)===boundaryKey(scopes[0]!))) {
      result.scopes[id]={...scopes[0],eventIds:ordered(scopes.flatMap(scope=>scope?.eventIds ?? [])),
        contextEventIds:ordered(scopes.flatMap(scope=>scope?.contextEventIds ?? []))};
    }
  }
  for(const componentId of ordered(claims.filter(row=>row.relation==="missing"&&row.componentId).map(row=>row.componentId!))) {
    // A contradicted omission remains diagnostic evidence, not a supported
    // missing-tap assignment. Matching/ambiguous input rows retain its witnesses.
    const missing=claims.filter(row=>row.componentId===componentId&&row.relation==="missing");
    const contradiction=claims.some(row=>row.componentId===componentId&&row.relation==="matched");
    if(contradiction) {
      for(const row of result.assignments)if(row.competingClaims?.some(claim=>claim.componentId===componentId)) {
        row.eventIds=ordered([...row.eventIds,...missing.flatMap(claim=>claim.eventIds)]);
        row.competingEvidence=deduplicateClaims([...(row.competingEvidence ?? []),...missing]);
      }
      result.limitations.push(componentId===targetId ? "stream-competing-target-absence" : `stream-competing-absence:${componentId}`);
    } else {
      const sorted=missing.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      result.assignments.push({...sorted[0],eventIds:ordered(missing.flatMap(row=>row.eventIds))});
    }
  }
  const alternatives=new Map<string,StreamLocalTable["alternatives"][number]>();
  for(const alternative of tables.flatMap(table=>table.alternatives)) {
    const targetInputIds=ordered(alternative.targetInputIds),key=JSON.stringify([alternative.reason,alternative.phaseMs,targetInputIds]);
    const old=alternatives.get(key);
    alternatives.set(key,{...alternative,targetInputIds,active:alternative.active||!!old?.active,
      recentAnchorCount:Math.min(alternative.recentAnchorCount,old?.recentAnchorCount ?? Infinity),
      eventIds:ordered([...alternative.eventIds,...(old?.eventIds ?? [])])});
  }
  result.alternatives=[...alternatives.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value);
  result.limitations=ordered(result.limitations);
  return result;
}
