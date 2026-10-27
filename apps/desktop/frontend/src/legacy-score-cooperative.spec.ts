import { StableLegacyScoreLookup,StableLegacyScoreEvent } from "@rewind/osu-performance/legacy-score";
async function finish<T>(steps:Generator<void,T>,checkpoint:()=>Promise<void>):Promise<T>{
  let next=steps.next();while(!next.done){await checkpoint();next=steps.next();}return next.value;
}
const events:StableLegacyScoreEvent[]=Array.from({length:1024},(_,index)=>({objectIndex:index%2===0?index/2:512+Math.floor(index/2),
  combo:index%17===0?"reset":"increment",baseScore:300,applyComboMultiplier:true}));
it("cooperative initialization and overlapping-prefix reconstruction preserve synchronous score tables",async()=>{
  const checkpoint=jest.fn(async()=>undefined),cooperative=await finish(StableLegacyScoreLookup.createSteps(events,[{acronym:"HD"}]),checkpoint);
  const sync=new StableLegacyScoreLookup(events,[{acronym:"HD"}]);expect(checkpoint.mock.calls.length).toBeGreaterThan(2);
  for(const prefix of [1,256,512,513,700,1024])expect(await finish(cooperative.scoresAtPrefixSteps(prefix),checkpoint)).toEqual(sync.scoresAtPrefix(prefix));
  expect(cooperative.unavailableReason).toBe(sync.unavailableReason);
});
it("holds exact continuation during a long changed suffix and allows cancellation at an inner boundary",async()=>{
  const lookup=await finish(StableLegacyScoreLookup.createSteps(events,[]),async()=>undefined);
  await finish(lookup.scoresAtPrefixSteps(512),async()=>undefined);
  const steps=lookup.scoresAtPrefixSteps(513),first=steps.next();expect(first.done).toBe(false);
  // Pausing does not construct a replacement lookup or repeat already consumed events.
  await new Promise<void>(resolve=>setTimeout(resolve,0));const values=await finish(steps,async()=>undefined);
  const sync=new StableLegacyScoreLookup(events,[]);sync.scoresAtPrefix(512);expect(values).toEqual(sync.scoresAtPrefix(513));
  let checkpoints=0;await expect(finish(lookup.scoresAtPrefixSteps(1024),async()=>{if(++checkpoints===2)throw Error("cancelled");})).rejects.toThrow("cancelled");
});
