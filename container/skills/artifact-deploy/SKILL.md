---
name: artifact-deploy
description: Generic artifact deployment for any agent group. Use when a user explicitly asks to put an HTML artifact online, update a hosted page, rotate a page password, check deploy status, roll back a hosted artifact, or tear down a Netlify site. This skill is deployment modality only; it does not know trip, finance, docs, or app internals.
---

# artifact-deploy — generic hosted artifact deployment

This skill deploys an existing artifact. It does **not** create, rewrite, or
judge the artifact content.

```bash
AD="bun /app/skills/artifact-deploy/scripts/artifact-deploy.ts --dir /workspace/agent"
```

## Hard rule

Never run `deploy`, `set-password`, `rollback`, or `teardown` unless a user
explicitly asked for that specific action. Do not spend Netlify free usage on
speculative or automatic deploys.

## Credits — never publish to production without saying what it costs

Netlify bills **15 credits per production deployment**, and the Free plan is a
hard cap of **300 credits/month** — no recharge, and the project pauses once they
run out. That is roughly **20 production publishes a month, total**.

Three commands publish to production and are therefore metered: `deploy
--production`, `publish`, and `rollback` (rollback restores a deploy to
production, so it bills like any other publish). All three refuse to run without
`--confirm-credits`.

**That flag is not yours to add on your own initiative.** When a user asks for one
of these actions: tell them the 15-credit cost in chat, wait for an explicit
go-ahead, and only then re-run with `--confirm-credits`. Never add the flag just
to clear the error, and never reach for a production publish as a way to "fix" a
deploy that already worked.

Plain `deploy` (no `--production`) is a **draft** deploy: free, unmetered,
unlimited, and it still returns a working shareable URL. It is the right answer
almost every time. The one real tradeoff: a draft URL is unique per deploy, so the
link changes each time you update the page — send the new URL with each deploy. A
*stable* URL is the only thing production buys, and it costs 15 credits per update.

**A deploy never sets or generates a password.** "Update the page" / "deploy"
means exactly deploy — it does NOT include `set-password`. Encryption uses only
the passphrase the operator has already stored; if none is stored, the deploy is
public, and that is the correct default. Run `set-password` only when a user
explicitly asks to set or rotate the page password — never as a step inside a
deploy sequence. Inventing a passphrase the operator did not choose locks them
out of their own document.

## Netlify

```bash
$AD netlify setup --site <site-name> [--state-db <db>]
$AD netlify set-password (--set <passphrase> | --generate) --state-db <db>   # operator-only; never inside a deploy
$AD netlify bundle --input <file.html> --slug <slug> --out .deploy/<slug> --state-db <db>
$AD netlify deploy --input <file.html> --slug <slug> --site-id <id> [--production --confirm-credits] [--password <passphrase>] [--state-db <db>]
$AD netlify publish --site-id <id> --deploy <deploy-id> --confirm-credits [--state-db <db>]   # 15 credits
$AD netlify status --state-db <db>
$AD netlify history --site-id <id>
$AD netlify rollback --site-id <id> --deploy <deploy-id> --confirm-credits [--state-db <db>]  # 15 credits
$AD netlify teardown --site-id <id>
```

`<db>` is whatever structured-data store the calling skill already keeps —
artifact-deploy stores its own `deploy_state` inside it rather than owning a
separate file. Example: trip-docs groups conventionally use `trip.db`
(`--state-db trip.db`); a different skill could point at any other path.

The Netlify token belongs in OneCLI as a credential for `api.netlify.com`. The
script also accepts `NETLIFY_AUTH_TOKEN` for operator-run local testing. Do not
ask users to paste tokens into chat.

`set-password` is an **operator-only** action — only when a user explicitly asks
to set or rotate the page password, never as part of a deploy. Operators normally
set it from the host with `scripts/set-doc-passphrase.sh`, so you rarely run it at
all. It requires `--set <passphrase>` (store a chosen one) or `--generate` (create
a random memorable one); a bare `set-password` errors on purpose, so a password is
never set implicitly. Whatever is stored is what deploys encrypt with. Show a
newly set passphrase once and send it privately to the owner/operator — never post
it in a shared group chat. Rotate by running `set-password` again, then doing a
user-requested deploy so the next deploy re-encrypts with the new passphrase.

`bundle` is deterministic and safe to run any time. With no passphrase it writes
the raw HTML to `index.html`; with a passphrase (from state, or `--password`) it
writes a self-contained decryptor page whose body is the document **encrypted**
with AES-256-GCM under a PBKDF2-SHA256 key. The plaintext never leaves the
container.

`deploy` always uses the Netlify content API and creates a **draft** deploy by
default — free, unmetered, and still served at a real URL. Use `--production` only
when the user explicitly asks to publish immediately, and only after you have told
them it costs 15 credits and they have agreed; it then also needs
`--confirm-credits`. It encrypts only when a passphrase is **already stored** (set earlier
by the operator) or one is passed via `--password`; with no passphrase stored it
deploys the page publicly and never creates one. When a passphrase is in effect
the deployed page is the encrypted decryptor: opening the URL shows a passphrase
prompt, and the browser decrypts the document locally via WebCrypto — only
ciphertext is ever served. The deploy verifies that the served page carries the
decryptor envelope and does **not** contain the plaintext before recording
success; if that check fails it treats the deploy as failed instead of sharing a
URL that could leak content.

Protection here is client-side encryption, not a server login: the URL returns
HTTP 200 with a passphrase gate, so anyone can load the page but only someone
with the passphrase can read it. (Netlify's native server-side password is a
paid-plan feature and is not used.)

To publish a previously verified draft, use `publish --deploy <deploy-id>
--confirm-credits`. This promotes that exact deploy through Netlify's restore
endpoint. It costs 15 credits and must only be done after an explicit user
request that followed you stating the cost.

After a successful deploy, reply on the same channel/thread the request came
in on, with the running URL and the version now live.

## WhatsApp help text

When a user asks "Netlify help", "page help", or "how do I update the page?",
answer with this short menu:

- "update the page" — deploy the current artifact and reply with the running URL
  plus version.
- "what version is live?" — show deploy status without changing the page.
- "set/change the page password" — generate a new passphrase, store it, and send
  the passphrase privately to the owner/operator. The next deploy re-encrypts with
  it. Never post it in a shared group chat.
- "send the password privately" — use the owner DM path if configured; otherwise
  explain that an owner DM destination must be wired first.
- "roll back the page" — restore an older deploy only after an explicit request.
  Say first that a rollback publishes to production and costs 15 of the 300 free
  monthly Netlify credits, and wait for a yes before running it.
