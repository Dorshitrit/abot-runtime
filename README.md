# ABot Runtime

**Put your language model to work with tools, memory, and repeatable workflows.**

ABot Runtime is an open-source TypeScript engine for AI agents that work with
files, use tools, retain useful context, and carry out multi-step tasks.

**Work locally, with a model you choose.** Run Ollama on your own machine and
keep task data local when generation, memory embeddings, SPARK models, and the
tools you use are all local. Hosted models, remote endpoints, Web access, and
other external tools can send relevant data outside your machine.

Use the bundled Web UI as your everyday workspace, or embed the same runtime
in your own application. Connect a local or hosted model, choose how it should
work, and keep visibility into its actions and results.

[Website](https://abot-ai.com/) · [Get started](#get-started) · [Documentation](#documentation) · [Releases](https://github.com/Dorshitrit/abot-runtime/releases)

![ABot Studio starter templates for research, documents, and system review](https://abot-ai.com/_astro/studio-templates.CvsBi5Kw.png)

*Start from a Studio template, then choose your inputs, model, and permissions.*

## What can you do with ABot?

- **Research and produce something useful.** Compare public sources and save a
  sourced Markdown brief with findings and open questions.
- **Work with documents and projects.** Summarize a document, explain a code
  module, inspect configuration, or work with files using the enabled tools.
- **Automate recurring work.** Save a request as a scheduled Job, or build a
  reusable Studio workflow that processes inputs through several steps.
- **Build an agent into your product.** Reuse ABot's execution, session, tool,
  and event interfaces behind your own application.

These workflows use the models, plugins, credentials, and permissions you
configure.

## One engine, two execution routes

Different models benefit from different ways of working. ABot gives you two
routes within the same runtime:

| | Execution Agent (EA) | Supervisor (SUPER) |
|---|---|---|
| Designed for | Capable models that can take broader responsibility for a task | Models that benefit from smaller, focused responsibilities, including local models |
| How it works | The main agent selects and runs tools directly, with optional planning and audit advice | A Supervisor coordinates the request and delegates to Planner, Worker, and Reviewer roles when needed |
| Tool execution | Owned by the Execution Agent | Delegated to a Worker |

**EA gives capable models room to act. SUPER gives models a more structured
division of work.**

Both routes share tools, permission controls, conversations, persistence, and
execution infrastructure. Both can be used with local or hosted models.
Choose according to the model's capabilities and the tasks you want it to perform.

In the Web UI, select **Execution Agent** or **Supervisor** under a model's
**Execution route** setting. The choice belongs to the model profile.

Planning and review are available when needed; individual requests do not have
to pass through every role. Results still depend on the model, context window,
configuration, and available tools.

See [Configuration](docs/configuration.md#request-runner) for technical policy
names, defaults, and model calibration.

## Get started

You need:

- Node.js `^20.19.0` or `>=22.12.0`; Node.js 21 is not supported
- npm
- An OpenAI or Ollama model connection

Create a directory for your ABot installation:

```bash
mkdir my-abot
cd my-abot
npm init -y
npm install @abot-ai/runtime
npx abot start
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177).

The setup wizard guides you through connecting a provider, selecting a model,
choosing tools, and optionally enabling semantic memory.

- **OpenAI:** enter your API key and model ID.
- **Ollama:** install and start Ollama separately, download your chosen model,
  and provide an address reachable from the Runtime.

ABot includes the provider adapters. You supply the model and any required
credentials. Configuration and runtime state are stored in your project.

Prefer command-line setup or running from source?
See [Installation](docs/installation.md) and
[Running Locally](docs/running-locally.md).

## A workspace for everyday agent work

The included Web UI brings conversations, tools, models, and automation into
one place.

- Organize conversations and projects around working folders.
- Select models and their supported reasoning settings.
- Attach files and images, subject to model and tool support.
- Follow streaming responses, tool activity, results, and failures.
- Steer an active request, stop it, or queue the next message.
- Manage plugins, memories, schedules, and runtime configuration.
- Inspect persisted conversation history, request events, logs, and health.
- Review notifications and open the conversation or run behind them.

The default Web UI connects directly to the local Runtime. An external bridge
is optional.

## Tools you can use and extend

The bundled public plugins cover:

| Area | Capabilities |
|---|---|
| Files and documents | Read, create, and edit files; extract document content |
| Development | Inspect projects, code structure, and JSON configuration |
| Local search | Find relevant content in accessible files |
| Commands and systems | Execute commands, inspect system information, and discover or launch applications where supported |
| Web research | Fetch public pages and search supported sources |
| Explicit memory | Save and retrieve records through dedicated memory tools |

Select the plugins and tools available to your agent, then extend the catalog
with your own plugins through the public Plugin SDK.

Sensitive actions follow the selected approval mode. Tool availability also
depends on platform support, installed dependencies, and OS permissions.
Approved commands run with the Runtime user's OS authority; project folders
are not a shell sandbox.

For Web access:

- `web_fetch` retrieves a public HTTP(S) page without a search API key.
- `web_search` uses Brave Search when `BRAVE_SEARCH_API_KEY` is configured.
- Without a key, Light search discovers pages within a bounded catalog of
  public sources. Its coverage is more limited than a whole-web search engine.

See [Plugins](docs/plugins.md) and
[Projects and Permissions](docs/projects-and-full-plus.md).

## Turn repeated work into automation

### Scheduled conversation requests

Save a request to run later in its conversation, using its saved model and
permissions. Supported schedules include timers, one-time requests, intervals,
and daily, weekly, or monthly schedules.

Manage Jobs in the Web UI or through the model's built-in scheduling capability.
Each run leaves a record in its conversation.

The Runtime must be running when a Job is due. Missed offline occurrences and
failed runs are not retried automatically.

### ABot Studio

Build reusable workflows in a visual editor by combining tool and agent steps.

Studio supports:

- Sequential steps and parallel branches
- Connected inputs and reusable saved agents
- Starter templates for research, documents, development, and operations
- Manual runs, schedules, and folder polling
- Retained step outputs and execution records
- Separate draft, publication, activation, pause, and stop controls

For example, turn incoming documents into briefs, compare several sources,
or run a repeatable project inspection.

Conversations can help create and edit workflow drafts. Publication, activation,
and execution remain separate actions.

## Memory that carries useful context forward

Optional long-term memory helps retain selected facts and preferences across
conversations. Inspect, edit, and delete saved records from the Web UI.

Passive memory is disabled by default and requires an embedding model you
select. Configure it during setup or under **Memory → Setup**.

The explicit memory plugin is a separate tool-based option and does not require
passive memory to be enabled.

Runtime storage is local. Data sent for generation or embeddings is processed
by the provider you configure.

See [Long-Term Memory](docs/long-term-memory.md).

## SPARK: optional help from computer activity

SPARK adds learning from authorized computer activity and proactive suggestions
in its own persistent conversation.

Use it to surface possible next steps from the context you allow it to observe.
A saved suggestion can open a regular work conversation with its retained
context; opening it does not start the work automatically.

Collection requires explicit consent. Collection, learning, and proactive
messages have separate controls, with application exclusions and usage limits.
Collection and proactive messages are off by default.

Collected content may be sent to the learning model provider you select.

On native Windows, SPARK collection runs locally without Companion pairing.
Other deployment arrangements may require the shared Computer access setup
and platform permissions.

See [SPARK and computer-activity learning](docs/long-term-memory.md#learning-from-computer-activity)
and [Computer access setup](docs/installation.md#computer-access-during-setup).

## Embed the same engine in your application

Use ABot as a TypeScript library when you want your own interface, transport,
or application lifecycle.

Compose the default services through the public API:

```ts
import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createDefaultRuntimeDependencies(config);
```

This creates the service composition. Your host supplies startup, shutdown,
and application integration, including a configured model gateway connection.

Use the default services or provide adapters for models, session storage,
tools, attachments, and events.

See the [complete host example](examples/runtime-library-host.ts),
[Runtime Library guide](docs/runtime-library.md), and
[public contracts](docs/runtime-public-contracts.md).

## Platforms and current scope

ABot is available as an npm package with a browser-based Web UI on Windows,
Linux, and macOS, with separate WSL and Docker setup paths.

The [1.8.0 release](https://github.com/Dorshitrit/abot-runtime/releases/tag/v1.8.0)
includes native Windows support for the Runtime and the documented operations of
its bundled plugins. SYSTEM provides commands and application discovery and
launch; desktop observation and input (`computer_*`) are unavailable on native
Windows. Tool requirements, permissions, and limits still apply.

The separate desktop shell remains in QA and is not included in npm or the
public source snapshot.

ABot Runtime is an early-stage project. The documented package exports define
its supported API; internal source paths may change between releases.

See [platform-specific plugin support](docs/plugins.md#native-windows-plugin-support)
and [Known Limitations](docs/known-limitations.md).

## Documentation

| Goal | Guide |
|---|---|
| Install ABot or run from source | [Installation](docs/installation.md) |
| Configure local services | [Running Locally](docs/running-locally.md) |
| Select models and execution policies | [Configuration](docs/configuration.md) |
| Use and build plugins | [Plugins](docs/plugins.md) |
| Understand projects and permissions | [Projects and FULL+](docs/projects-and-full-plus.md) |
| Configure memory and SPARK | [Long-Term Memory](docs/long-term-memory.md) |
| Embed the runtime | [Runtime Library](docs/runtime-library.md) |
| Understand the engine | [Architecture](docs/architecture.md) |
| Check operational boundaries | [Known Limitations](docs/known-limitations.md) |
| Diagnose setup and runtime issues | [Troubleshooting](docs/troubleshooting.md) |

## Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

ABot Runtime is available under the [MIT License](LICENSE).

## Acknowledgements

**Product direction and architecture by humans. Code, tests, and documentation
by OpenAI Codex.**
