import { resolveActor, requireTutor } from './context';
import { getBlueprint, setBlueprint } from './assessment-policy';
import { briefing, schedulePlan } from './coaching';
import { commitProposal, createProposal, inspectDocument, showGraph } from './ingestion';
import { getSourceDocument, listSourceDocuments } from './source-repository';
import {
  applyInbox, completeAction, computeFrontier, currentContext, exportProfileMemory, interventionCommand, mastery,
  planNextAction, recall, recordAttempt, recordMisconception, remember, roster, setAction, updateMisconception,
} from './learning';
import {
  approveInstructionResource, listInstructionResources, proposeInstructionResource, registerInstructionResource, searchInstructionResources,
} from './instruction-resources';
import {
  addReview, dashboard, getPolicy, listReviews, queueAssignment, queueGuidance, recordReviewDelivery, report,
  currentPreferences, setPolicy, updatePreferences, updateReview,
} from './operations';
import { searchCourse } from './retrieval';
import { classExists, openClass, openCourse, openStudent } from './store';
import { traceMetrics, traceTimeline } from './trace';
import {
  appRoot, assertNoTargetFlags, emit, optionalFlag, parseArgs, requiredFlag, requiredFlags, TutorError,
} from './util';
import { renderVisual, type VisualKind } from './visuals';

type CommandSpec = {
  required: string[];
  optional?: string[];
  example: string;
  tutorOnly?: boolean;
};

