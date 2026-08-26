# Troubleshooting

## `runtime.config.json` Is Missing

The default config file is optional. For local development, prefer an ignored
local config:

```bash
npm run init -- --provider ollama --model <model-id>
```

## Model Gateway Returns 500

Check whether the configured provider is installed, running, and reachable.
ABot Runtime provides the Ollama adapter; it does not install the Ollama server
or download model weights.

For Ollama, install it from the
[official download page](https://ollama.com/download), make sure its service is
running, and then pull the exact model id used by the runtime profile before
checking the API:

```bash
ollama pull <model-id>
curl http://127.0.0.1:11434/api/tags
```

Confirm that the response lists the same `<model-id>` configured in the model
profile. `127.0.0.1` is the runtime process's own loopback network; it is not
automatically the Windows host from WSL, the container host from inside a
container, or a remote Ollama machine. In those layouts, pass an address
reachable from the runtime to the initializer with
`--base-url http://<ollama-host>:11434`, or update
`models.providers.ollama.baseUrl` in existing runtime config. Run the
`/api/tags` check against that URL.

See [Running Locally](running-locally.md#ollama) for the complete Ollama setup
sequence.

Check gateway logs:

```bash
tail -n 100 .runtime/shared/logs/model-gateway.jsonl
```

If `MODEL_GATEWAY_TRACE_FILE` is set, read that file instead.

## Missing OpenAI API Key

Set the key in the environment, not in JSON config:

```bash
OPENAI_API_KEY=...
```

Provider config should contain only the env var name:

```json
{
  "type": "openai",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

## Runtime Connects But App Requests Do Not Arrive

The runtime bridge client connects outbound to `agentBridgeUrl`. Make sure the
bridge server is running, the URL is correct, and `AGENT_BRIDGE_TOKEN` matches
the bridge configuration when auth is enabled.

## Dev And Prod Use The Same State

Check the active profile:

```bash
echo "$LLM_RUNTIME_PROFILE"
```

Use environment profiles to isolate state:

```json
{
  "environment": {
    "default": "prod",
    "profiles": {
      "prod": {
        "paths": {
          "runtimeDir": ".runtime/prod",
          "agentWorkDir": ".runtime/prod/agent-work"
        }
      },
      "dev": {
        "paths": {
          "runtimeDir": ".runtime/dev",
          "agentWorkDir": ".runtime/dev/agent-work"
        }
      }
    }
  }
}
```

## Package Smoke Checks Fail

Run the checks from a clean working tree after building:

```bash
npm run build
npm run smoke:runtime-package
npm run check:runtime-package
npm run smoke:packed-runtime-package
```

Do not publish if package checks include `.env`, `local/runtime.config.json`,
tests, source maps, local runtime state, or model-gateway server internals.
