#!/usr/bin/env bash
# Shared helpers for the host-side provider re-authentication scripts.
#
# This file is sourced by the provider re-authentication scripts.
# It is intentionally not a general-purpose credential library: the callers
# pass only fixed provider values and this helper never prints secret values.

reauth_die() {
  echo "ERROR: $*" >&2
  exit 1
}

reauth_require_command() {
  command -v "$1" >/dev/null 2>&1 || reauth_die "'$1' is not on PATH."
}

# Host-side NanoClaw tooling is pinned to Node 22 because better-sqlite3 is a
# native addon. The interactive shell may expose a newer Node, so reauth
# scripts must use the same resolver as pnpm scripts instead of calling `node`
# directly. The fallback keeps this helper usable in isolated tests that source
# this file without a project root.
reauth_node() {
  local project_root="${NANOCLAW_PROJECT_ROOT:-}"
  if [ -n "$project_root" ] && [ -x "$project_root/scripts/run-node22.sh" ]; then
    "$project_root/scripts/run-node22.sh" "$@"
  else
    node "$@"
  fi
}

reauth_require_node() {
  reauth_node --version >/dev/null 2>&1 || reauth_die "NanoClaw requires a supported Node 22 runtime. Install Node 22.19+ and retry."
}

# Print IDs for secrets that plausibly belong to the requested provider. The
# OneCLI list endpoint does not include secret values, so this is safe to use
# for selection. Matching is deliberately broad, then the caller refuses to
# guess when more than one result exists.
reauth_matching_secret_ids() {
  local provider="$1"
  onecli secrets list | reauth_node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const provider = process.argv[1];
    const rows = JSON.parse(raw).data;
    if (!Array.isArray(rows)) process.exit(0);
    const matches = rows.filter((row) => {
      const name = String(row.name ?? "").toLowerCase();
      const type = String(row.type ?? "").toLowerCase();
      const host = String(row.hostPattern ?? row.host_pattern ?? "").toLowerCase();
      if (provider === "codex") {
        return name === "codex" || name === "openai" || type === "openai" || host.includes("openai.com") || host.includes("chatgpt.com");
      }
      if (provider === "openrouter") {
        return name.includes("openrouter") || host.includes("openrouter.ai");
      }
      return name === "anthropic" || type === "anthropic" || host.includes("anthropic.com");
    });
    for (const row of matches) {
      if (row.id != null) process.stdout.write(String(row.id) + "\n");
    }
  } catch {
    process.exitCode = 1;
  }
});
' "$provider"
}

# Resolve a single existing secret. An explicit ID is always accepted so the
# operator can disambiguate multiple OpenAI/Anthropic secrets safely.
reauth_select_secret_id() {
  local provider="$1"
  local requested_id="${2:-}"
  if [ -n "$requested_id" ]; then
    printf '%s\n' "$requested_id"
    return 0
  fi

  local ids count
  ids="$(reauth_matching_secret_ids "$provider")" || reauth_die "could not read the OneCLI secret list. Is OneCLI running?"
  count="$(printf '%s\n' "$ids" | awk 'NF { n++ } END { print n + 0 }')"
  if [ "$count" -eq 0 ]; then
    printf '%s\n' ''
    return 0
  fi
  if [ "$count" -gt 1 ]; then
    cat >&2 <<EOF
Found $count possible $provider secrets in OneCLI, so I will not guess which one to replace.

Run this to inspect the non-secret metadata:
  onecli secrets list

Then run this script again with the exact ID:
  $0 --secret-id <ID>
EOF
    exit 2
  fi
  printf '%s\n' "$ids"
}

reauth_upsert_file_secret() {
  local secret_id="$1"
  local name="$2"
  local type="$3"
  local file="$4"
  local host_pattern="$5"

  [ -s "$file" ] || reauth_die "credential file is missing or empty: $file"
  if [ -n "$secret_id" ]; then
    # OneCLI's update command currently accepts a value, not --file. The
    # value is passed directly from this process to the local OneCLI CLI; it is
    # never written to shell history, logs, Ops Center, or chat.
    local value
    value="$(<"$file")"
    onecli secrets update \
      --id "$secret_id" \
      --value "$value" \
      --host-pattern "$host_pattern" \
      >/dev/null \
      || reauth_die "OneCLI could not update secret $secret_id."
    echo "Updated the existing OneCLI secret: $secret_id"
  else
    onecli secrets create \
      --name "$name" \
      --type "$type" \
      --file "$file" \
      --host-pattern "$host_pattern" \
      >/dev/null \
      || reauth_die "OneCLI could not create the new $name secret."
    echo "Created the $name secret in OneCLI"
  fi
}

reauth_upsert_value_secret() {
  local secret_id="$1"
  local name="$2"
  local type="$3"
  local value="$4"
  local host_pattern="$5"

  [ -n "$value" ] || reauth_die "the credential was empty; nothing was changed"
  if [ -n "$secret_id" ]; then
    onecli secrets update \
      --id "$secret_id" \
      --value "$value" \
      --host-pattern "$host_pattern" \
      >/dev/null \
      || reauth_die "OneCLI could not update secret $secret_id."
    echo "Updated the existing OneCLI secret: $secret_id"
  else
    onecli secrets create \
      --name "$name" \
      --type "$type" \
      --value "$value" \
      --host-pattern "$host_pattern" \
      >/dev/null \
      || reauth_die "OneCLI could not create the new $name secret."
    echo "Created the $name secret in OneCLI"
  fi
}

reauth_now() {
  reauth_node -e 'process.stdout.write(new Date().toISOString())'
}

reauth_plus_days() {
  reauth_node -e 'process.stdout.write(new Date(Date.now() + Number(process.argv[1]) * 86400000).toISOString())' "$1"
}

# Save only non-secret bookkeeping for Ops Center. The file is intentionally
# separate from OneCLI and contains timestamps, method labels, and notes only.
reauth_record_status() {
  local project_root="$1"
  local provider="$2"
  local method="$3"
  local refreshed_at="$4"
  local expires_at="$5"
  local expiry_mode="$6"
  local note="$7"
  local status_file="$project_root/data/provider-auth-status.json"

  mkdir -p "$project_root/data"
  reauth_node - "$status_file" "$provider" "$method" "$refreshed_at" "$expires_at" "$expiry_mode" "$note" <<'NODE'
const fs = require('fs');
const path = require('path');

const [file, provider, method, refreshedAt, expiresAt, expiryMode, note] = process.argv.slice(2);
let state = { version: 1, providers: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
    state = { version: 1, providers: parsed.providers };
  }
} catch {}
state.providers[provider] = {
  method,
  refreshedAt,
  expiresAt: expiresAt || null,
  expiryMode,
  note,
};
const tmp = `${file}.tmp.${process.pid}`;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
try { fs.chmodSync(tmp, 0o600); } catch {}
fs.renameSync(tmp, file);
NODE
}
