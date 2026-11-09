# SPARK HOME

HOME is an environment-owned, manual-only page generator. It has its own settings,
calibration, source projections, finite workflow, run metadata and published screen.
The model must be explicitly saved with effective `execution-agent-v1` policy;
SPARK must also have a configured model. Collection/learning/proactive enablement
does not govern manual HOME. SUPER and inherited default models are ineligible.

`runtime.ts` composes the feature without doing work at construction. Dedicated
local/HTTP services admit a request against a saved settings revision, expose its
status, cancel it and decide a live approval. They do not submit ordinary requests.
The selected HOME model performs planning, one bounded research follow-up and HTML
writing through HOME utility steps. Indexed Resources are metadata until selected
reads occur. Successful tool receipts are passed explicitly to the writer.

The existing normal-invocation executor enforces prepared read controls, model
plugin restrictions and SPARK's tool permission policy. HOME offers eligible web
reads, the system probe and indexed Resources only. It does not expose raw payload
authoring, shell/filesystem mutation, other agents, Jobs or general tool execution.
Approval decisions bind to a live run and approval ID; the browser cannot change
the prepared action. Rejecting an approval ends that HOME attempt.

Published HTML is a single sandboxed document. Publication checks both the saved
settings revision and screen revision. Cancelling or failing retains the last
published page. Restart marks an unfinished run interrupted and never replays a
model call, tool or approval. Run metadata is not a resumable request transcript.

HOME's three model phases receive a bounded passive catalog of native system
widgets. The model selects registered IDs and positions using empty
`div[data-abot-widget]` slots. The catalog includes six Dashboard cards and four
optional management widgets, plus an optional live `system-metrics` monitor.
HOME instructs the model to select at least three
distinct Dashboard cards, respecting explicit user exclusions, and combine them
with its authored content. Before publication the HOME workflow validates at least
three distinct supported Dashboard slots using the same parser as the Web host.
Fewer slots fail the run with `spark_home_dashboard_widgets_required`, without
retries or modifying the last saved screen. Management widgets do not count toward
this minimum; reading existing screens does not apply the new publication rule.
At display time the Web host derives at most ten
distinct slots from saved HTML. The two opaque-origin frames retain their CSP;
their bridge carries only validated geometry and bounded heights. It cannot
request management actions or receive private widget contents. Old screens without
slots keep their existing rendering and need no storage migration.

Native widget components live in the Web UI's reusable `components/system-widgets`
owner. They read current environment data independently of generation and can be
mounted by other surfaces. Memory decisions require a user confirmation and exact
candidate revision; Skills and Resources reuse their existing management views in
host-owned dialogs, including dirty-draft and environment guards. Feature discovery
uses known current configuration and never activates a feature itself.
Dashboard cards reuse the existing live previews and borrow the same detail panels;
they do not create another data controller or duplicate approval/computer owners.
Their detail dialog remains usable when the ordinary Dashboard surface is hidden.

The system monitor has its own on-demand Web host sampler and bounded browser
poller. Only a visible mounted monitor polls, every two seconds after its previous
read settles; hiding, leaving, changing environment or disposing cancels it.
Samples update leaf values and fixed-size bars without replacing the card, HOME
frame or other widgets. Metrics never enter generated HTML or model context.
CPU/RAM scope is explicitly computer, WSL or container; Linux containers use
cgroup v1/v2 accounting and visible limits rather than host utilization. Sensor
readings are optional and labelled separately as physical-computer measurements.
See `src/web-ui/system-metrics/README.md` for support and verification limits.
The guided `system_status` choice selects this native monitor, with no system-probe
plugin requirement. Its passive calibration reference carries the exact widget ID
into the instruction draft. Existing saved instructions remain unchanged; the user
can draft and save new instructions through the usual review flow.

All HOME data lives under `<runtimeDir>/spark-home/`. Its navigation preference is
separate from shared Web workspace preferences, allowing older runtimes to open
the workspace. Appearance supplies optional saved background guidance only.
Legacy scheduling fields can be preserved on disk but are inert: scheduling and
the Jobs adapter are deferred. The existing SPARK chat remains the conversation
surface; HOME status/approvals appear there as a dedicated activity panel.

Ordinary EA/SUPER request handling, RAW, role context, compaction, Skills and tool
catalog construction remain unchanged. No HOME context or generation tools are
injected into ordinary conversations. Manual creation currently uses the explicit
HOME API/UI; ordinary chat text is not intercepted to launch HOME work.