const COMMAND_SPECS: Record<string, CommandSpec> = {
  help: { required: [], optional: ['topic'], example: 'help --json' },
  'context current': { required: [], example: 'context current --json' },
  'context frontier': { required: [], example: 'context frontier --json' },
  'inbox apply': { required: [], example: 'inbox apply --json' },
  'course search': { required: [], optional: ['query', 'concept', 'difficulty', 'limit', 'trace'], example: 'course search --query "fractions" --trace <trace-id> --json' },
  'instruction search': { required: [], optional: ['query', 'concept', 'tags', 'limit'], example: 'instruction search --concept C01 --tags "[\"diagram\"]" --json' },
  'instruction list': { required: [], optional: ['concept', 'status', 'limit'], example: 'instruction list --concept C01 --json' },
  'instruction propose': { required: ['concept', 'kind', 'title', 'artifact', 'text-alternative', 'idempotency'], optional: ['artifacts', 'tags', 'provenance'], example: 'instruction propose --concept C01 --kind lesson --title "Fraction model" --artifact /workspace/agent/tutor-app/students/<id>/artifacts/<id>/index.html --artifacts JSON_ARRAY --text-alternative "A fraction model..." --idempotency visual-001 --json' },
  'learning plan-action': { required: ['idempotency'], optional: ['pedagogy'], example: 'learning plan-action --idempotency turn-001 --json' },
  'learning record-attempt': { required: ['concept', 'difficulty', 'outcome', 'idempotency', 'evidence'], optional: ['kind', 'pedagogy', 'action-revision', 'trace', 'item', 'rubric-scores', 'grading-confidence', 'selected-option', 'hint-count'], example: 'learning record-attempt --concept C01 --difficulty low --outcome partial --item <source-item-id> --rubric-scores "{\"reasoning\":0.7}" --grading-confidence 0.9 --hint-count 0 --idempotency attempt-001 --evidence "bounded answer excerpt" --json' },
  'learning mastery': { required: [], optional: ['concept'], example: 'learning mastery --concept C01 --json' },
  'learning misconception': { required: ['concept', 'description', 'confidence'], optional: ['evidence-event'], example: 'learning misconception --concept C01 --description "place value confusion" --confidence 0.7 --json' },
  'learning misconception-update': { required: ['id', 'status', 'evidence-event'], example: 'learning misconception-update --id mis_123 --status resolved --evidence-event evt_123 --json' },
  'learning set-action': { required: ['concept', 'type', 'prompt', 'expected-evidence', 'difficulty'], optional: ['pedagogy', 'reason', 'priority'], example: 'learning set-action --concept C01 --type practice --prompt "Compare 42 and 24" --expected-evidence "explains tens place" --difficulty low --json' },
  'learning complete-action': { required: ['revision'], example: 'learning complete-action --revision 3 --json' },
  'profile current': { required: [], example: 'profile current --json' },
  'profile preferences': { required: ['value'], example: 'profile preferences --value "{\"timezone\":\"Asia/Kolkata\"}" --json' },
  'trace timeline': { required: [], optional: ['trace', 'limit'], example: 'trace timeline --trace turn-001 --json' },
  'trace metrics': { required: [], example: 'trace metrics --json' },
  'memory remember': { required: ['title', 'content'], example: 'memory remember --title "Preference" --content "Uses visual examples" --json' },
  'memory recall': { required: [], optional: ['query'], example: 'memory recall --query "fractions" --json' },
  'schedule review-add': { required: ['concept', 'difficulty', 'schedule', 'idempotency'], optional: ['due-at', 'reason', 'cadence', 'timezone', 'quiet-start', 'quiet-end'], example: 'schedule review-add --concept C01 --difficulty low --schedule "tomorrow 18:00" --idempotency review-001 --json' },
  'schedule list': { required: [], example: 'schedule list --json' },
  'schedule pause': { required: ['id'], example: 'schedule pause --id review_123 --json' },
  'schedule resume': { required: ['id'], example: 'schedule resume --id review_123 --json' },
  'schedule cancel': { required: ['id'], example: 'schedule cancel --id review_123 --json' },
  'schedule delivery-receipt': { required: ['id', 'revision', 'delivery-id'], example: 'schedule delivery-receipt --id review_123 --revision 1 --delivery-id delivery_001 --json' },
  'visual render': { required: ['kind', 'title', 'items', 'provenance'], optional: ['concept'], example: 'visual render --kind comparison --title "Place value" --items JSON_ARRAY --provenance JSON_ARRAY --json' },
  'coaching briefing': { required: ['slot'], example: 'coaching briefing --slot morning --json' },
  'coaching schedule-plan': { required: [], example: 'coaching schedule-plan --json' },
  'admin roster': { required: [], tutorOnly: true, example: 'admin roster --json' },
  'admin dashboard': { required: [], optional: ['student'], tutorOnly: true, example: 'admin dashboard --student "Asha" --json' },
  'admin report': { required: [], optional: ['student'], tutorOnly: true, example: 'admin report --student "Asha" --json' },
  'admin blueprint-get': { required: [], tutorOnly: true, example: 'admin blueprint-get --json' },
  'admin blueprint-set': { required: ['name', 'value', 'idempotency'], tutorOnly: true, example: 'admin blueprint-set --name balanced --value JSON_OBJECT --idempotency blueprint-001 --json' },
  'admin instruction-register': { required: ['concept', 'kind', 'title', 'artifact', 'text-alternative', 'idempotency'], optional: ['artifacts', 'tags', 'provenance'], tutorOnly: true, example: 'admin instruction-register --concept C01 --kind lesson --title "Fraction model" --artifact /workspace/agent/tutor-app/artifacts/index.html --artifacts JSON_ARRAY --text-alternative "A fraction model..." --idempotency resource-001 --json' },
  'admin instruction-approve': { required: ['id'], tutorOnly: true, example: 'admin instruction-approve --id instruction_123 --json' },
  'admin export-profile-memory': { required: ['student'], tutorOnly: true, example: 'admin export-profile-memory --student "Asha" --json' },
  'admin intervention-command': { required: ['student', 'concept', 'difficulty', 'schedule', 'idempotency'], tutorOnly: true, example: 'admin intervention-command --student "Asha" --concept C01 --difficulty medium --schedule "tomorrow 18:00" --idempotency intervention-001 --json' },
  'admin assignment-command': { required: ['student', 'concept', 'body', 'idempotency'], optional: ['due-at'], tutorOnly: true, example: 'admin assignment-command --student "Asha" --concept C01 --body "Practice place value" --idempotency assignment-001 --json' },
  'admin guidance-command': { required: ['student', 'concept', 'guidance', 'idempotency'], tutorOnly: true, example: 'admin guidance-command --student "Asha" --concept C01 --guidance "Use a place-value table" --idempotency guidance-001 --json' },
  'admin policy-get': { required: [], optional: ['key'], tutorOnly: true, example: 'admin policy-get --key review.quiet_hours --json' },
  'admin policy-set': { required: ['key', 'value', 'idempotency'], tutorOnly: true, example: 'admin policy-set --key review.quiet_hours --value "{\"start\":\"21:00\",\"end\":\"07:00\"}" --idempotency policy-001 --json' },
  'ingestion inspect': { required: ['document'], optional: ['ocr-provider'], tutorOnly: true, example: 'ingestion inspect --document /path/to/document.pdf --ocr-provider tesseract --json' },
  'ingestion propose': { required: ['document', 'graph', 'scope-type', 'scope-label'], optional: ['role', 'source', 'source-mime', 'extraction-method', 'extractor-version', 'ocr-provider', 'canonicalizer-version', 'canonicalizer-prompt-hash', 'canonicalizer-model', 'generated-artifacts', 'page-count', 'ocr-confidence'], tutorOnly: true, example: 'ingestion propose --document /path/to/canonical.md --source /path/to/original.pdf --ocr-provider tesseract --generated-artifacts "[\"lesson.html\",\"lesson.pdf\"]" --role supplement --canonicalizer-version fixed-prompt-v3 --graph Mathematics_KG --scope-type chapter --scope-label Fractions --json' },
  'ingestion commit': { required: ['proposal', 'expected-hash'], tutorOnly: true, example: 'ingestion commit --proposal prop_123 --expected-hash abc123 --json' },
  'ingestion source-list': { required: [], optional: ['graph'], example: 'ingestion source-list --graph Mathematics_KG --json' },
  'ingestion source-get': { required: ['id'], example: 'ingestion source-get --id doc_123 --json' },
  'ckg show': { required: ['graph'], tutorOnly: true, example: 'ckg show --graph Mathematics_KG --json' },
};

