# Contributing

## Development Setup

```bash
npm install
npm run init -- --provider ollama --model <model-id>
npm run build
```

Use `npm run init -- --provider openai --model <model-id>` when your local
default model provider should be OpenAI instead of Ollama.

## Validation

Before opening a change:

```bash
npm test -- --run
npm run build
npm run smoke:runtime-package
npm run check:runtime-package
npm run smoke:packed-runtime-package
npm run check:publication
git diff --check
```

## Canonical Source And Public Distribution

Make product changes in the private `llm-runtime` repository. The public
`abot-runtime` repository is a generated distribution snapshot, not an
independent development branch. Do not implement or hotfix a product change
directly in the public repository.

Every public release is generated again from one clean, validated private
commit. If a public-package or snapshot defect is found, fix and validate it in
the private source, then build a fresh snapshot. Never patch or reuse an older
generated snapshot. Publishing the snapshot, npm package, tag, or GitHub Release
requires separate explicit authorization after the exact artifacts are frozen.

## Runtime Core Rules

- Keep runtime core mechanism-only.
- Do not encode observed transcripts or scenario-specific tool sequences.
- Keep routing, recovery, progress, and finalization separated.
- Put tool-specific behavior in tool modules, adapters, or filesystem-facing
  layers.
- Keep plugin behavior outside orchestration.

## Generated And Local Files

Do not commit local runtime output or machine-specific config:

- `.env`
- `runtime.config.json`
- `local/runtime.config.json`
- `.runtime/`
- `logs/`
- `sandbox/`
- `sessions/`
- `dist/`
