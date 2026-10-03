# NanoClaw security model

NanoClaw runs a Node host that routes messages, owns channel credentials and
administrative state, and starts agent containers. Each session exchanges
messages with the host through separate inbound and outbound SQLite databases.
An incoming message, a document, and a tool result are untrusted input to the
agent, even when they appear in an authorized chat.

## Access and isolation

- The central database stores users, roles, group membership, wiring, and
  configuration. Host-side access checks decide who may address a group and
  which administrative commands a user may issue. See
  [isolation model](isolation-model.md).
- Each session has its own container and session databases. A container can
  read or write only its configured mounts. Additional mounts are validated
  against a host-side allowlist, including symlink and path checks.
- Shared skills and agent-runner code are mounted read-only. A group's
  workspace and selected stores are writable. Review each group's mounts and
  `cli_scope` before exposing it to untrusted participants.
- Container limits such as `no-new-privileges`, capability drop, PID limits,
  and per-group egress filtering are configurable hardening options. They are
  not all enabled by default.

Container isolation is the execution boundary. The default Codex provider
uses `danger-full-access` and `approval_policy = "never"` **inside its
container**, so Codex can act without another approval prompt on anything
mounted into that container. This is a reason to keep mounts narrow and apply
the per-group hardening profile where appropriate. It is not a claim that
untrusted agent output is safe.

## Credentials and network

The default credential path is the OneCLI gateway: the host configures a
per-group agent identity and the gateway injects matching credentials when a
request is made. The container receives proxy configuration and any gateway
stubs it needs, rather than the raw vault credentials. An optional
`use-native-credential-proxy` skill deliberately changes this model by passing
Anthropic credentials from the host's `.env` into container environment
variables. Do not enable that option unless its tradeoff is acceptable.

Direct internet egress is possible by default. Setting
`NANOCLAW_EGRESS_LOCKDOWN=true` places agents on an internal Docker network
with the OneCLI gateway as the reachable hop. A per-group hardening profile
can instead use a dedicated internal network and an allowlisting filter.
Both modes refuse to spawn when their required network topology cannot be
created. See [build and runtime](build-and-runtime.md) for host/container
details.

## Ops Center

Ops Center is an administrative UI. It binds to `127.0.0.1`. Host checks
restrict accepted `Host` values; mutating actions also require a page action
token and an allowed `Origin`. These checks are defenses for a local admin
surface, not a user login system. Any reverse proxy or remote access path
must enforce its own authentication and transport security. Add only trusted
proxy names to `trustedHosts`.

## Dependency and release controls

The host uses pnpm with a three-day minimum release age and a restricted
build-script allowlist in `pnpm-workspace.yaml`. CI uses frozen lockfiles.
Changing the release-age exceptions or allowing another package to run an
install script requires human review. The container agent-runner has a
separate Bun lockfile and must be checked separately.

This public source snapshot has fresh Git history. Runtime databases,
instance configuration, private templates, and historical private blobs do
not belong in a public source export. The [public export process](public-export.md)
describes the verification gate for later updates. Secret scans and dependency
audits are useful checks but do not replace review of permissions, mounts,
workflows, and release media.

To report a security issue, use a private maintainer contact or GitHub's
private vulnerability reporting if enabled for the repository. Do not put
credentials, private chat contents, or exploit details in a public issue.
