/** Shared algorithms: synchronous viewer callers and resumable library callers use identical steps. */
export function drainSteps<T>(steps:Generator<void,T,void>):T {
  let next=steps.next();while(!next.done)next=steps.next();return next.value;
}
export async function drainStepsAsync<T>(steps:Generator<void,T,void>,checkpoint:()=>Promise<void>):Promise<T> {
  await checkpoint();
  try {let next=steps.next();while(!next.done){await checkpoint();next=steps.next();}await checkpoint();return next.value;}
  finally {steps.return(undefined as T);}
}
/** Stable bottom-up merge sort. Work, including copying, is bounded between yields. */
export function* stableSortSteps<T>(items:T[],compare:(a:T,b:T)=>number):Generator<void,void,void> {
  const size=items.length;if(size<2)return;
  let source=items,target:T[]=[],work=0;
  for(let width=1;width<size;width*=2){
    for(let left=0;left<size;left+=width*2){
      const middle=Math.min(left+width,size),right=Math.min(left+width*2,size);let a=left,b=middle;
      for(let index=left;index<right;index++){
        target[index]=a<middle&&(b>=right||compare(source[a],source[b])<=0)?source[a++]:source[b++];
        if(++work%256===0)yield;
      }
    }
    const previous=source;source=target;target=previous;
  }
  if(source!==items)for(let index=0;index<size;index++){items[index]=source[index];if(++work%256===0)yield;}
}
