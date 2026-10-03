import fs from 'node:fs';
import { esc } from './ui.js';

export const WEBQI_HELP_PATH = '/chat/webqi/help';

// Copy data is shared with /consult help; no host/container runtime module is shared.
export function webQiHelpBody(): string {
  const help = JSON.parse(
    fs.readFileSync(new URL('../container/skills/consult/references/help.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const sections = Object.entries(help)
    .map(
      ([id, text]) =>
        `<details class="card webqi-help-section" id="${esc(id)}" ${id === 'start' ? 'open' : ''}><summary>${esc(text.split('\n')[0])}</summary><pre>${esc(text)}</pre></details>`,
    )
    .join('');
  return `<div class="subnav"><a href="/chat">Chat</a><a href="/chat/webqi">Consult</a><a class="active" href="${WEBQI_HELP_PATH}">Help</a></div>
<h2>How to use Consult</h2>
<p>Get a second opinion from other models, then ask follow-ups in the same topic.</p>
<section class="card webqi-help-section"><h3>On the web</h3><ol>
<li>From Chat, choose <b>Get a second opinion</b>. The agent and conversation carry over. You can also select a conversation on the Consult page.</li>
<li>Type your question and send. Consult names the topic and chooses distinct models automatically.</li>
<li>Read the combined answer. Expand <b>Original model answers</b> to read exact replies. <b>Details and full history</b> contains the graph and full conversation export.</li>
<li>Type a follow-up and choose <b>Ask panel</b>. The whole topic's completed history is included. <b>Explore separately</b> starts from a particular answer or question.</li>
<li><b>Explain the disagreement · existing answers</b> processes stored replies locally. It does not ask the panel again, but still uses the local model.</li>
</ol><p><b>Options</b> contains Second opinion, Check reasoning, and Help me decide presets. Choose models or open Advanced settings for specific methods, answer styles, aliases, and model tiers.</p><p>Manage topics contains Finish topic and Move to trash. Undo restores a trashed topic as closed; reopen it to ask again. Retention is bounded, as described below. The page updates automatically.</p></section>
<div class="webqi-help-main">${sections}</div>`;
}
