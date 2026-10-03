/**
 * OpenRouter speech-to-text through the OneCLI gateway.
 *
 * The host never holds the OpenRouter API key. Requests go through the
 * OneCLI gateway proxy (the same mechanism agent containers use): we fetch
 * the per-agent proxy config for a dedicated "host-transcription" agent,
 * tunnel the HTTPS call through the gateway, and the gateway injects the
 * Authorization header from the vault at request time. The gateway's CA
 * certificate (it terminates TLS to inject headers) comes from the same
 * config response.
 *
 * Consequences of the agent identity: transcription usage is visible in
 * OneCLI as its own agent, and any vault rules (block / rate-limit /
 * manual approval) scoped to it apply to transcription traffic like any
 * other credentialed call.
 */
import { OneCLI } from '@onecli-sh/sdk';
// undici's own fetch, not the global: a dispatcher (ProxyAgent) can only be
// passed to the fetch from the same undici instance — Node's bundled copy
// rejects it with a bare "fetch failed" TypeError.
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import { log } from '../../log.js';

const AGENT_IDENTIFIER = 'host-transcription';
const AGENT_NAME = 'Host Transcription';
const TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** whisper-large-v3: measured $0.0015/min via usage.cost, best Whisper-family
 *  Tamil support, verified live through the gateway 2026-07-12. */
const MODEL = 'openai/whisper-large-v3';

/** Per-request cap. A voice note is seconds long; anything that takes longer
 *  than this is a stuck proxy or a huge file — fail and let routing proceed. */
const REQUEST_TIMEOUT_MS = 45_000;

export interface TranscriptionResult {
  text: string;
  seconds: number | null;
  cost: number | null;
}

interface GatewayHandle {
  dispatcher: ProxyAgent;
}

let handle: GatewayHandle | null = null;
let handlePromise: Promise<GatewayHandle> | null = null;

/**
 * Resolve (and cache) the gateway proxy dispatcher. ensureAgent is
 * idempotent server-side; the config fetch happens once per host process.
 * On failure the promise cache is cleared so the next call retries.
 */
async function getGateway(): Promise<GatewayHandle> {
  if (handle) return handle;
  if (!handlePromise) {
    handlePromise = (async () => {
      const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
      await onecli.ensureAgent({ name: AGENT_NAME, identifier: AGENT_IDENTIFIER });
      const cfg = await onecli.getContainerConfig({ agent: AGENT_IDENTIFIER });
      const rawProxy = cfg.env.HTTPS_PROXY;
      if (!rawProxy) throw new Error('OneCLI container config has no HTTPS_PROXY');
      // The gateway hands out container-perspective URLs; from the host,
      // host.docker.internal is just localhost.
      const proxyUrl = new URL(rawProxy.replace('host.docker.internal', '127.0.0.1'));
      // undici does not read userinfo out of the proxy URI — pass it as a
      // Proxy-Authorization token explicitly (this is the detail netlify-cli
      // gets wrong; see memory: artifact-deploy-encryption).
      const token =
        proxyUrl.username || proxyUrl.password
          ? `Basic ${Buffer.from(
              `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
            ).toString('base64')}`
          : undefined;
      const uri = `${proxyUrl.protocol}//${proxyUrl.host}`;
      const dispatcher = new ProxyAgent({
        uri,
        ...(token ? { token } : {}),
        // The gateway MITMs TLS to inject credentials — trust its CA for the
        // tunneled connection to openrouter.ai.
        requestTls: { ca: cfg.caCertificate },
      });
      handle = { dispatcher };
      return handle;
    })();
    handlePromise.catch(() => {
      handlePromise = null;
    });
  }
  return handlePromise;
}

/** Transcribe one audio buffer. Throws on any failure — callers decide
 *  how to degrade (routing must never block on this). */
export async function transcribeAudio(audio: Buffer, format: string): Promise<TranscriptionResult> {
  const gw = await getGateway();
  const res = await undiciFetch(TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input_audio: { data: audio.toString('base64'), format },
    }),
    // Route this single request through the gateway proxy.
    dispatcher: gw.dispatcher,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`transcription HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { text?: string; usage?: { seconds?: number; cost?: number } };
  if (typeof json.text !== 'string') {
    throw new Error(`transcription response missing text: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const result: TranscriptionResult = {
    text: json.text.trim(),
    seconds: json.usage?.seconds ?? null,
    cost: json.usage?.cost ?? null,
  };
  log.debug('Voice note transcribed', { seconds: result.seconds, cost: result.cost, model: MODEL });
  return result;
}
