# Publishing

This checklist covers the repo state expected before opening `abot` as a
public Git repository or publishing a package artifact.

The private development checkout is the canonical product source. Its
`package.json` sets `private: true`, so direct `npm publish` is blocked. Every
public Git and npm release must be created from a freshly built and verified
public snapshot of one exact private commit. Never copy or publish the private
checkout directly, and never develop or hotfix product changes in the public
repository.

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
npm run check:public-snapshot
```

`check:runtime-package` validates the packed artifact. `check:publication`
validates public repo hygiene. `check:public-snapshot` verifies every payload
file against `PUBLIC-SNAPSHOT.json`; the public `npm run validate` chain runs
all three checks. For a public package, the packed-artifact check also rejects
any plugin set other than the exact public allowlist.

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
- `src/runtime/README.md`
- `examples/minimal-runtime-composition.ts`
- `examples/runtime.config.example.json`
- `examples/request-runner.config.example.json`
- `plugins/`

Example config must stay sanitized and must not include host-specific URLs
except local development defaults.

## 6. Build A Fresh Snapshot For Every Release

Select one clean, synchronized, fully tracked private commit. Validate it, then
build a new snapshot into a fresh empty directory:

```bash
npm run validate
npm run build:public-snapshot -- --output /absolute/path/to/empty/public-snapshot
```

`build:public-snapshot` is a private-source export command. It is intentionally
absent from the exported public package. Run it again for every release; do not
reuse or edit an older snapshot.

The generated `PUBLIC-SNAPSHOT.json` records the exact exported tree. Validate
the snapshot itself before producing a package artifact:

```bash
cd /absolute/path/to/empty/public-snapshot
npm ci --ignore-scripts
npm run validate
npm pack
```

If validation finds a defect or an incomplete dependency closure, stop and fix
it in the private canonical repository. Validate that change there and generate
a completely new snapshot. Do not patch the generated snapshot in place.

## 7. Validate And Promote The Frozen Artifacts

Install the exact tarball from the verified snapshot into a fresh consumer
project. Exercise the installed binary, not a source-tree fallback:

```bash
npm install /absolute/path/to/abot-ai-runtime-<version>.tgz
npx --no-install abot --help
```

Also verify empty-config Web UI onboarding, non-destructive provider/profile
addition, default-profile selection, and the packaged Web UI. For an upgrade,
install the candidate tarball over a real prior-version consumer without
rerunning init and confirm that its local config remains unchanged.

The public repository is a generated distribution projection, not an
independent maintenance branch. Promote only the contents of the verified
snapshot. Any proposed public-repository fix must first return to the private
canonical repository and pass the complete flow again.

Publishing the frozen snapshot, running `npm publish`, pushing a public tag, and
creating a GitHub Release are separate external mutations. Perform them only
after explicit authorization names the exact private commit, snapshot tree,
tarball, and version. Never overwrite a version already published to npm; a
post-release defect ships from a new private commit under a new semantic
version.
