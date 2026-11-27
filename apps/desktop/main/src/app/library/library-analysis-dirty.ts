/** Internal metadata notifications. No paths, results or replay payloads cross this channel. */
export const ANALYSIS_QUEUE_DIRTY=1,ANALYSIS_SETTINGS_DIRTY=2,ANALYSIS_ELIGIBILITY_DIRTY=4;
export interface LibraryAnalysisDirtyEvent {version:1;event:"analysis-dirty";revision:number;flags:number}
export function isAnalysisDirty(value:unknown):value is LibraryAnalysisDirtyEvent {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).length===4&&v.version===1&&v.event==="analysis-dirty"&&Number.isSafeInteger(v.revision)&&Number(v.revision)>0&&
    Number.isInteger(v.flags)&&Number(v.flags)>0&&Number(v.flags)<=7;
}
/** At most one event in flight; later mutations accumulate until that event is acknowledged. */
export class LibraryAnalysisDirtyPublisher {
  private flags=0;private revision=0;private outstanding?:number;private timer?:ReturnType<typeof setTimeout>;private started=false;private closed=false;
  constructor(private readonly send:(event:LibraryAnalysisDirtyEvent)=>void,private readonly failed:(error:unknown)=>void,private readonly delay=25){}
  mark(flags:number):void {if(this.closed)return;if(!Number.isInteger(flags)||flags<1||flags>7)throw new Error("Invalid analysis dirty flags");this.flags|=flags;this.schedule();}
  start():void{this.started=true;this.schedule();}
  acknowledge(revision:number):void {
    if(!Number.isSafeInteger(revision)||revision<1||revision>this.revision)throw new Error("Invalid analysis notification acknowledgement");
    if(revision===this.outstanding){this.outstanding=undefined;this.schedule();}
  }
  private schedule():void {
    if(this.closed||!this.started||this.timer||this.outstanding||!this.flags)return;
    this.timer=setTimeout(()=>{
      this.timer=undefined;if(this.closed||this.outstanding||!this.flags)return;
      const flags=this.flags;this.flags=0;this.outstanding=++this.revision;
      try{this.send({version:1,event:"analysis-dirty",revision:this.revision,flags});}catch(error){this.close();this.failed(error);}
    },this.delay);
  }
  close():void {this.closed=true;this.flags=0;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
}
