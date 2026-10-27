import { LibraryAnalysisDirtyPublisher } from "./library-analysis-dirty";
it("coalesces before startup, bounds bursts, and retains changes arriving before acknowledgement",async()=>{
  jest.useFakeTimers();const send=jest.fn(),failure=jest.fn(),publisher=new LibraryAnalysisDirtyPublisher(send,failure);
  try{publisher.mark(1);publisher.mark(2);await jest.advanceTimersByTimeAsync(100);expect(send).not.toHaveBeenCalled();
    publisher.start();await jest.advanceTimersByTimeAsync(25);expect(send).toHaveBeenCalledWith({version:1,event:"analysis-dirty",revision:1,flags:3});
    for(let n=0;n<1000;n++)publisher.mark(4);await jest.advanceTimersByTimeAsync(1000);expect(send).toHaveBeenCalledTimes(1);
    publisher.acknowledge(1);await jest.advanceTimersByTimeAsync(25);expect(send).toHaveBeenLastCalledWith({version:1,event:"analysis-dirty",revision:2,flags:4});
    expect(()=>publisher.acknowledge(3)).toThrow();publisher.acknowledge(1);publisher.close();publisher.mark(1);await jest.advanceTimersByTimeAsync(100);expect(send).toHaveBeenCalledTimes(2);
  }finally{publisher.close();jest.useRealTimers();}
});
