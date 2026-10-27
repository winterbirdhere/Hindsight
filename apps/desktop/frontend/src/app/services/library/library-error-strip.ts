import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { summarizeReplayEventsAsync } from "../analysis/replay-events";
import { LibraryErrorStrip, LibraryStripDomain, LIBRARY_STRIP_MAX_BYTES, LIBRARY_STRIP_MAX_MARKS, validateLibraryErrorStrip } from "../../../../../shared/library-error-strip";
import type { LibraryMetricValue } from "../../../../../shared/replay-library-metrics";

export async function projectLibraryErrorStrip(events:readonly ReplayAnalysisEvent[],ruleset:ReplayAnalysisRuleset,
  domain:LibraryStripDomain,qualified:boolean,checkpoint:()=>Promise<void>):Promise<LibraryMetricValue<LibraryErrorStrip>> {
  const unknown=(reason="strip-evidence-incomplete"):LibraryMetricValue<LibraryErrorStrip>=>({state:"unknown",reason});
  if(!qualified)return unknown();
  for(let i=0;i<events.length;i++){
    if(i%256===0)await checkpoint();const event=events[i],resolved=event.judgementTime;
    if(event.ruleset!==ruleset||typeof resolved!=="number"||!Number.isFinite(resolved)||resolved>domain.evaluatedThrough||
      !Number.isFinite(event.objectTime??event.time))return unknown();
  }
  const {timings}=await summarizeReplayEventsAsync(events,ruleset,checkpoint);
  const value:LibraryErrorStrip={version:1,timeBasis:"map-ms",...domain,ok:timings.ok,meh:timings.meh,miss:timings.miss,
    ...(ruleset==="stable"?{ruleset,sliderBreak:timings.sliderBreak,sliderEndMiss:timings.stableSliderEndMiss}:
      {ruleset,componentMiss:timings.lazerSliderTickMiss,sliderEndMiss:timings.lazerSliderEndMiss})};
  const count=value.ok.length+value.meh.length+value.miss.length+value.sliderEndMiss.length+
    (value.ruleset==="stable"?value.sliderBreak.length:value.componentMiss.length);
  if(count>LIBRARY_STRIP_MAX_MARKS)return unknown("strip-byte-size-limit-v2");
  const result={state:"known" as const,value};
  // Keys, enum strings and numeric timestamps are ASCII; retain every timestamp
  // exactly and distinguish an attempted byte-budget rejection from old counts.
  if(JSON.stringify(result).length>LIBRARY_STRIP_MAX_BYTES)return unknown("strip-byte-size-limit-v2");
  try{validateLibraryErrorStrip(result);}catch{return unknown();}
  return result;
}
