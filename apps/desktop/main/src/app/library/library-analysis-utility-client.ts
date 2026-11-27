import type { LibraryAnalysisWorkerPort } from "../../../../frontend/src/app/services/library/library-analysis-client";
import { LibraryAnalysisShutdownError } from "../../../../frontend/src/app/services/library/library-analysis-client";
import type { LibraryNativeBroker } from "./library-native-admission";
import { validateLibraryErrorStrip } from "../../../../shared/library-error-strip";

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const token=(value:unknown,max=128)=>typeof value==="string"&&value.length>0&&value.length<=max&&/^[a-zA-Z0-9_.:/+-]+$/.test(value);
/** Metric scalars admit 16Ki UTF-16 units (up to48Ki UTF-8 bytes), plus a64Ki ASCII
 * strip. A closed ticket/envelope fits the remaining16Ki of this128Ki transport cap. */
function boundedMetricResponse(value:Record<string,unknown>):boolean {
  if(value.version!==1||value.requestId!==1)return false;
  const ticket=value.ticket;
  if(!record(ticket)||!keys(ticket,["replayId","slot","stage","inputKey","producerVersion","generation","attempt"])||
    !token(ticket.replayId)||typeof ticket.slot!=="string"||!["numerical","timeline-pp","fc-pp"].includes(ticket.slot)||ticket.stage!=="S"||
    !token(ticket.inputKey,512)||!token(ticket.producerVersion)||!token(ticket.attempt)||
    !Number.isSafeInteger(ticket.generation)||(ticket.generation as number)<=0)return false;
  let metrics:unknown;
  if(value.type==="result"&&value.status==="complete"&&keys(value,["version","type","requestId","ticket","status","metrics"])||
    value.type==="numerical"&&keys(value,["version","type","requestId","ticket","metrics"]))metrics=value.metrics;
  else if((value.type==="timeline"||value.type==="fc")&&keys(value,["version","type","requestId","ticket","outcome"])&&
    record(value.outcome)&&keys(value.outcome,["metrics"]))metrics=value.outcome.metrics;
  else return false;
  if(!record(metrics)||!keys(metrics,["fields","provenance","errorStrip"])||!record(metrics.fields)||!record(metrics.provenance)||
    Object.keys(metrics.fields).length>32||Object.keys(metrics.provenance).length>24||
    JSON.stringify({fields:metrics.fields,provenance:metrics.provenance}).length>16384)return false;
  const scalar=(entry:unknown)=>typeof entry==="string"||typeof entry==="boolean"||typeof entry==="number"&&Number.isFinite(entry);
  if(!Object.values(metrics.provenance).every(entry=>entry===null||scalar(entry))||!Object.values(metrics.fields).every(entry=>
    record(entry)&&(entry.state==="known"?keys(entry,["state","value"])&&scalar(entry.value):
      typeof entry.state==="string"&&["unknown","not-applicable","error"].includes(entry.state)&&keys(entry,["state","reason"])&&typeof entry.reason==="string")))return false;
  if(metrics.errorStrip!==undefined)try{validateLibraryErrorStrip(metrics.errorStrip);}catch{return false;}
  return true;
}

interface Child {
  postMessage(value:unknown):void;
  on(event:"message",listener:(value:unknown)=>void):unknown;
  on(event:"exit",listener:(code:number)=>void):unknown;
  kill():boolean;
}
/** Hosts the existing numerical worker protocol outside renderer lifetimes. No SQLite, source
 * paths or viewer managers enter this utility; bounded prepared bytes arrive on its owned port. */
