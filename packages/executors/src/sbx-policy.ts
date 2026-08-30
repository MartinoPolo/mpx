import { sha256Canonical, type JsonValue } from "@mpx/core";
import { ExecutionError } from "./index.js";
export type SbxPolicyName="open"|"deny-all"|"minimal"|"implementation"|"delivery"|"research";
export interface NamedSbxPolicy {readonly default:"allow"|"deny";readonly allow:readonly string[]}
export const namedSbxPolicies:Readonly<Record<SbxPolicyName,NamedSbxPolicy>>=Object.freeze({
 open:Object.freeze({default:"allow",allow:Object.freeze([])}),
 "deny-all":Object.freeze({default:"deny",allow:Object.freeze([])}),
 minimal:Object.freeze({default:"deny",allow:Object.freeze(["api.anthropic.com:443","api.openai.com:443"])}),
 implementation:Object.freeze({default:"deny",allow:Object.freeze(["api.anthropic.com:443","api.github.com:443","api.openai.com:443","github.com:443","registry.npmjs.org:443"])}),
 delivery:Object.freeze({default:"deny",allow:Object.freeze(["api.github.com:443","github.com:443"])}),
 research:Object.freeze({default:"deny",allow:Object.freeze(["api.anthropic.com:443","api.openai.com:443","github.com:443"])}),
});
type Decision="allow"|"deny";
export interface F2ProofPolicyProfile {readonly profile:SbxPolicyName;readonly default:"allow"|"deny";readonly targets:readonly {readonly target:string;readonly decision:Decision}[]}
export interface SbxPolicyPlan {readonly profile:SbxPolicyName;readonly apply:readonly (readonly string[])[];readonly checks:readonly {readonly target:string;readonly decision:Decision;readonly argv:readonly string[]}[]}
/** The single authority for production and proof policy materialization and inspection. */
export function buildSbxPolicyPlan(sandboxName:string,profile:SbxPolicyName,allow:readonly string[]=namedSbxPolicies[profile]?.allow??[]):SbxPolicyPlan{
 if(!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(sandboxName)||!namedSbxPolicies[profile])throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: policy plan binding is invalid.");
 const expected=[...new Set(allow)].sort();
 if(expected.some(value=>!target.test(value))||expected.some(value=>!namedSbxPolicies[profile].allow.includes(value)))throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: selected targets exceed the logical policy.");
 const policy=namedSbxPolicies[profile];
 const apply=policy.default==="allow"||expected.length===0?[]:[["policy","allow","network","--sandbox",sandboxName,...expected] as const];
 const checks=policy.default==="allow"
  ?[Object.freeze({target:"example.com:443",decision:"allow" as const,argv:Object.freeze(["policy","check","network","--sandbox",sandboxName,"example.com:443","--json"])})]
  :[...expected.map(value=>Object.freeze({target:value,decision:"allow" as const,argv:Object.freeze(["policy","check","network","--sandbox",sandboxName,value,"--json"])})),Object.freeze({target:"blocked.invalid:443",decision:"deny" as const,argv:Object.freeze(["policy","check","network","--sandbox",sandboxName,"blocked.invalid:443","--json"])})];
 return Object.freeze({profile,apply:Object.freeze(apply.map(item=>Object.freeze(item))),checks:Object.freeze(checks)});
}
/** Builds proof checks only for the profile selected when this sandbox is created. */
export function buildF2ProofPolicyMatrix(profile:SbxPolicyName):readonly F2ProofPolicyProfile[]{
 const policy=namedSbxPolicies[profile];
 if(!policy)throw new ExecutionError("POLICY_EVIDENCE_INVALID","POLICY_EVIDENCE_INVALID: selected profile is unknown.");
 const targets=(policy.default==="allow"?[{target:"example.com:443",decision:"allow" as const}]:[...policy.allow.map(target=>({target,decision:"allow" as const})),{target:"blocked.invalid:443",decision:"deny" as const}]).sort((a,b)=>a.target.localeCompare(b.target));
 return Object.freeze([Object.freeze({profile,default:policy.default,targets:Object.freeze(targets)})]);
}
interface PolicyCheckResult {readonly target:string;readonly exitCode:number;readonly stdout:string}
const target=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:(?:[1-9]\d{0,4})$/u;
const allowedResponseFields=["action","allowed","context","governance","resource_type","resource_value","target","type"] as const;
const deniedResponseFields=["action","allowed","deny_kind","reason","resource_value","rule","type"] as const;
function invalid(message:string):never{throw new ExecutionError("POLICY_EVIDENCE_INVALID",`POLICY_EVIDENCE_INVALID: ${message}`)}
function exactFields(value:Record<string,unknown>,fields:readonly string[]):boolean{return Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key))}
function boundedText(value:unknown):boolean{return typeof value==="string"&&value.length<=1024&&!/[\r\n\0]/u.test(value)}
export function parsePolicyEvidence(input:{sandboxName:string;expected:readonly {target:string;decision:Decision}[];checks:readonly PolicyCheckResult[]}):{verdict:"pass";evidenceSha256:string;decisions:readonly {target:string;decision:Decision;count:1}[]}{
 if(Object.keys(input).some(key=>key!=="sandboxName"&&key!=="expected"&&key!=="checks"))invalid("policy logs and unknown evidence fields are not evaluator proof.");
 if(!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.sandboxName)||input.expected.length===0||input.expected.length>32||input.checks.length!==input.expected.length)invalid("policy evidence is incomplete.");
 const expected=[...input.expected].sort((a,b)=>a.target.localeCompare(b.target)),checks=[...input.checks].sort((a,b)=>a.target.localeCompare(b.target));
 if(expected.some((item,index)=>!target.test(item.target)||(item.decision!=="allow"&&item.decision!=="deny")||(index>0&&expected[index-1]!.target===item.target)))invalid("policy target is invalid.");
 const decisions=expected.map((want,index)=>{
  const check=checks[index];if(!check||check.target!==want.target||!Number.isSafeInteger(check.exitCode)||check.exitCode<0||check.exitCode>255||typeof check.stdout!=="string"||Buffer.byteLength(check.stdout,"utf8")>65536)invalid("policy check result is malformed.");
  let raw:unknown;try{raw=JSON.parse(check.stdout)}catch{invalid("policy check JSON is malformed.")}
  if(!raw||typeof raw!=="object"||Array.isArray(raw))invalid("policy check JSON must be an object.");const result=raw as Record<string,unknown>;
  if(typeof result.allowed!=="boolean")invalid("policy check JSON fields are invalid.");
  const decision:Decision=result.allowed?"allow":"deny";
  if(decision==="allow"){
   const governance=result.governance;
   if(!exactFields(result,allowedResponseFields)||!governance||typeof governance!=="object"||Array.isArray(governance)||!exactFields(governance as Record<string,unknown>,["active"])||typeof (governance as Record<string,unknown>).active!=="boolean"||result.context!==`sandbox:${input.sandboxName}`||result.target!==want.target||result.resource_type!=="net:domain")invalid("allowed policy check JSON fields are invalid.");
  }else if(!exactFields(result,deniedResponseFields)||!boundedText(result.deny_kind)||!boundedText(result.reason)||!boundedText(result.rule))invalid("denied policy check JSON fields are invalid.");
  if(result.action!=="net:connect:tcp"||result.type!=="network"||result.resource_value!==want.target)invalid("policy check JSON does not describe the requested network resource.");
  if(decision!==want.decision||(decision==="allow"?check.exitCode!==0:check.exitCode===0))invalid("policy check decision or exit status is invalid.");
  return Object.freeze({target:want.target,decision,count:1 as const});
 });
 const normalized=Object.freeze(decisions);return Object.freeze({verdict:"pass",evidenceSha256:sha256Canonical({sandboxName:input.sandboxName,expected,decisions:normalized} as unknown as JsonValue),decisions:normalized});
}
export function verifyNoSharedSkillsMounts(mounts:readonly {source:string;target:string}[]):void{if(mounts.some(m=>/(?:^|[\\/])(?:\.claude|\.pi|skills)(?:[\\/]|$)/iu.test(m.source)||/(?:^|\/)skills(?:\/|$)/iu.test(m.target)))throw new ExecutionError("SHARED_SKILLS_MOUNTED","SHARED_SKILLS_MOUNTED: mount inspection found shared host skills.")}
