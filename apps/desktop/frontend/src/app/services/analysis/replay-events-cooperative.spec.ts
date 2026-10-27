import { defaultGameState, HitCircle, Slider, SliderCheckPoint, SliderPath, PathType, retrieveEvents,
  retrieveEventsAsync, ReplayAnalysisRuleset } from "@osujs/core";
import { summarizeReplayEvents, summarizeReplayEventsAsync } from "./replay-events";

function fixture() {
  const head=new HitCircle();head.id="slider/HEAD";head.sliderId="slider";head.hitTime=1000;
  const slider=new Slider(head);slider.id="slider";slider.repeatCount=0;slider.velocity=1;
  slider.path=new SliderPath([{type:PathType.Linear,offset:{x:0,y:0}},{offset:{x:300,y:0}}],300);
  const state=defaultGameState();state.hitCircleVerdict[head.id]={type:"GREAT",judgementTime:1000};state.judgedObjects.push(head.id);
  slider.checkPoints=Array.from({length:2048},(_,index)=>{
    const point=new SliderCheckPoint(slider);point.id=`slider/${index}`;point.type="TICK";point.hitTime=1001+index;
    state.checkPointVerdict[point.id]={hit:index%3!==0,judgementTime:point.hitTime};state.judgedObjects.push(point.id);return point;
  });
  // A source-only checkpoint and a semantic replacement must preserve native precedence.
  const replacement=new SliderCheckPoint(slider);replacement.id=slider.checkPoints[0].id;replacement.type="TICK";replacement.hitTime=9999;
  slider.stableCheckPoints=[...slider.checkPoints.slice(1),replacement];
  state.sliderVerdict[slider.id]="OK";state.sliderJudgementTime[slider.id]=3100;state.judgedObjects.push(slider.id);
  state.sliderTailVerdict[slider.id]={hit:false,judgementTime:3100};
  return {state,objects:[slider]};
}

describe("cooperative event extraction and summary",()=>{
  it.each(["stable","lazer"] as ReplayAnalysisRuleset[])("preserves %s ordering and all marker semantics",async ruleset=>{
    const {state,objects}=fixture();const checkpoint=jest.fn(async()=>undefined);
    const expected=retrieveEvents(state,objects,ruleset);
    const actual=await retrieveEventsAsync(state,objects,ruleset,checkpoint);
    expect(actual).toEqual(expected);expect(checkpoint.mock.calls.length).toBeGreaterThan(20);
    expect(await summarizeReplayEventsAsync(actual,ruleset,checkpoint)).toEqual(summarizeReplayEvents(expected,ruleset));
    expect(actual.some(event=>event.objectTime===9999)).toBe(ruleset==="stable");
  });
  it("parks inside a long slider and resumes without restarting or mutating its state",async()=>{
    const {state,objects}=fixture(),before=JSON.stringify(state);let calls=0,resume!:()=>void;
    const held=new Promise<void>(resolve=>{resume=resolve;});let entered!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});let done=false;
    const pending=retrieveEventsAsync(state,objects,"stable",async()=>{if(++calls===5){entered();await held;}}).then(value=>{done=true;return value;});
    await ready;expect(done).toBe(false);expect(calls).toBe(5);resume();
    expect(await pending).toEqual(retrieveEvents(state,objects,"stable"));expect(JSON.stringify(state)).toBe(before);
  });
  it("propagates cancellation during extraction and summary sorting",async()=>{
    const {state,objects}=fixture();let calls=0;
    await expect(retrieveEventsAsync(state,objects,"stable",async()=>{if(++calls===12)throw new Error("stop extraction");})).rejects.toThrow("stop extraction");
    const events=retrieveEvents(state,objects,"stable");let total=0;
    await summarizeReplayEventsAsync(events,"stable",async()=>{total++;});
    calls=0;
    await expect(summarizeReplayEventsAsync(events,"stable",async()=>{if(++calls===total-1)throw new Error("stop sort");})).rejects.toThrow("stop sort");
    expect(calls).toBe(total-1);
  });
});
