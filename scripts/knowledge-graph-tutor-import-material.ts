import fs from 'node:fs';
import path from 'node:path';

import { type ActorContext } from '../templates/education/knowledge-graph-tutor/app/context';
import { registerInstructionResource } from '../templates/education/knowledge-graph-tutor/app/instruction-resources';
import { paths } from '../templates/education/knowledge-graph-tutor/app/store';
import { parseArgs, requiredFlag, TutorError } from '../templates/education/knowledge-graph-tutor/app/util';

/** Register a pre-existing tutor HTML/SVG as an active, concept-linked resource. */
const { flags } = parseArgs(process.argv.slice(2));
const root = path.resolve(requiredFlag(flags, 'root'));
const source = path.resolve(requiredFlag(flags, 'artifact'));
const concept = requiredFlag(flags, 'concept');
const title = requiredFlag(flags, 'title');
const textAlternative = requiredFlag(flags, 'text-alternative');
const idempotency = requiredFlag(flags, 'idempotency');
const kind = (typeof flags.kind === 'string' ? flags.kind : 'diagram');
const tags = typeof flags.tags === 'string' ? JSON.parse(flags.tags) as string[] : ['diagram', 'html', 'generated'];
const provenance = typeof flags.provenance === 'string' ? JSON.parse(flags.provenance) as string[] : ['large-numbers-around-us@1'];

if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new TutorError(`artifact not found: ${source}`, 66);
const staging = path.join(paths(root).resourcesDir, '.legacy-import', path.basename(source));
fs.mkdirSync(path.dirname(staging), { recursive: true });
fs.copyFileSync(source, staging);

const actor: ActorContext = {
  role: 'tutor', actorId: 'legacy-material-import',
  routing: { channel_type: 'local', platform_id: 'legacy-material-import', thread_id: '' },
  messagingGroupId: 'legacy-material-import',
};

try {
  const result = registerInstructionResource(root, actor, {
    concept, kind, title, artifactPath: staging, textAlternative, tags, provenance, idempotency,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  fs.rmSync(path.dirname(staging), { recursive: true, force: true });
}
