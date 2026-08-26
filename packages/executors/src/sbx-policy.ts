import { sha256Canonical, type JsonValue } from "@mpx/core";
import { ExecutionError } from "./index.js";
export type SbxPolicyName="deny-all"|"minimal"|"implementation"|"delivery"|"research";
export interface NamedSbxPolicy {readonly default:"deny";readonly allow:readonly string[]}
export const namedSbxPolicies:Readonly<Record<SbxPolicyName,NamedSbxPolicy>>=Object.freeze({
 "deny-all":Object.freeze({default:"deny",allow:Object.freeze([])}),
 minimal:Object.freeze({default:"deny",allow:Object.freeze(["api.anthropic.com:443","api.openai.com:443"])}),
 implementation:Object.freeze({default:"deny",allow:Object.freeze(["api.anthropic.com:443","api.github.com:443","api.openai.com:443","github.com:443","registry.npmjs.org:443"])}),
 delivery:Object.freeze({default:"deny",allow:Object.freeze(["api.github.com:443","github.com:443"])}),
 research:Object.freeze({default:"deny",allow:Object.freeze(["api.anthropic.com:443","api.openai.com:443","github.com:443"])}),
});
type Decision="allow"|"deny";
interface PolicyCheck {readonly sandbox:string;readonly target:string;readonly decision:Decision}
interface PolicyLog {readonly sandbox:string;readonly host:string;readonly port:number;readonly decision:Decision;readonly count:number}
const label=/^[a-z0-9][a-z0-9.-]{0,62}$/u,target=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:(?:[1-9]\d{0,4})$/u;
export function parsePolicyEvidence(input:{sandbox:string;expected:readonly {target:string;decision:Decision}[];checks:readonly PolicyCheck[];logs:readonly PolicyLog[]}):{verdict:"pass";evidenceSha256:string}{
 if(!label.test(input.sandbox)||input.expected.length===0||input.expected.length>64||input.checks.length!==input.expected.length||input.logs.length>1024)throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: policy evidence is incomplete.");
 const expected=[...input.expected].sort((a,b)=>a.target.localeCompare(b.target));if(expected.some(item=>!target.test(item.target)))throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: policy target is invalid.");
 const checks=[...input.checks].sort((a,b)=>a.target.localeCompare(b.target));
 for(let i=0;i<expected.length;i++){const want=expected[i]!,got=checks[i];if(!got||got.sandbox!==input.sandbox||got.target!==want.target||got.decision!==want.decision)throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: policy check did not exactly match the expected decision.")}
 for(const log of input.logs)if(log.sandbox!==input.sandbox||!Number.isSafeInteger(log.port)||log.port<1||log.port>65535||!Number.isSafeInteger(log.count)||log.count<1||!target.test(`${log.host}:${log.port}`))throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: policy log is malformed or belongs to another sandbox.");
 for(const want of expected){const [host,port]=want.target.split(":");if(!input.logs.some(log=>log.host===host&&log.port===Number(port)&&log.decision===want.decision))throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: exact policy log evidence is missing.")}
 const evidenceSha256=sha256Canonical({sandbox:input.sandbox,expected,checks,logs:[...input.logs].sort((a,b)=>`${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`))} as unknown as JsonValue);return Object.freeze({verdict:"pass",evidenceSha256});
}
export function verifyNoSharedSkillsMounts(mounts:readonly {source:string;target:string}[]):void{if(mounts.some(m=>/(?:^|[\\/])(?:\.claude|\.pi|skills)(?:[\\/]|$)/iu.test(m.source)||/(?:^|\/)skills(?:\/|$)/iu.test(m.target)))throw new ExecutionError("SHARED_SKILLS_MOUNTED","SHARED_SKILLS_MOUNTED: mount inspection found shared host skills.")}
