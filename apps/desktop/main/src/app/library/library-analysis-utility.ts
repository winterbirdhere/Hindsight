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
const native=new LibraryNativeBridge(value=>port.postMessage(value));
let executable:string|undefined,started=false;
const server=new LibraryAnalysisWorkerServer(value=>port.postMessage(value),undefined,(request,signal)=>{
  const path=executable;if(!path)throw new Error("Library timeline native helper is not configured");
  return request.calculations.every(calculation=>calculation.scope==="full-map")
    ?calculateLibraryPerformance(()=>path,native,request,signal):calculateLibraryTimeline(()=>path,native,request,signal);
},fasterProcessing=>fasterProcessing?setImmediate():new Promise<void>(resolve=>setTimeout(resolve,0)));
port.on("message",({data})=>{
  try{
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
