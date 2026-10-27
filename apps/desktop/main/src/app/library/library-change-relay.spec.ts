import { LibraryChangeRelay } from "./library-change-relay";

it("scoped resources preserve exact continuity under an owner and never inherit a replaced owner", () => {
  const relay = new LibraryChangeRelay(), send = jest.fn(); relay.attach(send); const first = relay.beginSource();
  first({ ready: true, resourceRevision: "7" });
  first({ ready: false, resourceRevision: "9", resourceChanges: { from: "7", to: "9", scope: "replays", replayIds: ["one"] } } as Parameters<typeof first>[0]);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ resourceRevision: "1:9",
    resourceChanges: { from: "1:7", to: "1:9", scope: "replays", replayIds: ["one"] } }));
  const second = relay.beginSource(); second({ ready: true, resourceRevision: "9" });
  expect(send.mock.calls.at(-1)?.[0]).not.toHaveProperty("resourceChanges");
});

it("manual feedback forwards status-only progress but replacement snapshots stay semantic", () => {
  const relay = new LibraryChangeRelay(), send = jest.fn(); relay.attach(send);
  const first = relay.beginSource(), event = { ready: true, resourceRevision: "7", statusOnly: true as const };
  first({ ready: true, resourceRevision: "7" }); first(event);
  expect(send).toHaveBeenLastCalledWith({ revision: 3, ready: true, resourceRevision: "1:7", statusOnly: true });
  relay.snapshot(); expect(send).toHaveBeenLastCalledWith({ revision: 4, ready: true, resourceRevision: "1:7" });
  relay.beginSource(); const count = send.mock.calls.length; first(event); expect(send).toHaveBeenCalledTimes(count);
});

it("rebases revisions across utility replacement and rejects retired-owner notifications",()=>{
  const relay=new LibraryChangeRelay(),send=jest.fn();relay.attach(send);expect(send).not.toHaveBeenCalled();
  const first=relay.beginSource();first({ready:true});const second=relay.beginSource();
  first({ready:true});second({ready:false});second({ready:true});
  expect(send.mock.calls.map(([value])=>value)).toEqual([
    {revision:1,ready:false},{revision:2,ready:true},{revision:3,ready:false},{revision:4,ready:false},{revision:5,ready:true},
  ]);
});
it("gives replacement documents actual cached readiness without inventing a ready initial state",()=>{
  const relay=new LibraryChangeRelay(),source=relay.beginSource(),first=jest.fn(),second=jest.fn();
  relay.attach(first);expect(first).toHaveBeenLastCalledWith({revision:1,ready:false});source({ready:true});
  relay.attach(second);expect(second).toHaveBeenLastCalledWith({revision:3,ready:true});expect(first).toHaveBeenCalledTimes(2);
  relay.close();source({ready:false});relay.snapshot();relay.attach(first);expect(second).toHaveBeenCalledTimes(1);
});
it("keeps artwork revisions stable across metric updates but distinguishes utility replacement",()=>{
  const relay=new LibraryChangeRelay(),send=jest.fn();relay.attach(send);const first=relay.beginSource();
  first({ready:true,resourceRevision:"7"});first({ready:false,resourceRevision:"7"});first({ready:true,resourceRevision:"7"});
  expect(send.mock.calls.slice(1).map(([event])=>event.resourceRevision)).toEqual(["1:7","1:7","1:7"]);
  relay.beginSource()({ready:true,resourceRevision:"7"});expect(send).toHaveBeenLastCalledWith({revision:6,ready:true,resourceRevision:"2:7"});
});
