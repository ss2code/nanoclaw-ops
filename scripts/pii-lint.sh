#!/usr/bin/env bash
# pii-lint — block secrets and personal data from entering the main repo.
#
# Generic patterns are built in; instance-specific canaries (names, numbers,
# ids of real people) live in .pii-canaries.txt at the repo root — that file
# is gitignored here and versioned in the private overlay repo, so the lint
# works without ever publishing what it protects against.
#
# Matching uses perl (present on macOS + Linux) because BSD grep lacks -P and
# these patterns need lookaheads. Canaries match case-insensitively.
#
# Modes:
#   pii-lint.sh --staged            scan staged diff (pre-commit hook; default)
#   pii-lint.sh --message <file>    scan a commit message file (commit-msg hook)
#   pii-lint.sh --files <f> [...]   scan specific files
#   pii-lint.sh --all               scan every tracked file (slow; audits)
#
# A line containing "pii-lint-allow" is exempt (use sparingly, with a reason).
# Exit 0 = clean, 1 = findings, 2 = usage error.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANARY_FILE="$ROOT/.pii-canaries.txt"

# ── Generic patterns (kept instance-agnostic; safe to publish) ──────────────
# Fake/reserved ranges are carved out: 1555*/91555* numbers, 111* LIDs,
# 120363000000000* group JIDs — use those in tests and docs.
GENERIC_PATTERNS=(
  # Indian mobile numbers (91 + 6-9 leading subscriber digit)
  '\b91[6-9][0-9]{9}\b'
  # WhatsApp phone JIDs not in the fake ranges
  '\b(?!1555)(?!91555)[0-9]{10,15}@s\.whatsapp\.net'
  # WhatsApp group JIDs / LIDs not in the fake ranges
  '\b120363(?!000000000)[0-9]{9,12}@g\.us'
  '\b(?!111)[0-9]{12,16}@lid\b'
  # Personal-provider emails
  '[A-Za-z0-9._%+-]+@(?:gmail|googlemail|yahoo|outlook|hotmail|icloud|proton|protonmail)\.[A-Za-z]{2,}'
  # Absolute home paths (machine-identifying). Excludes standard container
  # users and doc placeholders that aren't personal machine identifiers.
  '/(?:Users|home)/(?!node/|you/|user/|ubuntu/|admin/|ec2-user/|debian/)[a-z][a-z0-9_-]+/'
  # Credential shapes (belt-and-braces; OneCLI should make these impossible)
  '\bsk-ant-[A-Za-z0-9_-]{10,}'
  '\bsk-or-v1-[A-Za-z0-9]{10,}'
  '\bgh[pousr]_[A-Za-z0-9]{20,}'
  '\bgithub_pat_[A-Za-z0-9_]{20,}'
  '\bxox[bpoas]-[A-Za-z0-9-]{10,}'
  '\bAKIA[0-9A-Z]{16}\b'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}'
  'hooks\.slack\.com/services/'
  'discord(?:app)?\.com/api/webhooks/'
)

# match <case-flag> <pattern>  — reads stdin, prints "line#: line" for matches,
# skipping pii-lint-allow lines. Pattern passed via env to avoid quoting bugs.
match() {
  PII_PAT="$2" perl -ne '
    my $ci = "'"$1"'" eq "i";
    next if /pii-lint-allow/;
    my $pat = $ENV{PII_PAT};
    if ($ci ? /$pat/i : /$pat/) { print "$.: $_"; }
  ' 2>/dev/null
}

scan_stream() {
  # stdin: content to scan, $1: label. Returns 1 if anything matched.
  local label="$1" found=0 pat content hits
  content="$(cat)"
  [ -z "$content" ] && return 0
  for pat in "${GENERIC_PATTERNS[@]}"; do
    hits=$(printf '%s\n' "$content" | match s "$pat")
    if [ -n "$hits" ]; then
      echo "✗ [$label] generic pattern: $pat"
      printf '%s\n' "$hits" | head -5 | sed 's/^/    /'
      found=1
    fi
  done
  if [ -f "$CANARY_FILE" ]; then
    while IFS= read -r canary; do
      case "$canary" in ''|'#'*) continue;; esac
      hits=$(printf '%s\n' "$content" | match i "$canary")
      if [ -n "$hits" ]; then
        echo "✗ [$label] canary match (see .pii-canaries.txt)"
        printf '%s\n' "$hits" | head -5 | sed 's/^/    /'
        found=1
      fi
    done < "$CANARY_FILE"
  fi
  return $found
}

fail=0
mode="${1:---staged}"
case "$mode" in
  --staged)
    # Added lines only — pre-existing content is the re-audit's job, not the hook's.
    files=$(git -C "$ROOT" diff --cached --name-only --diff-filter=ACM)
    for f in $files; do
      # awk (not grep) so empty/binary diffs exit 0 — grep's exit-1-on-no-match
      # plus pipefail turned every staged binary into a phantom failure.
      git -C "$ROOT" diff --cached -U0 -- "$f" \
        | awk '/^\+/ && !/^\+\+\+/' \
        | scan_stream "staged:$f" || fail=1
    done
    ;;
  --message)
    [ $# -lt 2 ] && { echo "usage: pii-lint.sh --message <file>" >&2; exit 2; }
    scan_stream "commit-message" < "$2" || fail=1
    ;;
  --files)
    shift
    [ $# -lt 1 ] && { echo "usage: pii-lint.sh --files <f> [...]" >&2; exit 2; }
    for f in "$@"; do
      [ -f "$f" ] || continue
      scan_stream "$f" < "$f" || fail=1
    done
    ;;
  --all)
    while IFS= read -r f; do
      [ -f "$ROOT/$f" ] || continue
      case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.ico|*.pdf|*.svg|pnpm-lock.yaml|*.lock) continue;; esac
      scan_stream "$f" < "$ROOT/$f" || fail=1
    done < <(git -C "$ROOT" ls-files)
    ;;
  *)
    echo "usage: pii-lint.sh [--staged|--message <file>|--files <f>...|--all]" >&2
    exit 2
    ;;
esac

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'

pii-lint: blocked — the content above looks like personal data or a credential.
  • Instance/personal content belongs in the private overlay (pgit), not this repo.
  • Test fixtures use the fake ranges: 1555*/91555* numbers, 111*@lid, 120363000000000*@g.us.
  • False positive? Append "pii-lint-allow" to the line with a comment saying why.
EOF
  exit 1
fi
exit 0
