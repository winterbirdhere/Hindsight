import { EndpointActionSource, ReplayTraceRecord, ScoringDomain, TraceSource } from "./ReplayTrace";
type Input = Extract<ReplayTraceRecord,{kind:"input"}>;
const sameActions = (a: readonly number[],b: readonly number[]) => a.length === b.length && a.every(x=>b.includes(x));
const sameSource = (a: TraceSource | undefined,b: TraceSource | undefined) =>
  a?.origin === "parsed" && b?.origin === "parsed" && a.parsedFrameIndex === b.parsedFrameIndex && a.rawTokenIndex === b.rawTokenIndex &&
  JSON.stringify(a.discontinuityBefore ?? []) === JSON.stringify(b.discontinuityBefore ?? []);
export function validEndpointBracketDomain(domain: ScoringDomain): boolean {
  const bracket = domain.endpointInputBracket;
  if (!bracket) return true;
  const valid = (value: EndpointActionSource) => !!value && Number.isFinite(value.timeMs) &&
    value.source?.origin === "parsed" && Number.isSafeInteger(value.source.parsedFrameIndex) && value.source.parsedFrameIndex >= 0 &&
    Number.isSafeInteger(value.source.rawTokenIndex) && value.source.rawTokenIndex >= 0 &&
    (value.source.discontinuityBefore === undefined || (Array.isArray(value.source.discontinuityBefore) && value.source.discontinuityBefore.every(x=>typeof x === "string"))) &&
    Number.isSafeInteger(value.rawButtonMask) && value.rawButtonMask >= 0 && value.rawButtonMask <= 0xffffffff &&
    Array.isArray(value.actions) && new Set(value.actions).size === value.actions.length && value.actions.every(x=>x===0 || x===1) &&
    sameActions(value.actions,[...(value.rawButtonMask & 5 ? [0] : []),...(value.rawButtonMask & 10 ? [1] : [])]) &&
    Object.keys(value).every(key=>["timeMs","source","actions","rawButtonMask"].includes(key));
  const lastSource=domain.frameSources?.[domain.frameSources.length-1];
  return valid(bracket.previous) && valid(bracket.next) && domain.synthesizedEndpoint &&
    bracket.previous.timeMs < domain.endTimeMs && domain.endTimeMs < bracket.next.timeMs &&
    bracket.next.source.parsedFrameIndex === bracket.previous.source.parsedFrameIndex+1 &&
    bracket.next.source.rawTokenIndex === bracket.previous.source.rawTokenIndex+1 && !bracket.next.source.discontinuityBefore?.length &&
    lastSource?.origin === "synthetic" && lastSource.reason === "scoring-endpoint-interpolation" &&
    sameSource(domain.frameSources?.[domain.frameSources.length-2],bracket.previous.source);
}
export function verifiedEndpointActionBoundary(domain: ScoringDomain, previous?: Input, endpoint?: Input): boolean {
  const bracket = domain.endpointInputBracket;
  return !!bracket && validEndpointBracketDomain(domain) && !!previous && !!endpoint &&
    endpoint.source.origin === "synthetic" && endpoint.source.reason === "scoring-endpoint-interpolation" &&
    endpoint.timeMs === domain.endTimeMs && previous.timeMs === bracket.previous.timeMs &&
    previous.sequence < endpoint.sequence && sameSource(previous.source,bracket.previous.source) &&
    sameActions(previous.actions,bracket.previous.actions) && previous.rawButtonMask === bracket.previous.rawButtonMask &&
    sameActions(endpoint.actions,previous.actions) && sameActions(endpoint.previousActions,previous.actions) &&
    endpoint.rawButtonMask === previous.rawButtonMask && endpoint.freshActions.length === 0;
}
export function capturedEndpointBracketIsValid(domain: ScoringDomain, records: readonly ReplayTraceRecord[], incomplete: boolean): boolean {
  if (!domain.endpointInputBracket) return true;
  if (!validEndpointBracketDomain(domain)) return false;
  const last: Input[] = [];
  for(let i=records.length-1;i>=0 && last.length<2;i--) if(records[i].kind === "input") last.unshift(records[i] as Input);
  // A resource-truncated trace can lack the endpoint. It gains no local proof.
  if (incomplete && last[1]?.source.origin !== "synthetic") return true;
  return verifiedEndpointActionBoundary(domain,last[0],last[1]);
}