function commandHelp(role: 'tutor' | 'student', key: string): unknown {
  const spec = COMMAND_SPECS[key];
  if (!spec) return { error: `unknown command: ${key}`, available: Object.keys(COMMAND_SPECS).filter((item) => !COMMAND_SPECS[item].tutorOnly || role === 'tutor') };
  return {
    command: key,
    required_flags: spec.required,
    optional_flags: spec.optional ?? [],
    example: spec.example,
    privacy: spec.tutorOnly ? 'tutor-control routing required' : 'routing-scoped to the current actor',
  };
}

const TUTOR_ONLY_COMMANDS = new Set(Object.entries(COMMAND_SPECS).filter(([, spec]) => spec.tutorOnly).map(([key]) => key));

function parsedJson(value: string, name: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new TutorError(`--${name} must be valid JSON`, 64); }
}

function stringArray(value: string | undefined, name: string): string[] {
  if (!value) return [];
  const parsed = parsedJson(value, name);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new TutorError(`--${name} must be a JSON string array`, 64);
  return parsed;
}

function jsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const parsed = parsedJson(value, name);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TutorError(`--${name} must be a JSON object`, 64);
  return parsed as Record<string, unknown>;
}

function help(role: 'tutor' | 'student', topic?: string): unknown {
  const common = ['context current', 'course search', 'instruction search', 'instruction list', 'ingestion source-list', 'ingestion source-get', 'help'];
  const student = [
    'context frontier', 'inbox apply', 'learning plan-action', 'learning record-attempt', 'learning mastery',
    'learning misconception', 'learning misconception-update', 'learning set-action', 'learning complete-action',
    'profile current', 'profile preferences', 'schedule review-add', 'schedule list', 'schedule pause', 'schedule resume', 'schedule cancel',
    'schedule delivery-receipt', 'visual render', 'trace timeline', 'trace metrics', 'memory remember', 'memory recall',
    'coaching briefing', 'coaching schedule-plan', 'instruction propose',
  ];
  const tutor = [
    'admin roster', 'admin dashboard', 'admin report', 'admin export-profile-memory', 'admin intervention-command',
    'admin assignment-command', 'admin guidance-command', 'admin policy-get', 'admin policy-set',
    'admin blueprint-get', 'admin blueprint-set', 'admin instruction-register', 'admin instruction-approve',
    'ingestion inspect', 'ingestion propose', 'ingestion commit', 'ckg show',
  ];
  const topicText: Record<string, string> = {
    learning: 'Assess only observable answers; use plan-action for a frontier-safe pedagogy and record practice/review evidence idempotently.',
    privacy: 'Student identity is derived from routing. Student commands never accept a target student or database path.',
    coursework: role === 'tutor' ? 'Inspect supported source formats, stage canonical output and artifacts, review warnings and lineage, then commit the exact proposal hash. Use source-list/source-get to inspect approved revisions.' : 'Search the approved shared course with provenance, or request an approved source through source-list/source-get; coursework mutation is tutor-only.',
    instructions: role === 'tutor' ? 'List or search reusable concept-tagged materials; proposed items are review-only until approval promotes them to shared course resources. Use the returned preview_path with send_file to resend one.' : 'List approved shared materials or search them before creating a new explanation; use the returned preview_path with send_file to ask for a material to be resent on this channel.',
    students: role === 'tutor' ? 'Use roster, reports, assignments, guidance and interventions from tutor control.' : 'Student administration is not available in this chat.',
    reports: role === 'tutor' ? 'Use the messaging-channel dashboard for detailed insight; generate an exportable report when needed. Profile/memory export is separate and explicit.' : 'Reports about students are tutor-only.',
    schedules: role === 'student' ? 'This session owns its review schedules and delivery receipts. Proactive coaching runs at 07:00 and 15:00 in the student timezone.' : 'Queue a targeted review; the student session applies and owns delivery.',
    coaching: role === 'student' ? 'Use the private coaching briefing for points, streak, honest encouragement, and one finishable task before the next slot.' : 'Coaching cards are student-scoped; use reports and targeted commands for tutor oversight.',
    troubleshooting: 'Run doctor and context current. Missing or mismatched routing fails closed with no state mutation.',
  };
  return {
    role,
    topic: topic ?? 'overview',
    philosophy: 'Move through an evidence-backed concept graph while keeping each student routing-scoped.',
    privacy: role === 'student' ? 'Only your current routing-bound learning state is available.' : 'Tutor operations require this control channel and produce auditable receipts.',
    guidance: topic ? topicText[topic] ?? 'Unknown help topic.' : 'Use help <learning|privacy|coursework|instructions|students|reports|schedules|coaching|troubleshooting> for details.',
    topics: ['learning', 'privacy', 'coursework', 'instructions', 'students', 'reports', 'schedules', 'coaching', 'troubleshooting'],
    commands: [...common, ...(role === 'student' ? student : tutor)],
    usage: Object.fromEntries(
      [...common, ...(role === 'student' ? student : tutor)]
        .map((command) => [command, commandHelp(role, command)])
        .filter(([, value]) => value && typeof value === 'object' && !('error' in value)),
    ),
  };
}

