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
