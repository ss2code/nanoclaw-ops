/**
 * Codex model ids verified for the ChatGPT-account provider path.
 *
 * This is intentionally an explicit allowlist: a syntactically plausible
 * `gpt-*` id is not necessarily available to Codex when it authenticates via
 * a ChatGPT account.
 */
export const CODEX_SUPPORTED_MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;

const CODEX_SUPPORTED_MODEL_SET = new Set<string>(CODEX_SUPPORTED_MODEL_IDS);

export function isSupportedCodexModelId(id: string): boolean {
  return CODEX_SUPPORTED_MODEL_SET.has(id);
}