export function createLibraryAnalysisUtilityPort(spawn:()=>Child,options?:{nativeBroker:LibraryNativeBroker;nativeExecutable:string}):LibraryAnalysisWorkerPort {
  const child=spawn();let exited=false,retiring=false,killFailure:unknown;
  let finished!:()=>void;const exit=new Promise<void>(resolve=>{finished=resolve;});
  let terminal!:()=>void;const terminalResult=new Promise<void>(resolve=>{terminal=resolve;});
  let running=false,completed=false,configured=false,closing:Promise<void>|undefined;
  let terminalStatus:"complete"|"error"|"cancelled"|undefined,exitCode:number|"unknown"="unknown";
  const peer=options?.nativeBroker.attach(value=>{if(!exited)child.postMessage(value);});
  const controls=new Map<number,Promise<void>>();
  const error=(message:string)=>port.onerror?.({message,preventDefault:()=>undefined} as ErrorEvent);
  const kill=()=>{if(!exited)try{if(!child.kill())killFailure=new Error("Library analysis termination was not accepted");}catch(failure){killFailure=failure;}};
  const port:LibraryAnalysisWorkerPort={onmessage:null,onerror:null,onmessageerror:null,
    postMessage:value=>{
      if(exited||retiring)throw new Error("Library analysis utility is closed");
      // Defer configuration until the caller owns this port and can await failed-send cleanup.
      if(options&&!configured){child.postMessage({version:1,type:"configure-native",executable:options.nativeExecutable});configured=true;}
      const message=value as {type?:string;sequence?:number;viewerDemand?:boolean;userPaused?:boolean};
      if(peer&&message.type==="control"&&typeof message.sequence==="number"){
        if(controls.size>=32)throw new Error("Library native control queue is busy");
        const drained=peer.setHeld(message.viewerDemand===true||message.userPaused===true);
        void drained.catch(()=>undefined);controls.set(message.sequence,drained);
      }
      child.postMessage(value);
      if(message.type==="run")running=true;
    },
    terminate:()=>{
      if(closing)return closing;retiring=true;
      if(peer&&!exited){
        // Cancel computation first; its terminal response follows native disposal. Keep routing
        // broker messages while retiring, so a legitimate release cannot be lost before exit.
        const drained=peer.setHeld(true);void drained.catch(()=>undefined);
        let nativeDrain:"pending"|"confirmed"|"rejected"="pending",cancel:"not-required"|"sent"|"failed"="not-required";
        void drained.then(()=>{nativeDrain="confirmed";},()=>{nativeDrain="rejected";});
        const observation=()=>({terminal:terminalStatus??(exited?"exit-only" as const:running?"pending" as const:"not-required" as const),nativeDrain,utilityExit:exitCode,cancel});
        if(running&&!completed)try{child.postMessage({version:1,type:"cancel",requestId:1});cancel="sent";}catch(failure){cancel="failed";killFailure=failure;}
        closing=(async()=>{
          let timer:ReturnType<typeof setTimeout>|undefined,timeoutFailure:LibraryAnalysisShutdownError|undefined;
          try{await Promise.race([Promise.all([running&&!completed?terminalResult:undefined,drained]),new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>{timeoutFailure=new LibraryAnalysisShutdownError(observation());reject(timeoutFailure);},5000);
          })]);}catch(failure){killFailure??=failure;}
          finally{clearTimeout(timer);kill();}
          await exit;timeoutFailure?.observeFinal(observation());if(killFailure)throw killFailure;
        })();return closing;
      }
      kill();
      // Do not release a worker slot on an uncertain kill. Actual exit remains the ownership fence.
      return closing=exit.then(()=>{if(killFailure)throw killFailure;});
    }};
  child.on("message",value=>{
    if(exited)return;
    try {
      if(!record(value))throw new Error("Invalid library analysis utility response");
      const bytes=Buffer.byteLength(JSON.stringify(value));
      if(bytes>24*1024&&(bytes>128*1024||!boundedMetricResponse(value)))throw new Error("Invalid library analysis utility response");
      const message=value as {version?:number;event?:string;type?:string;requestId?:number;status?:string;sequence?:number};
      if(peer&&message.event?.startsWith("native-")){peer.receive(value);return;}
      if(message.version===1&&message.type==="result"&&message.requestId===1&&["complete","error","cancelled"].includes(message.status??"")){
        terminalStatus=message.status as "complete"|"error"|"cancelled";completed=true;terminal();
      }
      if(retiring)return;
      if(peer&&message.type==="control"&&typeof message.sequence==="number"){
        const drain=controls.get(message.sequence);if(!drain)return;controls.delete(message.sequence);
        void drain.then(()=>{if(!exited&&!retiring)port.onmessage?.({data:value} as MessageEvent);},failure=>error(failure instanceof Error?failure.message:"Native yielding failed"));return;
      }
      port.onmessage?.({data:value} as MessageEvent);
    }catch(failure){error(failure instanceof Error?failure.message:"Invalid library analysis utility response");}
  });
  child.on("exit",code=>{exited=true;exitCode=Number.isSafeInteger(code)?code:"unknown";peer?.disconnected();terminal();finished();if(!retiring)error(`Library analysis utility stopped (${code}); retry explicitly`);});
  return port;
}
