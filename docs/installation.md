# Installation

This guide covers three entry points:

- install `@abot-ai/runtime` as a local application with its Web UI
- install `@abot-ai/runtime` as a library in another TypeScript project
- clone this repository and run the local development services

## Prerequisites

- Node.js `^20.19.0` or `>=22.12.0` (Node.js 21 is not supported)
- npm
- TypeScript-capable host project if using the library directly
- Optional: an installed and running Ollama service for Ollama model profiles
- Optional: OpenAI API key for OpenAI model profiles

## Prepare Ollama (If Selected)

ABot Runtime ships an Ollama adapter, not the Ollama server or any model
weights. Install Ollama from the
[official download page](https://ollama.com/download), choose a concrete
`<model-id>` from the [Ollama model library](https://ollama.com/library), and
start the Ollama service using the instructions for your platform.

After the service is running, pull the chosen model and confirm the API lists
it:

```bash
ollama pull <model-id>
curl http://127.0.0.1:11434/api/tags
```

Use the same `<model-id>` in the runtime model profile. The URL above assumes
the command and Ollama share a host/network namespace. If the runtime reaches
Ollama at another origin, pass it during initialization:

```bash
npm run init -- --provider ollama --model <model-id> --base-url http://<ollama-host>:11434
```

The origin is written to `models.providers.ollama.baseUrl` in the generated
runtime config. Docker Desktop can usually reach Ollama on its Windows or macOS
host at `http://host.docker.internal:11434`; WSL, other container layouts, and
remote hosts may use a different address. The only requirement is that the
runtime process can reach it.

## Install The Local Application

Create a directory that will own the consumer's configuration and runtime
state, then install ABot Runtime into it:

```bash
mkdir my-abot
cd my-abot
npm init -y
npm install @abot-ai/runtime
```

Start the packaged Web UI:

```bash
npx abot start
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177). The command binds to
loopback by default. On a fresh installation, the setup wizard lets you select
OpenAI or Ollama, enter a concrete model ID, and save the connection. OpenAI
accepts the API key directly in the form and stores it privately in the
consumer's `.env`. The key is not returned to the browser or stored in runtime
JSON. Existing OpenAI configurations missing a key open the same completion flow.

For Ollama, the server must already be running with the selected model available.
Its address is resolved from the ABot host, even when you use the UI from a phone.
Continue through the optional **Embedding** step to configure semantic memory,
or choose to set it up later. **Plugins** starts with all tools selected for a
fresh installation; turn off any plugin or individual tool you do not want.
Choose **Finish setup** to apply the selections, then **Start chatting**.
Complete initial setup on Home before opening other workspaces. Spark appears
when setup is ready; Computer access remains available throughout setup.
Saving chat connection details does not make a paid model request. Explicitly
checking an embedding model sends a small embedding probe to the chosen provider.

Command-line initialization remains available:

```bash
npx abot init --provider ollama --model <model-id>
npx abot init --provider openai --model <model-id>
```

For a remote Ollama server, add `--base-url http://<ollama-host>:11434`.
OpenAI profiles use the recommended `execution-agent-v1` policy. A gateway
managed by a separate process remains under that process's lifecycle; the UI
reports when saved changes require that owner to restart.

In the Web UI, open **Models → Add model** to add another model.
Choose a saved provider connection or create a new OpenAI/Ollama connection.
Each provider card also has an **Add model** shortcut. Review the model, then
choose **Save and apply**. Saved API keys are reused; existing model profiles and
the default model are preserved. The added model is selected in the Models list.
New profiles are stored in a separate `models/<profile-id>.config.json` beside
the selected Runtime configuration, which keeps only its `configRef`. Existing
inline profiles continue to work. If activation is deferred, the dialog confirms
that the model is saved but not active yet; **Apply model** retries activation
without adding it again, and **Close** keeps the saved declaration.

Use **Remove model** to remove a profile from the Runtime declaration. Referenced
model files, provider connections and credentials are retained. Files in the
standard `models/` directory, and directories still referenced by another
profile, appear as **Not registered**. Removal is refused if it would break the
configuration, such as a default model or a request-runner mapping. Update those
references first, then remove the profile and explicitly **Apply changes**.

You can also add a model from the command line:

```bash
npx abot add-model --profile <profile-id> --provider openai --model <model-id>
```

Add `--default` only to select that profile as the default. It does not delete
the profiles that are already configured.

### Optional Passive Long-Term Memory

Long-term memory is disabled by default. After a provider is configured, choose
an embedding model in the onboarding Embedding step, **Memory → Setup**,
or the CLI:

```bash
npx abot memory status
npx abot memory models --provider <provider-id>
npx abot memory enable --provider <provider-id> --model <embedding-model-id>
```

ABot does not install or choose the embedding model. The enable command performs
a real probe, writes config only after it succeeds, and reports that the Runtime
must be restarted. OpenAI users enter the embedding model id manually; Ollama
users can discover model ids installed at the configured Ollama endpoint.

See [Passive Long-Term Memory](long-term-memory.md) before enabling persistence.

### Computer Access During Setup

The optional **Computer** step and **Home → Computer access** manage one
Computer access connection shared by SYSTEM tools, ABot Spark and compatible
plugins. Direct native/WSL command access can already work; the shared companion
adds desktop access and background collection without a second ABot Spark setup.

When ABot runs natively on your Mac, open its local Web UI and choose **Connect
this Mac**. ABot uses its installed Node runtime and companion bundle, pairs the
computer and enables startup at sign-in. This path does not download a Finder
installer or require an Apple Developer account. Use **Repair Mac connection**
to repair or update an existing connection while retaining its pairing.

For a Mac connecting to a Docker or forwarded Runtime, choose **Connect a Mac**.
Install the ABot CLI on that Mac, run the displayed `abot host connect --url ...`
command in its graphical login, then paste the one-time code when Terminal asks.
The code expires after five minutes. Docker must publish the Web UI port on host
loopback; a remote Runtime needs a local port forward. Direct connections to a
remote network address are not supported. Mac desktop tools and Spark collection
still require local Swift tools and the relevant macOS privacy permissions.

**Spark permissions on macOS:** Computer access **Ready** confirms the connection;
collection additionally needs Accessibility permission. Companion setup keeps a
private copy of its Node executable at `~/.abot/host-companion/runtime/node` and
uses that same path at sign-in, independently of NVM version paths. Start Spark
collection to request consent, then authorize that executable in **System
Settings → Privacy & Security → Accessibility** (called **Device Control & Data
Access** on some macOS versions). Use **+**, **Command–Shift–G**, and the path above
if needed. The entry may be named `node`; verify the path before approving it.
The collector checks approval for at most two minutes without reading content.
After granting access, choose **Restart collection** in Home or Spark to check
again. Setup reuses identical runtime bytes; replacing the runtime can require
consent again. Screen recording and input permissions for other desktop tools
are separate.

For Windows or Linux, download setup and run it in that computer's graphical
login. Windows setup installs the companion and a private Node runtime; Linux
uses an existing Node.js installation. Setup pairs automatically and enables
startup at sign-in. Wait for **Ready** in the Web UI; downloading alone does not
establish a connection. WSL uses the same Windows companion setup, which does
not require changing interop settings or restarting the distribution.

Installation does not enable ABot Spark collection or disabled plugin tools.
Collection and processing controls remain in ABot Spark; tool approval modes still
apply. Use **Unpair computer** to revoke the shared pairing and pending setup
grants. Saved insights are retained. Reconnect through Computer access setup.
Updates reuse the existing pairing and must replace the actual running companion.

### Notifications

Open **Notifications** for saved notifications, unread counts, source links and
desktop notification settings. ABot records agent replies received while their
conversation is not visible and focused, failed requests, approval requests and
delivered ABot Spark suggestions. Settings control desktop delivery for each kind;
the history stays available when desktop delivery is disabled or disconnected.

Desktop notifications use the paired Computer access companion. The browser can
be closed while ABot and the companion keep running in your graphical login.
Install or update Computer access to register the **ABot** notification identity.
Clicking a notification opens its source in your default browser. Docker and WSL
use the companion on the desktop computer; links retain the address and published
port used during pairing.

- **Windows:** setup registers ABot with Windows notifications and a click handler.
- **macOS:** setup installs a local ABot application. Allow notifications for ABot
  in macOS settings when prompted. The helper currently uses Apple's legacy
  `NSUserNotification` API; availability depends on the macOS release.
- **Linux:** a graphical desktop with its notification service, `notify-send`
  (including action support), `gdbus` and `xdg-open` is required. The desktop's
  notification service must support actions. On Debian/Ubuntu, these commands
  come from `libnotify-bin`, `libglib2.0-bin` and `xdg-utils`, respectively.
  ABot keeps up to 32 active desktop alerts; when another arrives, it closes the
  oldest alert. All saved notifications remain available in Notifications.

Operating-system permissions and Do Not Disturb still control presentation.
**Sent to computer** means the native delivery call succeeded, not that a person
saw the notification. Unconfirmed deliveries and old records are not sent again
after reconnect or restart. A failed notification setup leaves the other Computer
access features available; the Notifications page reports desktop availability.

See [Connecting a Docker Runtime to its computer](projects-and-full-plus.md#connecting-a-docker-runtime-to-its-computer)
for connection limits and removal. Importing ABot as a library never changes host
configuration or starts background collection.

## Use As A Library

After the package is published:

```bash
npm install @abot-ai/runtime
```

Use only public exports from `package.json`:

```ts
import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createDefaultRuntimeDependencies(config);
```

For a complete host example, see
[`examples/runtime-library-host.ts`](../examples/runtime-library-host.ts).

The consumer owns its runtime root and machine-local configuration. The CLI
above creates the documented layout; library hosts may instead start from the
packaged examples:

```text
local/runtime.config.json
local/request-runner.config.json
local/models/default.config.json
```

Set `LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json` when the host process
does not pass `configPath` directly. Edit the copied provider and model profile
before starting the runtime; the package does not choose a model. For Ollama,
the provider `baseUrl` must be reachable from the consumer host and the model
profile must name the exact model id that consumer pulled.

The package includes the public plugin catalog. Additional consumer plugins may
be installed under `<consumer-root>/plugins`. A consumer plugin cannot replace
a bundled plugin: duplicate plugin ids fail closed.

The passive long-term memory service belongs to the Runtime core and does not
depend on the bundled `memory` plugin.

The bundled Web plugin supports URL fetching and Light search without a search
credential. Light searches a limited catalog of public Hebrew and English
sources directly; it does not query an external search engine or provide
whole-web coverage. Set `BRAVE_SEARCH_API_KEY` to use Brave Search instead.
A configured Brave key that fails remains a Brave error. See
[Known Limitations](known-limitations.md#web-search) for Light's discovery and
cache boundaries.

## Run From Source

```bash
git clone <repo-url>
cd abot
npm install
npm run init -- --provider ollama --model <model-id>
npm run build
npm test -- --run
```

The init command requires an explicit provider and concrete provider model id;
the runtime has no built-in model choice. For OpenAI, use
`npm run init -- --provider openai --model <model-id>`. The init step creates a
generic profile named `default` and is non-destructive by default; pass
`--force` only when you intentionally want to regenerate `.env`,
`local/runtime.config.json`, and the generated default model profile.
For Ollama outside the runtime process's loopback network, add
`--base-url http://<ollama-host>:11434`.

For Ollama, complete the service, pull, and API verification steps above before
starting the model gateway. Initialization only writes runtime configuration;
it does not provision the provider or model.

### Add Another Model

After initialization, add another provider or another profile without
replacing the existing configuration:

```bash
npm run add-model -- --profile <profile-id> --provider openai --model <model-id>
```

The profile id must be unique. If the provider already exists, its current
configuration is preserved. Add `--default` when the new profile should become
the request-runner default; all existing providers and profiles remain in
place. Set any required credential, such as `OPENAI_API_KEY`, in `.env`, then
restart the model gateway and Web UI. OpenAI profiles created by either setup
command include `execution.policy: "execution-agent-v1"`.

Provider connectivity is only the installation check. Before relying on a
model for real workloads, follow [Calibrating A Model By
Step](configuration.md#calibrating-a-model-by-step) to tune the exact model
profile without changing runtime policy or another model's settings.

The repository ignores `.env`, `local/runtime.config.json`, `.runtime/`, and
`dist/`. Do not commit local secrets or generated runtime state.

## Verify Package Surface

Before publishing or opening a release PR:

```bash
npm test -- --run
npm run build
npm run smoke:runtime-package
npm run check:runtime-package
npm run smoke:packed-runtime-package
git diff --check
```

`npm run build` regenerates `runtime.config.schema.json`, clears stale `dist`,
and compiles the published TypeScript declarations.

For the full public release checklist, see
[`docs/publishing.md`](publishing.md).
