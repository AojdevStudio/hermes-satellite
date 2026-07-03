# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest on `main` | yes |

## Reporting a vulnerability

**Do not** open a public GitHub issue for security-sensitive reports.

If you believe you have found a security issue in Hermes Satellite (bridge auth, token handling, transcript exposure, MCP tool abuse, or similar):

1. Use [GitHub private vulnerability reporting](https://github.com/AojdevStudio/hermes-satellite/security/advisories/new) if enabled, **or**
2. Contact the maintainers through a private channel you already use with the project.

Please include:

- A clear description of the issue and impact
- Steps to reproduce
- Affected files, endpoints, or versions
- Any proof-of-concept you are comfortable sharing

We aim to acknowledge reports within a few business days.

## Operator responsibilities

Hermes Satellite is designed around a **private bridge** on your tailnet or LAN. Before exposing any deployment:

- Never commit `.env`, tokens, API keys, or bridge bearer secrets
- Bind the bridge to an explicit Tailscale/LAN address — not `0.0.0.0` without additional network controls
- Rotate `HERMES_ASYNC_BRIDGE_TOKEN` / `HERMES_MCP_TOKEN` if a leak is suspected
- Treat Hermes transcripts as sensitive operational data
- Run smoke tests from a **separate** client node: unauthenticated MCP initialize must fail

## Safe defaults in this repo

- `.env` and secret patterns are gitignored
- Documentation uses placeholder hosts (`100.x.x.x`) instead of live infrastructure
- Internal research artifacts and operator handoffs are excluded from the published tree

## Automated checks

Pull requests run local CI (`just check`) and secret scanning. These reduce accidental leaks but do not replace careful review before making the repository public or changing bridge exposure.
