# Projects

The environment owner exposes project registration, catalog reads, folder browsing,
conversation creation and deletion through `RuntimeProjectService`. The Web UI
and attached local clients use the same owner; they do not open separate writers.

`FileProjectRepository` serializes mutations and atomically replaces
`<runtimeDir>/projects/registry.json`. Legacy array registries remain readable.
New writes use a versioned catalog containing active projects and deleted IDs,
so a single read observes both parts of the same committed state.

Deletion removes registration and records the ID, including an ID known only from
a historical conversation. It is idempotent. The deletion record prevents old
session snapshots and later-loaded pages from recreating a sidebar group.
Re-registering the same directory creates a new identity; it does not reattach
conversations from a deleted project.

Project deletion never deletes files, directories, sessions or messages. A
session's immutable project snapshot continues to select its original working
directory through `session-paths.ts`. Deletion controls sidebar membership only;
it does not retarget an existing conversation or a running request.

`list` and `get` expose active registrations. `catalog` additionally exposes
deleted IDs for presentation. The Web endpoint uses a single catalog read and
requires the normal same-origin JSON mutation guard for DELETE.
