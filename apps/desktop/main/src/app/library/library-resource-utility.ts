import { LibraryResourceServer } from "./library-resource-server";
import { LibraryNativeBridge } from "./library-native-admission";

interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(value: unknown): void;
}
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error("Library resources require an Electron utility process");
const native=new LibraryNativeBridge(value=>port.postMessage(value));
const server = new LibraryResourceServer(response => port.postMessage(response),undefined,native);
port.on("message", ({ data }) => {
  try{if(native.receive(data))return;if((data as {method?:string})?.method==="close")native.close();}
  catch{native.close();void server.close().finally(()=>process.exit(1));return;}
  void server.receive(data).catch(() => { void server.close().then(() => process.exit(1), () => process.exit(2)); });
});
