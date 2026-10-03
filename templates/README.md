# Templates

Local agent-template library for this NanoClaw install. **This folder ships
empty.** Anything you drop here is a template you can stamp into an agent:

```bash
ncl groups create --template <relative-ref> --name "My Agent"
```

`<relative-ref>` is a path *relative to this folder* (e.g. `sales/sdr`). Refs
must stay inside this directory — absolute paths, `~`, and `../` escapes are
rejected. Override the location with `NANOCLAW_TEMPLATES_DIR=/another/local/path`
(a local path only — never a URL).

The setup wizard's **Template setup → NanoClaw template library** option clones
the public registry and copies your chosen template *into this folder*, after
which it stamps from the local copy. **Local templates** lists whatever is here.

## Anatomy of a template

Current templates use the Agent Plugins 1.0.0 layout. A legacy
`context/instructions.md` layout remains supported for older local templates.

For private, installation-specific derivatives, use a clearly marked subtree
such as `templates/private/`. Keep it generic: never place household facts,
credentials, private paths, destinations, schedules, or memory contents in the
template.

```
<template>/
├── plugin.json                 # REQUIRED Agent Plugins 1.0.0 manifest
├── ai.nanoco.nanoclaw/
│   ├── context/instructions.md # persona, prepended every spawn
│   └── tasks/*.md              # optional; stamped paused
├── mcp.json                    # optional MCP launch config, NO secrets
├── skills/<name>/              # optional SKILL.md + references/, mounted live
├── README.md                   # recommended per-template docs
└── ...                         # optional plugin components
```

Notes:
- A template reference is recorded in the group, while instructions, context,
  and skills are mounted read-only from the checked-out source on each spawn.
  The plugin copy and ownership hashes remain as recovery/provenance artifacts.
- Extra context preserves its layout relative to `instructions.md`
  (`context/additional_context/faq.md` → `additional_context/faq.md` in the
  agent's workspace). Nothing is referenced automatically — `instructions.md`
  must point to each file (e.g. "Pricing rules live in
  `additional_context/pricing.md`").
- Legacy `runtime.json` may declare app/runtime paths. Agent Plugin templates
  should keep runtime ownership explicit and avoid personal mounts.
- **No provider, no model, no packages.** A template is instructions + MCP
  servers + skills. The agent's runtime/provider is chosen separately
  (`ncl groups config update --provider …` or during setup).
- **No secrets.** `.mcp.json` carries launch config only; credentials are
  injected by the credentials proxy at request time. If an MCP server refuses
  to boot without an env var, use a placeholder value — never a real key.
- Skills are source-backed and mounted into the agent's provider-specific skill
  surface. They are never writable from the container.

An application template may also declare an `ops-center.json` contribution.
NanoClaw discovers it at Ops Center startup and supplies only the common hosting
boundary; the template owns its application page, assets, lifecycle, and API.
This keeps application code out of the NanoClaw dashboard while allowing the
application to appear as a normal Ops Center tab.
