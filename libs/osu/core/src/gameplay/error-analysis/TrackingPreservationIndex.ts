import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";

type TrackingRecord=Extract<ReplayTraceRecord,{kind:"slider-tracking"|"slider-checkpoint"}>;
const indexes=new WeakMap<ReplayTrace,ReturnType<typeof build>>();
function build(trace:ReplayTrace){
  const terminals=new Map<string,ReplayTraceRecord>(),states=new Map<string,TrackingRecord[]>(),
    attempts=new Map<string,string>(),allowedHeads=new Map<string,Set<string>>(),headPolicies=new Map<string,ReplayTraceRecord[]>(),
    circleTerminals=new Map<string,ReplayTraceRecord>(),receipts=new Map<string,ReplayTraceRecord[]>();
  for(const r of trace.records){
    if(r.kind==="slider-parent"||r.kind==="spinner-resolution")terminals.set(r.componentId,r);
    if(r.kind==="slider-tracking"||r.kind==="slider-checkpoint"&&r.tracking){
      const id=r.kind==="slider-tracking"?r.componentId:r.parentId,list=states.get(id)??[];
      list.push(r);states.set(id,list);
    }
    if(r.kind==="attempt")attempts.set(r.id,r.inputId);
    if(r.kind==="resolution"){
      circleTerminals.set(r.componentId,r);
      const input=r.triggerAttemptId&&attempts.get(r.triggerAttemptId);
      if(input){const list=receipts.get(input)??[];list.push(r);receipts.set(input,list);}
    }
    if(r.kind==="policy"&&r.state==="allowed"){
      const input=attempts.get(r.attemptId);if(!input)continue;
      const set=allowedHeads.get(input)??new Set<string>();set.add(r.componentId);allowedHeads.set(input,set);
      const list=headPolicies.get(r.componentId)??[];list.push(r);headPolicies.set(r.componentId,list);
    }
  }
  return {terminals,states,allowedHeads,headPolicies,circleTerminals,receipts};
}
export function trackingPreservationIndex(trace:ReplayTrace){
  let result=indexes.get(trace);if(!result){result=build(trace);indexes.set(trace,result);}return result;
}
