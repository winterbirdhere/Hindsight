import { LibraryAnalysisWorkerServer } from "../../../../frontend/src/app/services/library/library-analysis-worker";
import { isAbsolute } from "path";
import { LibraryNativeBridge } from "./library-native-admission";
import { calculateLibraryTimeline,calculateLibraryPerformance } from "./library-performance-native";
import { setImmediate } from "timers/promises";

interface ParentPort {
  on(event:"message",listener:(message:{data:unknown})=>void):void;
  postMessage(value:unknown):void;
}
const port=(process as NodeJS.Process&{parentPort?:ParentPort}).parentPort;
if(!port)throw new Error("Library analysis requires an Electron utility process");
const diagnosticType="hindsight-library-control-trace-v1",diagnostics=process.argv.includes("--"+diagnosticType);let diagnosticCount=0;
const diagnostic=(event:string,value?:unknown,at=Date.now())=>{
  if(!diagnostics||diagnosticCount>=10000)return;
  try {
    const observed:Record<string,unknown>={version:1,type:diagnosticType,event,at};
    if(value&&typeof value==="object"){
      const input=value as Record<string,unknown>;
      for(const key of ["sequence","requestId"])if(input[key]===null||Number.isSafeInteger(input[key])&&Number(input[key])>=0)observed[key]=input[key];
      for(const key of ["viewerDemand","userPaused","fasterProcessing"])if(typeof input[key]==="boolean")observed[key]=input[key];
      if(typeof input.state==="string"&&["idle","parked","superseded","released"].includes(input.state))observed.state=input.state;
    }
    diagnosticCount++;port.postMessage(observed);
  }catch{/* Optional observation cannot affect a worker result or control. */}
};
const native=new LibraryNativeBridge(value=>port.postMessage(value));
let executable:string|undefined,started=false;
const server=new LibraryAnalysisWorkerServer(value=>{
  const at=diagnostics?Date.now():0;port.postMessage(value);
  if(diagnostics&&value.type==="control")diagnostic("control-response-sent",value,at);
},undefined,(request,signal)=>{
  const path=executable;if(!path)throw new Error("Library timeline native helper is not configured");
  return request.calculations.every(calculation=>calculation.scope==="full-map")
    ?calculateLibraryPerformance(()=>path,native,request,signal):calculateLibraryTimeline(()=>path,native,request,signal);
},fasterProcessing=>fasterProcessing?setImmediate():new Promise<void>(resolve=>setTimeout(resolve,0)));
port.on("message",({data})=>{
  try{
    if(diagnostics){const type=(data as {type?:string}|null)?.type;if(type==="control"||type==="run"||type==="cancel")diagnostic(type+"-received",data);}
    if(native.receive(data))return;
    const message=data as {version?:number;type?:string;executable?:unknown};
    if(message?.type==="configure-native"){
      if(started||executable||message.version!==1||typeof message.executable!=="string"||message.executable.length>32768||!isAbsolute(message.executable))
        throw new Error("Invalid analysis native configuration");
      executable=message.executable;return;
    }
    if(message?.type==="run")started=true;
    void server.receive(data).catch(()=>process.exit(1));
  }catch{process.exit(1);}
});
if(diagnostics)diagnostic("entry-ready");
