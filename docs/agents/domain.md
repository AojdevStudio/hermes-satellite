# Domain docs

This repository uses a single domain context.

## Before exploring

- Read the root `CONTEXT.md` when it exists.
- Read relevant decisions under `docs/adr/` when that directory exists.
- Proceed silently when either location is absent; the domain-modeling workflow creates them only when terminology or durable decisions have actually crystallized.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── apps/
```

Use canonical terms from `CONTEXT.md` in issues, specifications, code, and user-facing documentation. Surface conflicts with an existing ADR rather than silently overriding them.
