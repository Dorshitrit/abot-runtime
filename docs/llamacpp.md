# llama.cpp model connection

ABot includes a **llamacpp** provider alongside Ollama and OpenAI. Connect to an
existing llama-server, or choose **ABot-managed server** in onboarding or Models.
The manual connection never installs or controls an external server.

## Managed engine

The managed installer pins llama.cpp **b12608**, verifies the download's size and
SHA256, and extracts it into private `.abot-managed-llama` storage. Supported
targets are macOS arm64/x64 and CPU-only x64 on Ubuntu 22.04+ and Windows 10/11.
Other Linux distributions must provide compatible glibc/system libraries; musl
distributions and Linux/Windows arm64 are not covered by these binaries.
Windows requires local NTFS managed storage and Windows PowerShell 5.1 for ACL
validation. The helper does not change execution policy or request elevation;
blocked helpers or unsafe existing permissions fail explicitly.

Use the **Local llama.cpp server** card on Home, or **Set up / manage local
server** when adding a llama.cpp provider. Install the engine, add local models,
save settings, and explicitly start the server. Then choose a chat model and
**Use selected model** before saving its normal provider connection.

Choose **Start manually** (the default) or **Start with ABot**. The latter starts
the saved server once when ABot starts; reopening setup or polling status never
starts it. **Stop server** stops the owned router and its model workers. It stays
off until an explicit Start or the next ABot launch when Start with ABot is saved.
Stop before editing startup, ports, models or idle settings.

**Sleep after idle** releases model memory after the configured seconds (60 by
default); the next model request wakes it. Use `-1` to disable idle sleep. The
router remains available while models sleep. Status polling does not wake models.
**Maximum loaded chat models** limits simultaneous resident chat models; each
has its own context setting and one inference slot.

Add an existing single-file GGUF, or select compatible models found in the
default local Ollama model store. Discovery reads local metadata and downloads
nothing. Models need a usable embedded chat template or an explicitly selected
Jinja file; custom templates are pinned by digest and must be reselected if
changed. An optional local vision projector can be supplied. Keep GPU layers at
zero on Linux/Windows; macOS supports automatic GPU placement.
Windows paths may include a drive letter, spaces and Unicode; UNC paths, device
paths and alternate data streams are not accepted. Model downloads, driver
installation and GPU backends on Linux/Windows are outside this installer.

An optional embedding model runs on a separate loopback port with the same idle
policy. In memory setup, refresh managed-server status and explicitly select
**Use managed embeddings**, then **Test and save** to enable memory. Adding an
embedding model to the server alone does not enable memory or change providers.

Closing the wizard does not stop the server; closing ABot stops its owned process
tree. A busy port causes an error; ABot never adopts or stops an external server.
The earlier single-model engine can be stopped explicitly in the new dialog.
Its launch preferences are not migrated into server autostart settings.
The private credential is reused across starts and service restarts, passed in
the child environment and omitted from process arguments and browser responses.
Saved preferences use atomic replacement after syncing file data. POSIX also
syncs the directory; Windows power-loss durability remains filesystem-specific.

Archive checks and fixture tests do not establish actual engine/model execution
on each OS. Native Windows ACL and lifecycle fixtures are included in the
Windows CI gate; a real model smoke requires separate validation.

