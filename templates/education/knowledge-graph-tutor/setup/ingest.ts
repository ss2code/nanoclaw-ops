import fs from 'node:fs';

import type { ActorContext } from '../app/context';
import { commitProposal, createProposal } from '../app/ingestion';
import { parseArgs, requiredFlag, TutorError, optionalFlag } from '../app/util';

function artifactPaths(flags: Record<string, string | boolean>): string[] | undefined {
  const value = optionalFlag(flags, 'generated-artifacts');
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('must be a JSON array of paths');
    return parsed;
  } catch (error) {
    throw new TutorError(`--generated-artifacts ${error instanceof Error ? error.message : String(error)}`, 64);
  }
}

if (import.meta.main) {
  try {
    const { flags } = parseArgs(process.argv.slice(2));
    const root = requiredFlag(flags, 'root');
    const actor: ActorContext = {
      role: 'tutor', actorId: 'host-bootstrap', messagingGroupId: 'host-bootstrap',
      routing: { channel_type: 'host', platform_id: 'bootstrap', thread_id: '' },
    };
    const proposal = createProposal(
      root, actor, requiredFlag(flags, 'document'), requiredFlag(flags, 'graph'),
      requiredFlag(flags, 'scope-type'), requiredFlag(flags, 'scope-label'),
      typeof flags.role === 'string' ? flags.role : 'base',
      {
        sourcePath: optionalFlag(flags, 'source'), sourceMimeType: optionalFlag(flags, 'source-mime'),
        extractionMethod: optionalFlag(flags, 'extraction-method'), extractorVersion: optionalFlag(flags, 'extractor-version'),
        ocrProvider: optionalFlag(flags, 'ocr-provider'),
        generatedArtifactPaths: artifactPaths(flags),
        canonicalizerVersion: optionalFlag(flags, 'canonicalizer-version'),
        canonicalizerPromptHash: optionalFlag(flags, 'canonicalizer-prompt-hash'), canonicalizerModel: optionalFlag(flags, 'canonicalizer-model'),
        pageCount: optionalFlag(flags, 'page-count') === undefined ? undefined : Number(optionalFlag(flags, 'page-count')),
        ocrConfidence: optionalFlag(flags, 'ocr-confidence') === undefined ? undefined : Number(optionalFlag(flags, 'ocr-confidence')),
      },
    );
    console.log(JSON.stringify({ stage: 'proposal', ...proposal }, null, 2));
    if (flags.approve === true) {
      const receipt = commitProposal(root, actor, proposal.id, proposal.proposalHash);
      console.log(JSON.stringify({ stage: 'commit', ...receipt }, null, 2));
    } else {
      console.error(`Proposal ${proposal.id} is staged but not committed. Re-run with --approve after reviewing hash ${proposal.proposalHash}.`);
    }
  } catch (error) {
    const code = error instanceof TutorError ? error.exitCode : 1;
    console.error(error instanceof Error ? error.message : String(error)); process.exit(code);
  }
}