export function run(argv = process.argv.slice(2)): void {
  const root = appRoot();
  if (!classExists(root)) throw new TutorError('tutor application is not initialized', 78);
  const [area = 'help', possibleVerb = '', ...tail] = argv;
  const verb = possibleVerb.startsWith('--') ? '' : possibleVerb;
  const rest = possibleVerb.startsWith('--') ? [possibleVerb, ...tail] : tail;
  const { positional, flags } = parseArgs(rest);
  const json = flags.json === true;
  const actor = resolveActor(root);

  const commandKey = [area, verb].filter(Boolean).join(' ');
  if (flags.help === true) {
    if (TUTOR_ONLY_COMMANDS.has(commandKey)) requireTutor(actor);
    return emit(commandHelp(actor.role, commandKey), true);
  }

  if (area === 'help') return emit(help(actor.role, verb || undefined), json);
  if (area === 'doctor') {
    const classDb = openClass(root); const courseDb = openCourse(root);
    const result = {
      ok: true, role: actor.role,
      class: classDb.query('SELECT * FROM class_config WHERE id=1').get(),
      students: (classDb.query(`SELECT COUNT(*) AS n FROM students WHERE status='approved'`).get() as { n: number }).n,
      graphs: (courseDb.query('SELECT COUNT(*) AS n FROM knowledge_graphs').get() as { n: number }).n,
    };
    classDb.close(); courseDb.close(); return emit(result, json, 'TUTOR APPLICATION READY');
  }
  if (area === 'context' && verb === 'current') { assertNoTargetFlags(flags); return emit(currentContext(root, actor), json); }
  if (area === 'context' && verb === 'frontier') { assertNoTargetFlags(flags); return emit(computeFrontier(root, actor), json); }
  if (area === 'inbox' && verb === 'apply') { assertNoTargetFlags(flags); return emit(applyInbox(root, actor), json); }
  if (area === 'course' && verb === 'search') {
    assertNoTargetFlags(flags);
    const query = optionalFlag(flags, 'query') ?? positional.join(' ');
    return emit(searchCourse(root, actor, query, optionalFlag(flags, 'concept'), optionalFlag(flags, 'difficulty'), Number(optionalFlag(flags, 'limit') ?? 8), optionalFlag(flags, 'trace')), json);
  }
  if (area === 'instruction' && verb === 'search') {
    assertNoTargetFlags(flags);
    return emit(searchInstructionResources(
      root, actor, optionalFlag(flags, 'query') ?? positional.join(' '), optionalFlag(flags, 'concept'),
      stringArray(optionalFlag(flags, 'tags'), 'tags'), Number(optionalFlag(flags, 'limit') ?? 8),
    ), json);
  }
  if (area === 'instruction' && verb === 'list') {
    assertNoTargetFlags(flags);
    return emit(listInstructionResources(
      root, actor, optionalFlag(flags, 'concept'), optionalFlag(flags, 'status'), Number(optionalFlag(flags, 'limit') ?? 20),
    ), json);
  }
  if (area === 'instruction' && verb === 'propose') {
    assertNoTargetFlags(flags);
    return emit(proposeInstructionResource(root, actor, {
      concept: requiredFlag(flags, 'concept'), kind: requiredFlag(flags, 'kind'), title: requiredFlag(flags, 'title'),
      artifactPath: requiredFlag(flags, 'artifact'), artifactPaths: stringArray(optionalFlag(flags, 'artifacts'), 'artifacts'), textAlternative: requiredFlag(flags, 'text-alternative'),
      tags: stringArray(optionalFlag(flags, 'tags'), 'tags'), provenance: stringArray(optionalFlag(flags, 'provenance'), 'provenance'),
      idempotency: requiredFlag(flags, 'idempotency'),
    }), json);
  }
  if (area === 'memory' && verb === 'remember') {
    assertNoTargetFlags(flags); return emit(remember(root, actor, requiredFlag(flags, 'title'), requiredFlag(flags, 'content')), json);
  }
  if (area === 'memory' && verb === 'recall') {
    assertNoTargetFlags(flags); return emit(recall(root, actor, optionalFlag(flags, 'query') ?? positional.join(' ')), json);
  }
  if (area === 'learning' && verb === 'record-attempt') {
    assertNoTargetFlags(flags);
    const required = requiredFlags(flags, ['concept', 'difficulty', 'outcome', 'idempotency', 'evidence']);
    return emit(recordAttempt(
      root, actor, required.concept, required.difficulty, required.outcome,
      required.idempotency, required.evidence, {
        eventKind: (optionalFlag(flags, 'kind') ?? 'practice') as 'practice' | 'review' | 'diagnostic',
        pedagogy: optionalFlag(flags, 'pedagogy') as never,
        actionRevision: optionalFlag(flags, 'action-revision') ? Number(optionalFlag(flags, 'action-revision')) : undefined,
        traceId: optionalFlag(flags, 'trace'),
        sourceItemId: optionalFlag(flags, 'item'),
        rubricScores: jsonObject(optionalFlag(flags, 'rubric-scores'), 'rubric-scores') as Record<string, number> | undefined,
        gradingConfidence: optionalFlag(flags, 'grading-confidence') ? Number(optionalFlag(flags, 'grading-confidence')) : undefined,
        selectedOption: optionalFlag(flags, 'selected-option'),
        hintCount: optionalFlag(flags, 'hint-count') ? Number(optionalFlag(flags, 'hint-count')) : undefined,
      },
    ), json);
  }
  if (area === 'learning' && verb === 'mastery') {
    assertNoTargetFlags(flags); return emit(mastery(root, actor, optionalFlag(flags, 'concept')), json);
  }
  if (area === 'learning' && verb === 'misconception') {
    assertNoTargetFlags(flags); return emit(recordMisconception(root, actor, requiredFlag(flags, 'concept'), requiredFlag(flags, 'description'), Number(requiredFlag(flags, 'confidence')), optionalFlag(flags, 'evidence-event')), json);
  }
  if (area === 'learning' && verb === 'misconception-update') {
    assertNoTargetFlags(flags); return emit(updateMisconception(
      root, actor, requiredFlag(flags, 'id'), requiredFlag(flags, 'status') as 'remediating' | 'resolved',
      requiredFlag(flags, 'evidence-event'),
    ), json);
  }
  if (area === 'learning' && verb === 'set-action') {
    assertNoTargetFlags(flags);
    const required = requiredFlags(flags, ['concept', 'type', 'prompt', 'expected-evidence', 'difficulty']);
    return emit(setAction(
      root, actor, required.concept, required.type, required.prompt,
      required['expected-evidence'], required.difficulty, {
        pedagogy: optionalFlag(flags, 'pedagogy') as never, reasonCode: optionalFlag(flags, 'reason'),
        priority: optionalFlag(flags, 'priority') ? Number(optionalFlag(flags, 'priority')) : undefined,
      },
    ), json);
  }
  if (area === 'learning' && verb === 'complete-action') {
    assertNoTargetFlags(flags); return emit(completeAction(root, actor, Number(requiredFlag(flags, 'revision'))), json);
  }
  if (area === 'learning' && verb === 'plan-action') {
    assertNoTargetFlags(flags); return emit(planNextAction(root, actor, requiredFlag(flags, 'idempotency'), optionalFlag(flags, 'pedagogy')), json);
  }
  if (area === 'profile' && verb === 'preferences') {
    assertNoTargetFlags(flags); return emit(updatePreferences(root, actor, parsedJson(requiredFlag(flags, 'value'), 'value') as Record<string, unknown>), json);
  }
  if (area === 'profile' && verb === 'current') {
    assertNoTargetFlags(flags); return emit(currentPreferences(root, actor), json);
  }
  if (area === 'coaching' && verb === 'briefing') {
    assertNoTargetFlags(flags); return emit(briefing(root, actor, requiredFlag(flags, 'slot')), json);
  }
  if (area === 'coaching' && verb === 'schedule-plan') {
    assertNoTargetFlags(flags); return emit(schedulePlan(root, actor), json);
  }
  if (area === 'trace' && verb === 'timeline') {
    assertNoTargetFlags(flags); return emit(traceTimeline(root, actor, optionalFlag(flags, 'trace'), Number(optionalFlag(flags, 'limit') ?? 200)), json);
  }
  if (area === 'trace' && verb === 'metrics') {
    assertNoTargetFlags(flags); return emit(traceMetrics(root, actor), json);
  }
  if (area === 'schedule' && verb === 'review-add') {
    assertNoTargetFlags(flags); return emit(addReview(root, actor, {
      concept: requiredFlag(flags, 'concept'), difficulty: requiredFlag(flags, 'difficulty'),
      scheduleText: requiredFlag(flags, 'schedule'), dueAt: optionalFlag(flags, 'due-at'),
      reason: optionalFlag(flags, 'reason'), cadence: optionalFlag(flags, 'cadence'), timezone: optionalFlag(flags, 'timezone'),
      quietStart: optionalFlag(flags, 'quiet-start'), quietEnd: optionalFlag(flags, 'quiet-end'),
      idempotency: requiredFlag(flags, 'idempotency'),
    }), json);
  }
  if (area === 'schedule' && verb === 'list') { assertNoTargetFlags(flags); return emit(listReviews(root, actor), json); }
  if (area === 'schedule' && ['pause', 'resume', 'cancel'].includes(verb)) {
    assertNoTargetFlags(flags); return emit(updateReview(root, actor, requiredFlag(flags, 'id'), verb as 'pause' | 'resume' | 'cancel'), json);
  }
  if (area === 'schedule' && verb === 'delivery-receipt') {
    assertNoTargetFlags(flags); return emit(recordReviewDelivery(root, actor, requiredFlag(flags, 'id'), Number(requiredFlag(flags, 'revision')), requiredFlag(flags, 'delivery-id')), json);
  }
  if (area === 'visual' && verb === 'render') {
    assertNoTargetFlags(flags); return emit(renderVisual(
      root, actor, requiredFlag(flags, 'kind') as VisualKind, requiredFlag(flags, 'title'), optionalFlag(flags, 'concept'),
      stringArray(optionalFlag(flags, 'items'), 'items'), stringArray(optionalFlag(flags, 'provenance'), 'provenance'),
    ), json);
  }
  if (area === 'ingestion' && verb === 'inspect') {
    requireTutor(actor); return emit(inspectDocument(requiredFlag(flags, 'document'), { ocrProvider: optionalFlag(flags, 'ocr-provider') }), json);
  }
  if (area === 'ingestion' && verb === 'propose') {
    requireTutor(actor);
    const pageCount = optionalFlag(flags, 'page-count');
    const ocrConfidence = optionalFlag(flags, 'ocr-confidence');
    return emit(createProposal(root, actor, requiredFlag(flags, 'document'), requiredFlag(flags, 'graph'), requiredFlag(flags, 'scope-type'), requiredFlag(flags, 'scope-label'), optionalFlag(flags, 'role') ?? 'base', {
      sourcePath: optionalFlag(flags, 'source'), sourceMimeType: optionalFlag(flags, 'source-mime'),
      extractionMethod: optionalFlag(flags, 'extraction-method'), extractorVersion: optionalFlag(flags, 'extractor-version'), ocrProvider: optionalFlag(flags, 'ocr-provider'),
      canonicalizerVersion: optionalFlag(flags, 'canonicalizer-version'),
      canonicalizerPromptHash: optionalFlag(flags, 'canonicalizer-prompt-hash'), canonicalizerModel: optionalFlag(flags, 'canonicalizer-model'),
      generatedArtifactPaths: stringArray(optionalFlag(flags, 'generated-artifacts'), 'generated-artifacts'),
      pageCount: pageCount === undefined ? undefined : Number(pageCount),
      ocrConfidence: ocrConfidence === undefined ? undefined : Number(ocrConfidence),
    }), json);
  }
  if (area === 'ingestion' && verb === 'commit') {
    requireTutor(actor);
    const result = commitProposal(root, actor, requiredFlag(flags, 'proposal'), requiredFlag(flags, 'expected-hash'));
    return emit(result, json, `COURSE REVISION COMMITTED revision=${result.revision} graph=${result.graph}`);
  }
  if (area === 'ingestion' && verb === 'source-list') {
    assertNoTargetFlags(flags); return emit(listSourceDocuments(root, actor, optionalFlag(flags, 'graph')), json);
  }
  if (area === 'ingestion' && verb === 'source-get') {
    assertNoTargetFlags(flags); return emit(getSourceDocument(root, actor, requiredFlag(flags, 'id')), json);
  }
  if (area === 'ckg' && verb === 'show') {
    requireTutor(actor); return emit(showGraph(root, requiredFlag(flags, 'graph')), json);
  }
  if (area === 'admin' && verb === 'roster') {
    requireTutor(actor); return emit(roster(root, actor), json);
  }
  if (area === 'admin' && verb === 'dashboard') {
    requireTutor(actor); return emit(dashboard(root, actor, optionalFlag(flags, 'student')), json);
  }
  if (area === 'admin' && verb === 'export-profile-memory') {
    requireTutor(actor); return emit(exportProfileMemory(root, actor, requiredFlag(flags, 'student')), json);
  }
  if (area === 'admin' && verb === 'intervention-command') {
    requireTutor(actor);
    const required = requiredFlags(flags, ['student', 'concept', 'difficulty', 'schedule', 'idempotency']);
    return emit(interventionCommand(root, actor, required.student, required.concept, required.difficulty, required.schedule, required.idempotency), json);
  }
  if (area === 'admin' && verb === 'assignment-command') {
    requireTutor(actor); return emit(queueAssignment(root, actor, requiredFlag(flags, 'student'), requiredFlag(flags, 'concept'), requiredFlag(flags, 'body'), optionalFlag(flags, 'due-at'), requiredFlag(flags, 'idempotency')), json);
  }
  if (area === 'admin' && verb === 'guidance-command') {
    requireTutor(actor); return emit(queueGuidance(root, actor, requiredFlag(flags, 'student'), requiredFlag(flags, 'concept'), requiredFlag(flags, 'guidance'), requiredFlag(flags, 'idempotency')), json);
  }
  if (area === 'admin' && verb === 'report') {
    requireTutor(actor); return emit(report(root, actor, optionalFlag(flags, 'student')), json);
  }
  if (area === 'admin' && verb === 'blueprint-get') {
    requireTutor(actor); return emit(getBlueprint(root, actor), json);
  }
  if (area === 'admin' && verb === 'blueprint-set') {
    requireTutor(actor); return emit(setBlueprint(
      root, actor, requiredFlag(flags, 'name'), parsedJson(requiredFlag(flags, 'value'), 'value'), requiredFlag(flags, 'idempotency'),
    ), json);
  }
  if (area === 'admin' && verb === 'instruction-register') {
    requireTutor(actor);
    return emit(registerInstructionResource(root, actor, {
      concept: requiredFlag(flags, 'concept'), kind: requiredFlag(flags, 'kind'), title: requiredFlag(flags, 'title'),
      artifactPath: requiredFlag(flags, 'artifact'), artifactPaths: stringArray(optionalFlag(flags, 'artifacts'), 'artifacts'), textAlternative: requiredFlag(flags, 'text-alternative'),
      tags: stringArray(optionalFlag(flags, 'tags'), 'tags'), provenance: stringArray(optionalFlag(flags, 'provenance'), 'provenance'),
      idempotency: requiredFlag(flags, 'idempotency'),
    }), json);
  }
  if (area === 'admin' && verb === 'instruction-approve') {
    requireTutor(actor); return emit(approveInstructionResource(root, actor, requiredFlag(flags, 'id')), json);
  }
  if (area === 'admin' && verb === 'policy-get') {
    requireTutor(actor); return emit(getPolicy(root, actor, optionalFlag(flags, 'key')), json);
  }
  if (area === 'admin' && verb === 'policy-set') {
    requireTutor(actor); return emit(setPolicy(root, actor, requiredFlag(flags, 'key'), parsedJson(requiredFlag(flags, 'value'), 'value'), requiredFlag(flags, 'idempotency')), json);
  }
  throw new TutorError(`unknown command: ${[area, verb].filter(Boolean).join(' ')}`, 64);
}

if (import.meta.main) {
  try { run(); }
  catch (error) {
    const code = error instanceof TutorError ? error.exitCode : 1;
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), exit_code: code }));
    process.exit(code);
  }
}
