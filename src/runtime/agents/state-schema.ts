import { requireAgentFields } from "./record-validation.js";
import { migrateAgentCoordinatorIdentity } from "./coordinator-migration.js";
const FOUNDATION=["schemaVersion","revision","agents","missions","sessions","changes"];
const CONTROLLER=["invocations","decisions"];
const WORKSPACE=["messages","attempts","responsibility","mailbox"];
/** Legacy reads are pure projections; only a subsequent explicit commit publishes the current schema. */
function projectThroughVersionFive(value:unknown):unknown {
  if(value===null||typeof value!=="object")return value;
  const version=(value as {schemaVersion?:unknown}).schemaVersion;
  if(version===1) {
    const legacy=requireAgentFields(value,FOUNDATION,"state.v1");
    return migrateAgentCoordinatorIdentity({...legacy,invocations:[],decisions:[],messages:[],attempts:[],responsibility:[],mailbox:[]});
  }
  if(version===2) {
    const legacy=requireAgentFields(value,[...FOUNDATION,...CONTROLLER],"state.v2");
    return migrateAgentCoordinatorIdentity({...legacy,messages:[],attempts:[],responsibility:[],mailbox:[]});
  }
  if(version===3)return migrateAgentCoordinatorIdentity(requireAgentFields(value,[...FOUNDATION,...CONTROLLER,...WORKSPACE],"state.v3"));
  if(version===4) return {...requireAgentFields(value,[...FOUNDATION,...CONTROLLER,...WORKSPACE],"state.v4"),schemaVersion:5};
  return value;
}

export function projectAgentStateSchema(value: unknown): unknown {
  const previous = projectThroughVersionFive(value);
  if (!previous || typeof previous !== "object" || (previous as { schemaVersion?: unknown }).schemaVersion !== 5) return previous;
  return {...requireAgentFields(previous, [...FOUNDATION, ...CONTROLLER, ...WORKSPACE], "state.v5"), schemaVersion: 6, deletingAgentIds: []};
}
