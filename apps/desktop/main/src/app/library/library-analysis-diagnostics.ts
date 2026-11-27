import type { LibraryAnalysisWorkerPort } from "../../../../frontend/src/app/services/library/library-analysis-client";
import type { LibraryNativeBroker } from "./library-native-admission";
import type { LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import { open, FileHandle } from "fs/promises";
import { isAbsolute } from "path";
import { createLibraryAnalysisUtilityPort } from "./library-analysis-utility-client";
interface Child {postMessage(value:unknown):void;on(event:"message",listener:(value:unknown)=>void):unknown;on(event:"exit",listener:(value:number)=>void):unknown;kill():boolean;pid?:number}
export interface LibraryAnalysisDiagnostics {
  start<T extends {result:Promise<unknown>}>(ticket:LibraryMetricTicket,spawn:(args:string[])=>Child,broker:LibraryNativeBroker,executable:string,start:(factory:()=>LibraryAnalysisWorkerPort)=>T):T;
  close():Promise<void>;
}
const marker="hindsight-library-control-trace-v1";
const recordObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const validMarkerScalars=(value:Record<string,unknown>)=>
  (!Object.hasOwn(value,"sequence")||Number.isSafeInteger(value.sequence)&&Number(value.sequence)>0)&&
  (!Object.hasOwn(value,"requestId")||value.requestId===null||Number.isSafeInteger(value.requestId)&&Number(value.requestId)>0)&&
  ["viewerDemand","userPaused","fasterProcessing"].every(key=>!Object.hasOwn(value,key)||typeof value[key]==="boolean")&&
  (!Object.hasOwn(value,"state")||typeof value.state==="string"&&["idle","parked","superseded","released"].includes(value.state));
const scalarMetadata=(value:Record<string,unknown>):Record<string,unknown>=>{
  const result:Record<string,unknown>={};
  for(const key of ["sequence","requestId","id"])if(value[key]===null||Number.isSafeInteger(value[key])&&Number(value[key])>=0)result[key]=value[key];
  for(const key of ["viewerDemand","userPaused","fasterProcessing","drained"])if(typeof value[key]==="boolean")result[key]=value[key];
  if(typeof value.state==="string"&&["idle","parked","superseded","released"].includes(value.state))result.state=value.state;
  return result;
};
/** Task-only diagnostics: bounded buffered output, never a prerequisite for analysis or shutdown. */
export function createLibraryAnalysisDiagnostics(destination:string|undefined):LibraryAnalysisDiagnostics|undefined {
  if(!destination||!isAbsolute(destination)||destination.length>32768)return;
  let handle:FileHandle|undefined,disabled=false,closed=false,limited=false,count=0,bytes=0,workerId=0;
  const queue:string[]=[];let writing:Promise<void>|undefined;
  const ready=open(destination,"wx",0o600).then(file=>{handle=file;},()=>{disabled=true;queue.length=0;});
  const record=(value:Record<string,unknown>)=>{
    if(disabled||closed||limited)return;
    try {
      let line=JSON.stringify({at:Date.now(),...value})+"\n";
      if(count>=10000||bytes+line.length>4*1024*1024){line=JSON.stringify({at:Date.now(),event:"trace-limit"})+"\n";limited=true;}
      count++;bytes+=line.length;queue.push(line);
    }catch{/* Observation cannot change a worker outcome. */}
  };
  const flush=():Promise<void>=>{
    if(writing)return writing;
    writing=(async()=>{
      await ready;if(!handle||disabled||!queue.length)return;
      const batch=queue.splice(0).join("");
      try{await handle.writeFile(batch);}catch{disabled=true;queue.length=0;}
    })().finally(()=>{writing=undefined;});return writing;
  };
  const timer=setInterval(()=>{void flush();},250);timer.unref();
  record({event:"trace-start",version:1});
  return {
    start(ticket,spawn,broker,executable,start){
      const worker=++workerId;
      record({event:"worker-start",worker,replayId:ticket.replayId,slot:ticket.slot,stage:ticket.stage,generation:ticket.generation,attempt:ticket.attempt});
      const factory=()=>{
        record({event:"fork-start",worker});
        const child=spawn(["--"+marker]);record({event:"fork-return",worker,pid:child.pid});
        const observe=(value:unknown):boolean=>{
          try {
            if(!recordObject(value))return false;
            if(value.type===marker&&value.version===1&&typeof value.event==="string"&&["entry-ready","control-received","run-received","cancel-received","control-response-sent"].includes(value.event)&&
              typeof value.at==="number"&&Number.isFinite(value.at)&&validMarkerScalars(value)&&Object.keys(value).every(key=>["version","type","event","at","sequence","requestId","viewerDemand","userPaused","fasterProcessing","state"].includes(key))){
              record({event:"child-marker",worker,marker:value.event,childAt:value.at,...scalarMetadata(value)});return true;
            }
            if(value.type==="control")record({event:"raw-ack",worker,...scalarMetadata(value)});
            else if(typeof value.type==="string"&&["numerical","timeline","fc","result"].includes(value.type))record({event:"publication",worker,phase:value.type,
              ...(typeof value.status==="string"&&["complete","error","cancelled"].includes(value.status)?{status:value.status}:{})});
            else if(typeof value.event==="string"&&["native-request","native-release","native-cancel"].includes(value.event))record({event:"native",worker,action:value.event,
              ...(typeof value.phase==="string"&&["source-page","source-resolve","replay-decode","map-performance","timeline-performance"].includes(value.phase)?{phase:value.phase}:{}),...scalarMetadata(value)});
          }catch{/* Preserve even malformed genuine messages for the production validator. */}
          return false;
        };
        const wrapped:Child={
          postMessage(value){
            try{if(recordObject(value)&&typeof value.type==="string"&&["control","run","cancel"].includes(value.type))record({event:"parent-send",worker,type:value.type,...scalarMetadata(value)});}catch{/* Observation only. */}
            child.postMessage(value);
          },
          on(event:"message"|"exit",listener:((value:unknown)=>void)|((value:number)=>void)){
            if(event==="message")return child.on("message",value=>{if(!observe(value))(listener as (value:unknown)=>void)(value);});
            return child.on("exit",code=>{record({event:"utility-exit",worker,code});(listener as (value:number)=>void)(code);});
          },
          kill(){record({event:"kill-request",worker});return child.kill();}
        };
        // The adapter calls attach synchronously once. Scope the existing peer observer to that
        // one construction; metadata, source and artwork peers retain their original endpoints.
        const attach=broker.attach;
        broker.attach=(send,priority)=>{
          const endpoint=attach.call(broker,send,priority),setHeld=endpoint.setHeld;
          endpoint.setHeld=value=>{
            record({event:"peer-hold-start",worker,held:value});const pending=setHeld.call(endpoint,value);
            void pending.then(()=>record({event:"peer-hold-settled",worker,held:value,ok:true}),()=>record({event:"peer-hold-settled",worker,held:value,ok:false}));return pending;
          };return endpoint;
        };
        let port:LibraryAnalysisWorkerPort;
        try{port=createLibraryAnalysisUtilityPort(()=>wrapped,{nativeBroker:broker,nativeExecutable:executable});}finally{broker.attach=attach;}
        let callback=port.onmessage;
        Object.defineProperty(port,"onmessage",{configurable:true,get:()=>callback,set:value=>{
          callback=typeof value!=="function"?value:event=>{
            if(event.data?.type==="control")record({event:"host-ack",worker,...scalarMetadata(event.data)});
            return value(event);
          };
        }});
        const terminate=port.terminate;
        port.terminate=()=>{
          record({event:"retire-start",worker});const pending=terminate.call(port);
          void Promise.resolve(pending).then(()=>record({event:"retire-settled",worker,ok:true}),()=>record({event:"retire-settled",worker,ok:false}));return pending;
        };
        return port;
      };
      const task=start(factory);
      void task.result.then(()=>record({event:"task-settled",worker,ok:true}),error=>record({event:"task-settled",worker,ok:false,
        category:error instanceof Error&&error.message==="Library worker did not acknowledge control within 5 seconds"?"control-timeout":"other"}));
      return task;
    },
    async close(){if(closed)return writing;record({event:"trace-close"});closed=true;clearInterval(timer);await flush();await flush();try{await handle?.close();}catch{/* Diagnostic close cannot reject owner shutdown. */}}
  };
}
