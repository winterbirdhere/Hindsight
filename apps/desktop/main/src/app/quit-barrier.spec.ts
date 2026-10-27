import { createQuitBarrier } from "./quit-barrier";

it("prevents repeated quit while both owners drain, then quits once even after cleanup failure", async () => {
  let release!: () => void; const error = new Error("cleanup"), quit = jest.fn(), failed = jest.fn(), immediate = jest.fn();
  const drain = jest.fn(() => [new Promise<void>(resolve => { release = resolve; }), Promise.reject(error)]);
  const barrier = createQuitBarrier(immediate, drain, quit, failed);
  const event = { preventDefault: jest.fn() }; barrier(event); barrier(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(immediate).toHaveBeenCalledTimes(1);
  expect(drain).toHaveBeenCalledTimes(1); expect(quit).not.toHaveBeenCalled();
  release(); await new Promise(resolve => setImmediate(resolve));
  expect(failed).toHaveBeenCalledWith(error); expect(quit).toHaveBeenCalledTimes(1);
  barrier(event); expect(event.preventDefault).toHaveBeenCalledTimes(2);
});