The implementation targets the server protocol in
[llama.cpp v0.7.0, revision 620d2225](https://github.com/ggml-org/llama.cpp/tree/620d2225cc436ab0b001e3200e590e3b286ef9ab).
Protocol fixtures exercise that interface. This is a source compatibility
reference, not a claim that a real server or every model/template was tested.
Earlier builds may not support the reasoning budget fields.

## Input token counting and compaction

ABot uses `POST /v1/chat/completions/input_tokens` before context admission.
The endpoint is available in the pinned protocol revision above and performs
template rendering and tokenization without generating a response. Counting
uses the same model, projected messages, thinking controls and structured format
as generation, including the server's chat template and special tokens.
Structured-output grammar is not charged as additional prompt prose.

Each llama.cpp context assessment requests a fresh count instead of reusing the
client's token-count cache. The existing context budget and compactor consume
that measured count, and measure replacement candidates again. The final gateway
chat guard reuses a matching recent measurement; its existing estimate behavior
for a missing or expired measurement remains unchanged. Direct public `/raw`
calls retain their existing estimate guard. OpenAI caching and Ollama estimation
retain their existing behavior.

An unavailable counting endpoint, invalid response or failed authentication
fails the count explicitly; ABot does not silently substitute an estimate for
that failed call. Cancellation aborts counting. The count measures input size,
not server capacity: `contextWindowTokens` must still match the server's effective
context allocation.

## Multiple system messages

When a system message occurs after the first turn, the adapter checks the active
server template with synthetic markers at `POST /apply-template`. This renders a
prompt without generating an answer. The adapter first checks the original
message order. If the template loses or reorders markers, it can join consecutive
opening system messages in their original order and verify that layout. The user
turns and any later system messages keep their original positions.
The probe verifies marker presence and order. The server template determines
which model role receives each message in the rendered prompt.

The native count uses the selected layout. Before generation, a request with a
matching measurement checks that exact layout against the active server template
again. If the layout loses or reorders markers, generation stops before sending
the request. A fresh count can select a different layout for a later request.
The token count reflects the template and tokenizer active at measurement time.
Requests without a matching measurement check the available layouts before
generation. A template that cannot preserve the order returns
`llamacpp_system_message_order_unsupported`. Use
a server template that preserves the reported message shape. An unavailable
render check returns `llamacpp_system_message_render_unavailable`. Simple
requests with at most one system message at the start use the existing chat path.

## Prepare the server

Use the official [llama.cpp server guide](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/tools/server/README.md)
to install a build suitable for your OS/GPU and start your chosen model.
Set its model alias, effective context capacity, GPU allocation and listening
address explicitly. The example ABot origin is http://127.0.0.1:8080;
your server must actually listen there. Use the exact model ID returned by
the server, not an Ollama model-library name unless it is also your server alias.

The URL is resolved from the ABot Runtime host. A Windows browser does not
make a WSL or Docker Runtime use Windows loopback. Use an address reachable
from the Runtime for WSL-to-Windows, container-to-host or remote connections.
The setup form accepts an HTTP/HTTPS origin without credentials, query or path.

## Register the connection

On a new installation choose **llama.cpp** in setup. For an existing installation,
open **Models → Add model** and choose a new llama.cpp connection or reuse a
saved connection.

Enter the model ID, physical context capacity and server origin. The context
value must match the effective per-request capacity configured by the server;
it is not an instruction to resize the server. The API key is optional for a
server without authentication. If supplied, ABot writes a private isolated
credential binding in .env, not a key inside the model JSON or browser state.
An existing saved connection retains its authentication settings.

**Check connection** reads GET /health and GET /v1/models only.
It never generates a response or saves settings. Server readiness does not prove
thinking support, tool support, image support or context capacity.

The **This model supports thinking** checkbox is available for all providers.
It declares a model capability; enable it only when the selected model supports
reasoning. Newly created llama.cpp profiles start with text input only and
thinking support disabled. No capability is inferred from the model name.

## Thinking budget

For a llama.cpp model with thinking support enabled, setup and the model editor
offer a default budget. Invocation calibration can override that model default.

- **Inherit (no override):** omits the budget at that configuration layer.
- **Server default:** explicitly asks llama-server to use its configured default;
  this may itself be a finite budget.
- **Token limit:** a whole number from 0 through 2147483647 for each
  reasoning segment. Zero disables thinking; a positive value limits its tokens.

A budget is not a wall-clock timeout or a total user-request allowance.
One user request can invoke the model several times; each invocation may contain
more than one reasoning segment. The server can need closing tokens after the
limit and the final answer still needs output/context capacity.
The model's chat template must support thinking and the server's closing-tag
mechanism. A successful health check cannot validate that behavior.

The request-level **Off** control overrides a saved budget. Numeric limits are
only offered for llama.cpp; Ollama and OpenAI retain their existing effort
controls. A finite budget does not change ABot's role policy, approval rules
or tool permissions.

### Shared modes and optional overrides

Chat, SPARK, schedules and automation agents expose the shared **Low / Reasoning /
Deep** choices. Their default wire values remain `none / medium / high`, subject
to existing profile and invocation calibration. A model's template determines
whether positive effort levels differ. Chat exposes separate menus for reasoning
depth and thinking budget; the other forms expose separate controls. A manual
token limit or server default preserves the effective positive effort, and
choosing a mode retains that budget. For example, Deep and a 512-token limit can
be selected together. Selecting a mode clears an explicit manual Thinking Off
setting so the newly chosen mode can take effect.

Selecting a positive budget or server default when the ordinary effort is
`none` enables thinking with `medium`; a zero budget disables thinking without
rewriting the saved effort. An explicit invocation override still wins. Choosing
Profile default in the budget menu removes only the manual budget, preserving
the selected mode.

The model editor also offers **Mode token overrides**. The optional
`generation.reasoningBudgetByMode` map accepts `fast`, `reasoning` and `deep`,
each with a non-negative integer limit. Zero disables thinking for that mode.
No mode limits are supplied automatically.
For example, `"reasoningBudgetByMode": { "fast": 32, "deep": 512 }` enables
bounded thinking for Low and Deep while Reasoning keeps the ordinary settings.
These numbers are illustrative, not application defaults.

A matching mode limit replaces the ordinary `reasoningBudget`. A positive limit
enables thinking even when Low or the profile effort would otherwise disable it;
an already positive configured effort is preserved. A zero limit disables
thinking. Explicit invocation effort and request-level Off still take precedence. Per-mode maps apply only to main model
steps and direct gateway calls; utility steps such as `context.compact` retain
their own calibration and ignore conversation mode budgets.

Configuration overlays replace the entire map. Omitting the field inherits the
parent map, while `{}` explicitly clears inherited mode limits. Blank entries in
a custom map use the ordinary effort and budget settings; they do not inherit individual
entries from the replaced map.

~~~json
{
  "provider": "local-llama",
  "model": "gemma",
  "supportsThinking": true,
  "contextWindowTokens": 32768,
  "capabilities": { "inputModalities": ["text"] },
  "generation": {
    "reasoningBudget": { "mode": "tokens", "tokens": 512 }
  },
  "calibration": {
    "context.compact": {
      "generation": { "reasoningBudget": { "mode": "server-default" } }
    }
  }
}
~~~

Provider connection in runtime.config.json:

~~~json
{
  "models": {
    "providers": {
      "local-llama": {
        "type": "llamacpp",
        "baseUrl": "http://127.0.0.1:8080"
      }
    },
    "profiles": {
      "gemma": { "configRef": "./models/gemma.config.json" }
    }
  }
}
~~~

For authenticated servers add an apiKeyEnv name and supply its key privately.
The wizard creates an isolated name automatically.

## Command-line setup

~~~bash
npx abot init --provider llamacpp --model gemma --base-url http://127.0.0.1:8080 --context-window 32768 --supports-thinking true --reasoning-budget 512
npx abot add-model --profile gemma-llama --provider llamacpp --model gemma --base-url http://127.0.0.1:8080 --supports-thinking true --reasoning-budget server-default
~~~

For an authenticated connection add --api-key-env MY_LLAMA_KEY and set that
environment variable privately. Do not put an API secret in command arguments.
--supports-thinking true|false is also available for Ollama/OpenAI registration;
--reasoning-budget requires llama.cpp and explicit thinking support.

The add command preserves existing profiles and the selected default unless
--default is supplied. A reused provider ID must keep its existing endpoint.
Restart the owning gateway/ABot process after CLI changes. Web UI **Save and
apply** reloads an owned gateway or reports when an external owner must restart.

## Embeddings and semantic memory

The llama.cpp adapter supports text embeddings through `/v1/embeddings`.
Use a dedicated embedding model and run its llama-server with `--embedding`
and a pooling mode other than `none`, as required by the official server API.
A chat model with thinking support does not automatically support embeddings.

In the setup wizard's memory step, choose an existing llama.cpp connection or
create another one for the embedding server. On an existing installation, open
**Memory → Setup → Add connection** to use the same form. A separate embedding server uses
its own address and optional API key; it does not replace the chat connection.
For example, chat can use port 8080 while embeddings use port 8081. Enter the
embedding model's exact server ID manually. Model listing and a health check do
not establish embedding support. **Test and save** sends an embedding probe and
enables memory only when that probe succeeds.

Existing installations can select a configured llama.cpp connection in memory
settings. Embeddings use the existing `models.embeddingProfiles` configuration,
independently of chat profiles and reasoning budgets. A manual configuration
fragment for a separate embedding connection is:

~~~json
{
  "models": {
    "providers": {
      "llama-embeddings": {
        "type": "llamacpp",
        "baseUrl": "http://127.0.0.1:8081"
      }
    },
    "embeddingProfiles": {
      "memory-embedding": {
        "provider": "llama-embeddings",
        "model": "your-embedding-model-alias"
      }
    }
  },
  "longTermMemory": {
    "enabled": true,
    "embeddingProfileId": "memory-embedding"
  }
}
~~~

The adapter validates response indices, vector count, dimensions and finite
values, and uses the existing cancellation and model-fingerprint contracts.
Semantic memory can also continue using a separate Ollama/OpenAI connection.

## Boundaries and validation

Image input is not advertised. Embedding support does not change memory admission,
retention, retrieval or approval policy. No embedding model is installed or
selected automatically.

Validate real model behavior separately: ordinary text, structured decisions,
tool/result continuation, generated file contents, cancellation and stream
completion. Compare timing and output quality with thinking off, a finite budget
and server default under the same model/context/server configuration. Provider
traces record resolved controls and native usage when supplied; ABot does not
invent a budget-exhaustion event or a reasoning-token count.
