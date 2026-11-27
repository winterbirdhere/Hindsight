import { deletionHelperOnce } from "./library-source-deletion-helper";
import type { LibraryStableStageOwnerProcess } from "./library-stable-deletion-stage";
export interface LibraryProcessIdentity {state:"alive"|"exited"|"absent"|"unknown";pid:number;creationTime100ns:string|null;errorCode:number|null}
/** Main-only OS observation. No process is stopped and unknown/denied observations prove nothing. */
export async function inspectLibraryProcessIdentity(executable:string,pid:number):Promise<LibraryProcessIdentity>{
  if(!Number.isSafeInteger(pid)||pid<1||pid>0xffffffff)throw Error("Invalid owned process identity request");
  const reply=await deletionHelperOnce(executable,"--library-process-identity",{operation:"inspect",pid});
  if(!reply.ok||reply.status!=="inspected"||reply.pid!==pid||!["alive","exited","absent","unknown"].includes(String(reply.state))||
    reply.creationTime100ns!==null&&(typeof reply.creationTime100ns!=="string"||!/^[1-9]\d{0,19}$/.test(reply.creationTime100ns))||
    ["alive","exited"].includes(String(reply.state))&&reply.creationTime100ns===null||reply.state==="absent"&&reply.creationTime100ns!==null||
    reply.errorCode!==null&&(!Number.isSafeInteger(reply.errorCode)||Number(reply.errorCode)<0))throw Error("Unverified OS process identity response");
  return{state:reply.state as LibraryProcessIdentity["state"],pid,creationTime100ns:reply.creationTime100ns as string|null,errorCode:reply.errorCode as number|null};
}
export function processOwnerRetired(ownerPid:number,owner:LibraryStableStageOwnerProcess|null,observation:LibraryProcessIdentity):boolean{
  if(observation.pid!==ownerPid||owner&&owner.pid!==ownerPid||observation.state==="unknown")return false;
  if(observation.state==="absent")return true;
  if(!owner||!observation.creationTime100ns)return false;
  return observation.creationTime100ns!==owner.creationTime100ns||observation.state==="exited";
}
export async function pinLibraryProcessIdentity(executable:string,pid:number):Promise<LibraryStableStageOwnerProcess>{
  const observation=await inspectLibraryProcessIdentity(executable,pid);
  if(observation.state!=="alive"||!observation.creationTime100ns)throw Error("The actual utility process is not provably alive");
  return{pid,creationTime100ns:observation.creationTime100ns};
}
