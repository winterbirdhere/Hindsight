import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { EvidenceBoundary, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";

export interface OtherReceiptBoundary extends EvidenceBoundary {
  sequence: number;
  eventId: string;
  componentId: string;
  parentId: string;
  inputId: string;
}
type ReceiptIndex = { parents: Map<string,string>; receipts: OtherReceiptBoundary[] };
const indexes = new WeakMap<ReplayTrace, WeakMap<Beatmap, ReceiptIndex>>();

/** Ordered successful manual receipts, not inferred ownership or null dispatch. */
export function latestOtherReceiptBoundary(trace: ReplayTrace, map: Beatmap, targetId: string,
  press: InputRecord): OtherReceiptBoundary | undefined {
  let maps = indexes.get(trace);
  if (!maps) { maps = new WeakMap(); indexes.set(trace,maps); }
  let index = maps.get(map);
  if (!index) {
    const parents = new Map<string,string>();
    for (const object of map.hitObjects) {
      if (object instanceof Slider) parents.set(object.head.id,object.id);
      else if (object instanceof HitCircle) parents.set(object.id,object.sliderId ?? object.id);
    }
    const attempts = new Map<string,Extract<ReplayTraceRecord,{kind:"attempt"}>>();
    const inputs = new Map<string,InputRecord>();
    const receipts: OtherReceiptBoundary[] = [];
    for (const r of trace.records) {
      if (r.kind === "input") inputs.set(r.id,r);
      if (r.kind === "attempt") attempts.set(r.id,r);
      if (r.kind !== "resolution" || r.mechanism !== "successful-input" ||
        !["GREAT","OK","MEH"].includes(r.result) || !r.triggerAttemptId) continue;
      const a = attempts.get(r.triggerAttemptId), p = a && inputs.get(a.inputId), parentId = parents.get(r.componentId);
      if (!a || a.automated || !p || !parentId || p.source.origin !== "parsed" || !p.freshActions.length ||
        !(p.sequence < a.sequence && a.sequence < r.sequence) || a.timeMs !== p.timeMs || r.timeMs !== p.timeMs) continue;
      receipts.push({timeMs:r.timeMs,sequence:r.sequence,eventId:r.id,inclusive:false,
        componentId:r.componentId,parentId,inputId:p.id});
    }
    receipts.sort((a,b)=>a.timeMs-b.timeMs || a.sequence-b.sequence);
    index = {parents,receipts}; maps.set(map,index);
  }
  const parent = index.parents.get(targetId);
  if (!parent) return;
  let lo=0,hi=index.receipts.length;
  while(lo<hi){const mid=(lo+hi)>>>1,r=index.receipts[mid];
    if(r.timeMs<press.timeMs || r.timeMs===press.timeMs && r.sequence<press.sequence)lo=mid+1;else hi=mid;
  }
  for(let i=lo-1;i>=0;i--)if(index.receipts[i].parentId!==parent)return index.receipts[i];
  return;
}

/** Intersection of existing start fences, including whole-time exclusive bounds. */
export function laterApproachStart(a: EvidenceBoundary | undefined,b: EvidenceBoundary): EvidenceBoundary {
  if(!a || a.timeMs<b.timeMs)return b;
  if(a.timeMs>b.timeMs)return a;
  const order=(x:EvidenceBoundary)=>x.sequence ?? (x.inclusive?-Infinity:Infinity);
  if(order(a)!==order(b))return order(a)>order(b)?a:b;
  return !a.inclusive?a:b;
}
