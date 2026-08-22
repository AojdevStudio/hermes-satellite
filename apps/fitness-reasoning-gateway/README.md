# Fitness reasoning gateway

Narrow Private Mode adapter from the personal Fitness iOS app to the existing
Hermes Task Engine.

## Contract

`POST /v1/reasoning` accepts only:

- readiness state
- flagged readiness markers
- training phase
- the already-generated prescription summary

It returns only:

- `summary`
- `signals`
- `cautions`

There is no prompt, callback, model, tool, session, or mutation field. Fitness's
deterministic generator remains authoritative; Hermes may explain its output but
cannot alter it through this adapter.

## Security and privacy

- The gateway binds to loopback. Tailscale Serve terminates private HTTPS.
- The iOS device receives a gateway-specific token, never the Hermes bearer.
- Both tokens are read from owner-only files and are absent from source,
  launchd configuration, logs, and responses.
- Requests contain no raw biometric measurements or HealthKit samples.
- v0 allowlists the current `Lower Strength A` fixture and its exercise names;
  expand that list only when another deterministic app prescription is enabled.
- v0 creates a fresh Hermes task per explanation and exposes no continuation.
  The app stores no Hermes session identifier and does not opt into Hermes
  memory as product state.
- Responses use `Cache-Control: no-store`.
- Every task explicitly targets the dedicated `fitness` Hermes profile. Its
  committed profile artifact has no credentials, skills, tools, MCP servers,
  external memory, delegation, or UI/code authority. The host install uses the
  existing shared OpenAI Codex login.

## Fitness profile

The governed profile artifact lives in `profile/`. Deploy it with the native
Hermes profile mechanism:

```bash
hermes profile create fitness --no-skills --no-alias
install -m 600 profile/config.yaml ~/.hermes/profiles/fitness/config.yaml
install -m 600 profile/SOUL.md ~/.hermes/profiles/fitness/SOUL.md
install -m 600 profile/.no-bundled-skills ~/.hermes/profiles/fitness/.no-bundled-skills
rm -f ~/.hermes/profiles/fitness/.env
```

The final command ensures the profile uses only the host's shared OpenAI Codex
login; no credential file is copied or committed. Before enabling the gateway,
resolve the profile's CLI tool surface and require zero tool definitions.

## Local checks

```bash
python3 -W error::ResourceWarning -m unittest test_fitness_reasoning_gateway.py
```

The launchd template is
`com.aojdevstudio.fitness-reasoning-gateway.plist`. Its only machine-specific
runtime dependency is the existing Hermes bridge token file.
