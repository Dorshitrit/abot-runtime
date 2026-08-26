# Publishing

This checklist covers the repo state expected before opening `abot` as a
public Git repository or publishing a package artifact.

The private development checkout is not a release source: its `package.json`
sets `private: true`, so direct `npm publish` is blocked. Every public Git
repository and npm release must be created from a freshly built and verified
public snapshot. Never copy or publish the private checkout directly.

## 1. Public Metadata

Keep `package.json` metadata current:

- `description`
- `license`
- `keywords`
- `engines.node`
- public `exports`
- package `files`

Add the real public repository URL after the new public repository exists. Do
not publish placeholder repository, bugs, or homepage URLs.

## 2. Local Init Flow

A fresh source checkout should be able to start with:

```bash
npm install
npm run init -- --provider ollama --model <model-id>
```

`npm run init` must create only local ignored files:

- `.env`
- `local/runtime.config.json`
- `local/request-runner.config.json`
- `local/models/default.config.json`
- `.runtime/compiled`
- `.runtime/shared/logs`
- `.runtime/prod`
- `.runtime/dev`

It must not commit or generate secrets. The provider and model are explicit;
use `npm run init -- --provider openai --model <model-id>` for OpenAI.

## 3. Secrets And Generated State

Before publishing, confirm the repository does not include:

- `.env`
- `runtime.config.json`
- `local/runtime.config.json`
- `.runtime/`
- `logs/`
- `sessions/`
- `dist/`
- `memory/`
- `*.bak`
- `*:Zone.Identifier`

Secrets are referenced by environment variable name only, for example
`OPENAI_API_KEY` and `AGENT_BRIDGE_TOKEN`.

## 4. Package Surface

The public library surface is the package `exports` map. Hosts should not import
internal runtime files directly. The installed command surface is the `abot`
binary with its documented `init`, `add-model`, and `start` commands.

Source-checkout scripts such as `npm run dev`, `npm run model-gateway`, and
`npm run web-ui` are repository tooling; they are not installed CLI commands.
Package consumers should use `npx abot`.

Inside the verified public snapshot, run:

```bash
npm run check:runtime-package
npm run check:publication
```

`check:runtime-package` validates the packed artifact. `check:publication`
validates public repo hygiene. For a public package, the packed-artifact check
also rejects any plugin set other than the exact public allowlist.

## 5. Examples And Docs

Keep these public onboarding files in sync:

- `README.md`
- `docs/installation.md`
- `docs/configuration.md`
- `docs/running-locally.md`
- `docs/architecture.md`
- `docs/bridge-compatibility.md`
- `docs/known-limitations.md`
- `docs/plugins.md`
- `docs/troubleshooting.md`
- `examples/minimal-runtime-composition.ts`
- `examples/runtime.config.example.json`
- `plugins/`

Example config must stay sanitized and must not include host-specific URLs
except local development defaults.

## 6. Initial Public Repository Export

From a clean, fully tracked private checkout, build a new snapshot into an
empty directory:

```bash
npm run validate
npm run build:public-snapshot -- --output /absolute/path/to/empty/public-snapshot
```

`build:public-snapshot` is a private-source export command. It is intentionally
absent from the exported public package and must not become part of the public
repository's normal development workflow.

Use the snapshot once to seed the public Git repository. The generated
`PUBLIC-SNAPSHOT.json` records that export; ordinary public changes do not
rewrite or verify its frozen file hashes.

## 7. Public Repository Releases

After the initial export, maintain and release directly from the public Git
repository:

```bash
npm ci
npm run validate
npm pack --dry-run
```

The public package explicitly sets `private: false`; the private development
checkout explicitly sets `private: true`. Public `check:publication` validates
the current repository rather than the initial export receipt. Tag or run
`npm publish` only after current-tree validation and artifact review succeed on
the real release machine.
