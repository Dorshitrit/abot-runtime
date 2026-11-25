import type { AgentPeerClarificationRecord } from "./peer-clarification-records.js";
import { rejectAgentRecord, requireAgentFields, requireAgentInteger, requireAgentText, requireAgentTimestamp } from "./record-validation.js";
export function readAgentPeerClarification(value:unknown):AgentPeerClarificationRecord {
  const record=requireAgentFields(value,["id","childAgentId","childMissionId","questionMessageId","question","invocationId","reservedTokens","status","answer","usageTokens","createdAt","updatedAt"],"peerClarification");
  for(const field of ["id","childAgentId","childMissionId","questionMessageId","question","invocationId"])requireAgentText(record[field],`peerClarification.${field}`);
  requireAgentInteger(record.reservedTokens,1,"peerClarification.reservedTokens");
  if(!["reserved","answered","awaiting_user_decision","unknown"].includes(record.status as string))rejectAgentRecord("peerClarification.status");
  if(record.answer!==null&&typeof record.answer!=="string")rejectAgentRecord("peerClarification.answer");
  if(record.usageTokens!==null)requireAgentInteger(record.usageTokens,0,"peerClarification.usageTokens");
  if(record.status==="reserved"&&(record.answer!==null||record.usageTokens!==null))rejectAgentRecord("peerClarification.premature_receipt");
  requireAgentTimestamp(record.createdAt,"peerClarification.createdAt");requireAgentTimestamp(record.updatedAt,"peerClarification.updatedAt");
  return structuredClone(record) as AgentPeerClarificationRecord;
}
