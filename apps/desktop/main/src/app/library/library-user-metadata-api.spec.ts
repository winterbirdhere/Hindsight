import { LibraryUserMetadataApi } from "./library-user-metadata-api";

function fixture() {
  const store={createCollection:jest.fn(()=>"created"),renameCollection:jest.fn(),deleteCollection:jest.fn(()=>["c"]),
    setReview:jest.fn(),setFavourite:jest.fn(),setMembership:jest.fn(),setPlayerNames:jest.fn(),playerNames:jest.fn(()=>["Lark","lark_old"])};
  return {store,api:new LibraryUserMetadataApi(store)};
}
it("stores only an explicit My names list and returns its canonical persisted values",()=>{
  const f=fixture();
  expect(f.api.receive("player-names-set" as never,{names:["Lark","lark_old"]})).toEqual({names:["Lark","lark_old"]});
  expect(f.store.setPlayerNames).toHaveBeenCalledWith(["Lark","lark_old"]);
  expect(f.store.playerNames).toHaveBeenCalledTimes(1);expect(f.store.setReview).not.toHaveBeenCalled();
});
it("creates one collection and optional direct membership through the atomic store operation",()=>{
  const f=fixture();expect(f.api.receive("collection-create",{name:"  Practice  ",parentId:"parent",replayId:"replay"})).toEqual({id:"created"});
  expect(f.store.createCollection).toHaveBeenCalledWith("  Practice  ","parent","replay");expect(f.store.setMembership).not.toHaveBeenCalled();
  expect(f.api.receive("collection-create",{name:"Root"})).toEqual({id:"created"});expect(f.store.createCollection).toHaveBeenLastCalledWith("Root",null,undefined);
});
it("routes exact single-record user edits without inventing children or file operations",()=>{
  const f=fixture();
  expect(f.api.receive("collection-rename",{collectionId:"c",name:"Renamed"})).toBeNull();expect(f.store.renameCollection).toHaveBeenCalledWith("c","Renamed");
  expect(f.api.receive("collection-delete",{collectionId:"c"})).toEqual({deletedReferences:["c"]});expect(f.store.deleteCollection).toHaveBeenCalledWith("c",[]);
  expect(f.api.receive("replay-review",{replayId:"r",review:"needs-another-look"})).toBeNull();expect(f.store.setReview).toHaveBeenCalledWith("r","needs-another-look");
  expect(f.api.receive("replay-favourite",{replayId:"r",favourite:false})).toBeNull();expect(f.store.setFavourite).toHaveBeenCalledWith("r",false);
  expect(f.api.receive("collection-membership",{replayId:"r",collectionId:"parent",included:true})).toBeNull();expect(f.store.setMembership).toHaveBeenCalledWith("r","parent",true);
});
it.each([
  ["collection-create",{name:" "}],["collection-create",{name:"x".repeat(257)}],["collection-create",{name:"N",parentId:1}],
  ["collection-create",{name:"N",replayId:""}],["collection-create",{name:"N",path:"D:/replay.osr"}],
  ["collection-rename",{collectionId:"c",name:"N",parentId:"other"}],["collection-delete",{collectionId:"c",deleteReplays:true}],
  ["collection-delete",{collectionId:"c",referencedIds:"one"}],["collection-delete",{collectionId:"c",referencedIds:["same","same"]}],
  ["collection-delete",{collectionId:"c",referencedIds:[""]}],["collection-delete",{collectionId:"c",referencedIds:["x".repeat(129)]}],
  ["collection-delete",{collectionId:"c",referencedIds:Array.from({length:102},(_,i)=>`id-${i}`)}],
  ["replay-review",{replayId:"r",review:"done"}],["replay-favourite",{replayId:"r",favourite:1}],
  ["collection-membership",{replayId:"r",collectionId:"c",included:"true"}],["collection-membership",{replayId:"x".repeat(129),collectionId:"c",included:true}],
  ["metric-target",{}],
])("rejects malformed metadata mutation %s before invoking the store",(method,args)=>{
  const f=fixture();expect(()=>f.api.receive(method as never,args as Record<string,unknown>)).toThrow();
  for(const operation of Object.values(f.store))expect(operation).not.toHaveBeenCalled();
});
it("returns only the bounded authoritative references deleted by the atomic operation",()=>{
  const f=fixture(),references=Array.from({length:101},(_,i)=>`id-${i}`),deleted=["c",...references];
  f.store.deleteCollection.mockReturnValue(deleted);
  expect(f.api.receive("collection-delete",{collectionId:"c",referencedIds:references})).toEqual({deletedReferences:deleted});
  expect(f.store.deleteCollection).toHaveBeenCalledTimes(1);expect(f.store.deleteCollection).toHaveBeenCalledWith("c",references);
});
it.each([Array.from({length:103},(_,i)=>`id-${i}`),["c","unrequested"],["c","c"]].map(deleted=>({deleted})))("rejects an unbounded or unrelated descendant response (%#)",({deleted})=>{
  const f=fixture();f.store.deleteCollection.mockReturnValue(deleted);
  expect(()=>f.api.receive("collection-delete",{collectionId:"c",referencedIds:["requested"]})).toThrow("Invalid deleted collection references");
  expect(f.store.deleteCollection).toHaveBeenCalledTimes(1);
});
it("propagates store failures without retries or partial fallback operations",()=>{
  const f=fixture(),failure=Error("transaction failed");f.store.createCollection.mockImplementation(()=>{throw failure;});
  expect(()=>f.api.receive("collection-create",{name:"Practice",replayId:"r"})).toThrow(failure);
  expect(f.store.createCollection).toHaveBeenCalledTimes(1);expect(f.store.setMembership).not.toHaveBeenCalled();
});
