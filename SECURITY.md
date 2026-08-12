# Security policy

Cloudflare Fleet is an operator control plane that can hold sensitive configuration evidence and can exercise the permissions of its configured Cloudflare API token. Treat suspected boundary failures, authorization bypasses, secret exposure, unsafe write plans, persistence races, and verification gaps as security issues.

## Supported versions

Security fixes target the latest release and the default branch. Older releases may not receive backports.

## Reporting a vulnerability

Do not open a public issue. Use the repository Security tab and select "Report a vulnerability" to start a private report through GitHub Private Vulnerability Reporting. If that option is unavailable, contact the maintainer through an established private channel and ask for a secure reporting path without including exploit details in the first message.

Include the affected version or revision, deployment mode, trust boundary, reproduction steps, impact, and any proposed mitigation. Use synthetic data wherever possible. Never send a live Cloudflare API token, Access token, state file, Wrangler configuration, D1 export, audit report, browser trace, or real-account screenshot.

The maintainer will acknowledge a usable private report, investigate it, coordinate a fix and disclosure where appropriate, and credit the reporter unless anonymity is requested. Response timing depends on severity and maintainer availability.

## Security boundaries

Hosted deployments rely on Cloudflare Access plus independent Worker JWT validation, an encrypted Worker secret, a fixed account boundary, backend-enforced read-only mode, explicit proxy allowlists, zone ownership checks, bounded request bodies and upstream duration, same-origin mutation checks, schema validation, and D1 transactions.

Local deployments rely on loopback-only binding, a random session capability, origin checks, private runtime and state file modes, schema validation, serialized atomic persistence, and liveness-bound cleanup. Debug mode deliberately weakens the isolated browser profile and should not be used for unrelated browsing.

The local CLI and stdio MCP server inherit the Cloudflare API token directly and therefore belong inside the trusted operator boundary. They expose named fleet operations rather than arbitrary API requests, bind apply to a freshly regenerated plan digest, serialize local writes, and keep the token out of tool inputs and outputs. MCP apply additionally requires authenticated short-lived confirmation state plus explicit approval of the exact digest. Keep agent configuration, state, audit reports, plans, activity, and process output private.

See [docs/security.html](docs/security.html) for the complete threat model, data classification, credential flow, and write-safety architecture.
