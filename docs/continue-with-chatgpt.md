# Continue with ChatGPT

ABot can use a connected ChatGPT account through OpenAI's official Sign in with
ChatGPT flow. This is separate from the existing OpenAI API-key connection.
Eligibility, available models and usage limits are determined by OpenAI.

## Connect a local installation

Run ABot and open its Web UI on the same computer. Choose **Continue with
ChatGPT** during initial setup or when adding a model in **Models**. Complete
OpenAI's sign-in and consent page, return to ABot, select the account and model,
and review the model's context capacity and reasoning support before saving.
ABot does not infer these settings from a model name. Model discovery uses the
selected account's catalog and does not generate a response.

The browser callback uses `http://127.0.0.1:<temporary-port>/auth/callback`.
Windows with a WSL-hosted Runtime requires Windows-to-WSL localhost forwarding
for that temporary port. Native Windows uses the same local callback flow.
Remote-server, bridge and remote-browser sign-in are outside this first version.
Existing API-key connections remain available for those deployments. If account
loading fails, the interface keeps the error visible until an explicit retry;
the rest of the connection form remains editable.

### Docker on the same computer

Publish the Web UI only on the host's loopback interface, for example
`-p 127.0.0.1:5196:5177`, and set `ABOT_WEB_TRUST_LOOPBACK_PUBLISH=1` with the
container listener on `0.0.0.0`. Open `http://127.0.0.1:5196` in the host browser.
ChatGPT sign-in then returns to `/auth/callback` on that published port, so no
additional callback port or host-network mode is needed. The published port can
differ from the listener port. This route applies to Docker on macOS, Linux and
Windows; direct local installations retain their temporary loopback listener.

The trust flag is the deployment owner's assertion that publishing is restricted
to loopback. Do not use it for a LAN/public listener or an external reverse proxy.
Account management still requires local authority and same-origin requests.
OAuth returns are tied to one pending attempt and its exact callback address.
Persist the Runtime user's `.abot/provider-auth` directory in a private Docker
volume if accounts must survive replacing the container; never include it in an
image or copy credentials from another installation.

The account may be connected without permission to use the ChatGPT plan. ABot
keeps that account but requires plan permission before adding or using its model.
The interface shows **Using ChatGPT plan** for this provider and provides
**Manage usage** and **Disconnect**. There is no automatic fallback to API billing.

## Credentials and account identity

Credentials are kept by the Runtime under the operating-system user's home:
`.abot/provider-auth/chatgpt/accounts.json`. The directory and file are private
to the local user (with the platform's administrative access retained on Windows).
They are not stored in the project, runtime configuration, browser storage,
conversation history or model-I/O trace. Do not copy this directory into a
repository or share it with another installation.

Each provider stores only an opaque `settings.accountRef` pointing to its saved
registration. Accounts with the same email but different registrations remain
separate. Windows and WSL installations maintain their own host identity and
credential store. Refreshes are serialized and replacement credentials are saved
before use. Temporary network failures do not delete the saved account.

Disconnect removes local tokens and attempts to revoke the refresh token at
OpenAI. ABot reports when remote revocation could not be confirmed. The saved
registration remains available for later sign-in; future model calls cannot use
it until connected again. A response stream already underway may finish.

## Provider behavior

The adapter identifier is `openai-chatgpt`. It uses the official Responses
endpoint with streaming and `store: false`, and accepts a response only after
`response.completed`. OpenAI API-key providers retain their existing behavior.

EA and SUPER retain their orchestration, tools, canonical history and compaction
state. Only the outgoing SIWC representation changes: system instructions become
developer messages in their original positions; existing forced function schemas
are supplied using `additional_tools`. No credentials enter model context.

The ChatGPT adapter advertises neither embeddings nor exact provider input-token
counting. It uses the existing input-size estimator and the explicitly configured
context capacity. Configure embeddings separately if needed. Custom API origins,
API-key overrides and unsupported SIWC request fields are not forwarded.

## Official references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
