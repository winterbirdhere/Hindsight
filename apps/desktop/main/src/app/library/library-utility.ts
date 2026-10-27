import { LibraryUtilityServer } from "./library-utility-server";
import { LibraryNativeBridge } from "./library-native-admission";

interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(value: unknown): void;
}
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error("Library storage requires an Electron utility process");
const native=new LibraryNativeBridge(value=>port.postMessage(value));
const server = new LibraryUtilityServer(response => {
  port.postMessage(response);
},event=>port.postMessage(event),native);
port.on("message", ({ data }) => {
  try{if(native.receive(data))return;if((data as {method?:string})?.method==="close")native.close();}
  catch{native.close();void server.close().finally(()=>process.exit(1));return;}
  void server.receive(data).catch(() => { native.close();void server.close().finally(() => process.exit(1)); });
});
// Main waits for the close acknowledgement, then terminates this empty utility. No app windows,
// viewer managers, native performance worker or source scan starts merely by loading this entry.
