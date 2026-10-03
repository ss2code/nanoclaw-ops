import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { CANONICALIZER_PROMPT_VERSION, canonicalDocumentToTaggedMarkdown, parseCanonicalDocument } from './canonical-schema';
import { type ActorContext, requireTutor } from './context';
import { htmlArtifactSafe, mimeTypeForPath, readDocument } from './document-format';
import { audit, openClass, openCourse, paths } from './store';
import {
  canonicalDifficulty, ensureDir, newId, normalizeText, now, sha256, stableId, stripTags,
  TutorError, writeJsonAtomic,
} from './util';

export interface ConceptCandidate {
  sourceCode: string;
  code: string;
  title: string;
  definition: string;
  canonicalPath: string;
  aliases: string[];
}

export interface EdgeCandidate {
  from: string;
  to: string;
  type: string;
  rationale: string;
}

export interface RubricCriterionCandidate {
  id: string;
  description: string;
  weight: number;
  evidence: string;
}

export interface AssessmentSpecCandidate {
  criteria: RubricCriterionCandidate[];
  acceptableAnswers: string[];
  misconceptions: Array<{ code: string; description: string; feedback: string }>;
  distractors: Array<{ id: string; body: string; correct: boolean; misconception: string | null }>;
  cognitiveLevel: string | null;
  estimatedMinutes: number | null;
  ageMin: number | null;
  ageMax: number | null;
  tags: string[];
}

export interface ItemCandidate {
  kind: 'question' | 'answer' | 'information_snippet' | 'worked_example' | 'graphic' | 'flashcard' | 'mcq';
  title: string;
  body: string;
  conceptRefs: string[];
  difficulty: 'low' | 'medium' | 'high' | null;
  originalDifficulty: string | null;
  locator: string;
  assessmentRef: string | null;
  answerForRef: string | null;
  assessmentSpec?: AssessmentSpecCandidate;
  duplicateOf?: string;
  itemType?: string;
  provenance?: 'source-authored' | 'generated' | 'teacher-provided' | 'agent-generated' | 'student-provided';
  confidence?: number;
  sourceReference?: string;
}

export interface Inspection {
  inputMode: 'structured_base_doc' | 'raw_source';
  documentHash: string;
  filename: string;
  documentMimeType: string;
  extractionMethod: string;
  concepts: ConceptCandidate[];
  edges: EdgeCandidate[];
  items: ItemCandidate[];
  questions: number;
  answersLinked: number;
  answersUnlinked: number;
  questionsWithoutAnswers: number;
  rubricQuestions: number;
  difficulty: { low: number; medium: number; high: number };
  duplicateContent: number;
  aliasProposals: { ref: string; candidates: string[] }[];
  warnings: string[];
  promptInjectionQuoted: boolean;
  canonicalizationRequired: boolean;
  commitAllowed: boolean;
  documentFormat: string;
  intakeStatus: string;
}

export interface ProposalArtifact {
  kind: 'original' | 'canonical' | 'normalized' | 'extracted' | 'ocr' | 'structured' | 'generated';
  path: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  locators?: Array<{ locator: string; confidence?: number }>;
  textAlternative?: string;
}

export interface Proposal extends Inspection {
  id: string;
  proposalHash: string;
  graph: string;
  scopeType: string;
  scopeLabel: string;
  documentPath: string;
  sourcePath: string;
  sourceFilename: string;
  sourceHash: string;
  sourceMimeType: string;
  extractorVersion: string | null;
  canonicalizerVersion: string | null;
  canonicalizerPromptHash: string | null;
  canonicalizerModel: string | null;
  pageCount: number | null;
  ocrConfidence: number | null;
  role: string;
  createdAt: string;
  uploaderId: string;
  uploaderRole: string;
  uploadedAt: string;
  sourceByteSize: number;
  intakeStatus: string;
  artifacts: ProposalArtifact[];
}

const PARSER_VERSION = 'kg-tutor-hybrid-v2';
const KNOWN_EDGE_TYPES = new Set(['prerequisite_of', 'part_of', 'related_to', 'contrasts_with', 'example_of']);
const INGESTION_ROLES = new Set(['base', 'supplement', 'assessment_bank', 'reference', 'generated_material']);

export interface ProposalOptions {
  sourcePath?: string;
  sourceMimeType?: string;
  extractionMethod?: string;
  extractorVersion?: string;
  canonicalizerVersion?: string;
  canonicalizerPromptHash?: string;
  canonicalizerModel?: string;
  pageCount?: number | null;
  ocrConfidence?: number | null;
  ocrProvider?: string;
  generatedArtifactPaths?: string[];
}

function contentItemTags(
  item: ItemCandidate,
  concepts: Array<{ code: string; canonicalId: string }>,
  graph: string,
  documentId: string,
  role: string,
  audience: { grade_level?: string | number | null; target_age?: number | null },
): string[] {
  return [...new Set([
    'source', 'curriculum', `kind:${item.kind}`, `graph:${graph}`, `source-document:${documentId}`, `source-role:${role}`,
    `grade:${String(audience.grade_level ?? 'unknown')}`, `eli:${String(audience.target_age ?? 'unknown')}`,
    ...concepts.flatMap((concept) => [`concept:${concept.canonicalId}`, `concept-code:${concept.code}`]),
    ...(item.difficulty ? [`difficulty:${item.difficulty}`] : []),
    ...(item.assessmentSpec?.tags ?? []),
    ...(item.assessmentSpec?.cognitiveLevel ? [`cognitive:${item.assessmentSpec.cognitiveLevel}`] : []),
    ...(concepts.length ? [] : ['concept:unmapped', 'mapping:unmapped']),
  ].map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function tag(body: string, name: string): string | null {
  const match = body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? stripTags(match[1]) : null;
}

function allTags(body: string, name: string): string[] {
  const regex = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...body.matchAll(regex)].map((match) => stripTags(match[1])).filter(Boolean);
}

function attrs(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of value.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[match[1]] = match[2] ?? match[3] ?? '';
  }
  return out;
}

function itemConceptRefs(attributes: Record<string, string>, body = ''): string[] {
  return refsFrom(attributes.concepts ?? attributes.concept ?? attributes.concept_id ?? attributes.concept_ids
    ?? tag(body, 'concepts') ?? tag(body, 'concept_id') ?? tag(body, 'concept_ids'));
}

function markdownBeforeTags(body: string, names: string[]): string {
  const pattern = new RegExp(`<(${names.join('|')})\\b`, 'i');
  const match = pattern.exec(body);
  return stripTags(match ? body.slice(0, match.index) : body);
}

function markdownTableRows(body: string): string[][] {
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => normalizeText(cell)))
    .filter((cells) => cells.length > 1 && !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

function extractConcepts(text: string): { concepts: ConceptCandidate[]; nestedEdges: EdgeCandidate[] } {
  const raw: { sourceCode: string; title: string; definition: string; parent?: string; dependsOn: string[]; enables: string[] }[] = [];
  const stack: string[] = [];
  const tokens = [...text.matchAll(/<concept\s+([^>]*\bid\s*=\s*["'][^"']+["'][^>]*)>|<\/concept>/gi)];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    const a = attrs(token[1] ?? '');
    const sourceCode = a.id;
    if (!sourceCode) continue;
    const segmentEnd = tokens[i + 1]?.index ?? Math.min(text.length, token.index + 2000);
    const segment = text.slice((token.index ?? 0) + token[0].length, segmentEnd);
    const title = a.name ?? tag(segment, 'concept_name') ?? tag(segment, 'title') ?? sourceCode.replace(/[_-]+/g, ' ');
    const definition = tag(segment, 'definition') ?? tag(segment, 'concept_definition') ?? '';
    raw.push({ sourceCode, title, definition, parent: stack.at(-1), dependsOn: refsFrom(a.depends_on), enables: refsFrom(a.enables) });
    stack.push(sourceCode);
  }

  const unique = new Map<string, (typeof raw)[number]>();
  for (const concept of raw) if (!unique.has(concept.sourceCode)) unique.set(concept.sourceCode, concept);
  const concepts = [...unique.values()].map((concept, index) => ({
    sourceCode: concept.sourceCode,
    code: `C${String(index + 1).padStart(2, '0')}`,
    title: concept.title,
    definition: concept.definition,
    canonicalPath: concept.title.toLowerCase().replace(/[^a-z0-9]+/g, '/').replace(/^\/|\/$/g, ''),
    aliases: [concept.sourceCode],
  }));
  const nestedEdges = [...unique.values()].flatMap((concept) => [
    ...(concept.parent && unique.has(concept.parent)
      ? [{ from: concept.parent, to: concept.sourceCode, type: 'part_of', rationale: 'nested concept structure' }]
      : []),
    ...concept.dependsOn.filter((dependency) => unique.has(dependency)).map((dependency) =>
      ({ from: dependency, to: concept.sourceCode, type: 'prerequisite_of', rationale: 'concept depends_on declaration' })),
    ...concept.enables.filter((enabled) => unique.has(enabled)).map((enabled) =>
      ({ from: concept.sourceCode, to: enabled, type: 'prerequisite_of', rationale: 'concept enables declaration' })),
  ]);
  return { concepts, nestedEdges };
}

function extractDependencies(text: string): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  for (const match of text.matchAll(/<dependency\s+([^>]*)\/?>(?:[\s\S]*?<\/dependency>)?/gi)) {
    const a = attrs(match[1]);
    const body = match[0];
    const from = a.from ?? tag(body, 'from') ?? tag(body, 'prerequisite') ?? '';
    const to = a.to ?? tag(body, 'to') ?? tag(body, 'dependent') ?? '';
    const type = a.type ?? tag(body, 'type') ?? 'prerequisite_of';
    if (from && to) out.push({ from, to, type, rationale: tag(body, 'rationale') ?? 'explicit dependency' });
  }
  return out;
}

function splitBlocks(text: string, name: string, requireId = false): { body: string; index: number; end: number; attrs: Record<string, string> }[] {
  const regex = requireId
    ? new RegExp(`<${name}\\s+([^>]*\\bid\\s*=\\s*["'][^"']+["'][^>]*)>([\\s\\S]*?)<\\/${name}>`, 'gi')
    : new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...text.matchAll(regex)].map((m) => ({ body: m[2], index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, attrs: attrs(m[1] ?? '') }));
}

function refsFrom(value: string | null): string[] {
  return value ? value.split(/[,;|\s]+/).map((v) => v.trim()).filter(Boolean) : [];
}

function sourceLocator(kind: string, index: number, attributes: Record<string, string>): string {
  const explicit = attributes.source_locator ?? attributes.locator;
  if (explicit) return explicit;
  const page = attributes.page ?? attributes.page_number;
  const origin = attributes.origin;
  if (page) return `page:${page}/${kind}[${index + 1}]`;
  if (origin) return `origin:${origin}/${kind}[${attributes.id ?? index + 1}]`;
  return `${kind}[${index + 1}]`;
}

function numberOrNull(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assessmentSpec(block: { body: string; attrs: Record<string, string> }): AssessmentSpecCandidate {
  const criteria = splitBlocks(block.body, 'criterion').map((criterion, index) => ({
    id: criterion.attrs.id ?? `criterion-${index + 1}`,
    description: tag(criterion.body, 'description') ?? stripTags(criterion.body),
    weight: numberOrNull(criterion.attrs.weight ?? tag(criterion.body, 'weight')) ?? 1,
    evidence: tag(criterion.body, 'evidence') ?? '',
  })).filter((criterion) => criterion.description.length > 0);
  const misconceptions = splitBlocks(block.body, 'misconception').map((entry, index) => ({
    code: entry.attrs.code ?? entry.attrs.id ?? `misconception-${index + 1}`,
    description: tag(entry.body, 'description') ?? stripTags(entry.body),
    feedback: tag(entry.body, 'feedback') ?? '',
  })).filter((entry) => entry.description.length > 0);
  const distractors = splitBlocks(block.body, 'option').map((entry, index) => ({
    id: entry.attrs.id ?? String.fromCharCode(65 + index),
    body: tag(entry.body, 'text') ?? stripTags(entry.body),
    correct: entry.attrs.correct === 'true' || entry.attrs.correct === '1',
    misconception: entry.attrs.misconception ?? null,
  })).filter((entry) => entry.body.length > 0);
  const tags = refsFrom(block.attrs.tags ?? tag(block.body, 'tags'));
  return {
    criteria,
    acceptableAnswers: allTags(block.body, 'acceptable_answer'),
    misconceptions,
    distractors,
    cognitiveLevel: block.attrs.cognitive_level ?? block.attrs.bloom ?? tag(block.body, 'cognitive_level') ?? tag(block.body, 'bloom') ?? null,
    estimatedMinutes: numberOrNull(block.attrs.estimated_minutes ?? tag(block.body, 'estimated_minutes')),
    ageMin: numberOrNull(block.attrs.age_min ?? tag(block.body, 'age_min')),
    ageMax: numberOrNull(block.attrs.age_max ?? tag(block.body, 'age_max')),
    tags,
  };
}

function extractItems(text: string): ItemCandidate[] {
  const items: ItemCandidate[] = [];
  for (const [index, block] of splitBlocks(text, 'question_block').entries()) {
    const originalDifficulty = block.attrs.difficulty ?? tag(block.body, 'difficulty');
    const body = tag(block.body, 'question_text') ?? tag(block.body, 'question') ?? stripTags(block.body);
    const options = tag(block.body, 'options');
    const locator = sourceLocator('question_block', index, block.attrs);
    const assessmentRef = block.attrs.id ?? tag(block.body, 'question_id') ?? locator;
    const conceptRefs = refsFrom(block.attrs.concept_id ?? tag(block.body, 'concept_id') ?? tag(block.body, 'concept_ids'));
    items.push({
      kind: options ? 'mcq' : 'question', title: `Question ${index + 1}`, body: options ? `${body}\n\n${options}` : body,
      conceptRefs,
      difficulty: canonicalDifficulty(originalDifficulty ?? undefined), originalDifficulty: originalDifficulty ?? null,
      locator, assessmentRef, answerForRef: null, assessmentSpec: assessmentSpec(block),
    });
    const embeddedAnswer = tag(block.body, 'correct_answer') ?? tag(block.body, 'model_answer') ?? tag(block.body, 'answer');
    if (embeddedAnswer) items.push({
      kind: 'answer', title: `Answer for ${assessmentRef}`, body: embeddedAnswer, conceptRefs,
      difficulty: null, originalDifficulty: null, locator: `${locator}/answer`,
      assessmentRef: null, answerForRef: assessmentRef,
    });
  }
  for (const [index, block] of splitBlocks(text, 'concept_essay').entries()) {
    items.push({
      kind: 'information_snippet', title: tag(block.body, 'title') ?? `Concept note ${index + 1}`,
      body: tag(block.body, 'essay') ?? tag(block.body, 'content') ?? stripTags(block.body),
      conceptRefs: refsFrom(block.attrs.concept_id ?? tag(block.body, 'concept_id') ?? tag(block.body, 'concept_ids')),
      difficulty: null, originalDifficulty: null, locator: sourceLocator('concept_essay', index, block.attrs), assessmentRef: null, answerForRef: null,
    });
  }
  for (const block of splitBlocks(text, 'essay', true)) {
    const body = stripTags(block.body);
    if (!body) continue;
    items.push({
      kind: 'information_snippet', title: block.attrs.id ?? 'Study guide essay', body,
      conceptRefs: itemConceptRefs(block.attrs, block.body), difficulty: null, originalDifficulty: null,
      locator: sourceLocator('essay', 0, block.attrs), assessmentRef: null, answerForRef: null,
    });
  }
  for (const [index, block] of splitBlocks(text, 'worked_example', true).entries()) {
    const problem = tag(block.body, 'problem') ?? tag(block.body, 'question') ?? markdownBeforeTags(block.body, ['solution']);
    const steps = allTags(block.body, 'step');
    const answer = tag(block.body, 'answer') ?? tag(block.body, 'solution') ?? '';
    const commonErrors = allTags(block.body, 'common_error');
    const sections = [
      problem ? `**Problem:** ${problem}` : '',
      steps.length ? `**Steps:**\n${steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join('\n')}` : '',
      answer ? `**${tag(block.body, 'solution') ? 'Solution' : 'Answer'}:** ${answer}` : '',
      commonErrors.length ? `**Common errors:**\n${commonErrors.map((error) => `- ${error}`).join('\n')}` : '',
    ].filter(Boolean);
    items.push({
      kind: 'worked_example', title: tag(block.body, 'title') ?? block.attrs.id ?? block.attrs.label ?? `Worked example ${index + 1}`,
      body: sections.join('\n\n') || stripTags(block.body),
      conceptRefs: itemConceptRefs(block.attrs, block.body),
      difficulty: canonicalDifficulty(block.attrs.difficulty ?? tag(block.body, 'difficulty')),
      originalDifficulty: block.attrs.difficulty ?? tag(block.body, 'difficulty'),
      locator: sourceLocator('worked_example', index, block.attrs), assessmentRef: null, answerForRef: null,
    });
  }
  for (const [index, block] of splitBlocks(text, 'source_question', true).entries()) {
    const assessmentRef = block.attrs.id ?? `source_question-${index + 1}`;
    const locator = sourceLocator('source_question', index, block.attrs);
    const prompt = markdownBeforeTags(block.body, ['solution', 'textbook_answer']);
    const solution = tag(block.body, 'solution');
    const textbookAnswer = tag(block.body, 'textbook_answer');
    const answer = [solution ? `**Solution:** ${solution}` : '', textbookAnswer ? `**Textbook answer:** ${textbookAnswer}` : '']
      .filter(Boolean).join('\n\n');
    items.push({
      kind: block.attrs.type?.toLowerCase() === 'mcq' ? 'mcq' : 'question',
      title: `${assessmentRef}${block.attrs.label ? ` · ${block.attrs.label}` : ''}`, body: prompt,
      conceptRefs: itemConceptRefs(block.attrs, block.body),
      difficulty: canonicalDifficulty(block.attrs.difficulty), originalDifficulty: block.attrs.difficulty ?? null,
      locator, assessmentRef, answerForRef: null, assessmentSpec: assessmentSpec(block),
    });
    if (answer) items.push({
      kind: 'answer', title: `Answer for ${assessmentRef}`, body: stripTags(answer), conceptRefs: itemConceptRefs(block.attrs, block.body),
      difficulty: null, originalDifficulty: null, locator: `${locator}/answer`, assessmentRef: null, answerForRef: assessmentRef,
    });
  }
  const generatedIds = new Set<string>();
  for (const [setIndex, block] of splitBlocks(text, 'gq_set').entries()) {
    const setConcepts = itemConceptRefs(block.attrs);
    for (const row of markdownTableRows(block.body)) {
      const id = row[0]?.replace(/[`*_]/g, '').trim();
      const level = row[1]?.replace(/[`*_]/g, '').trim();
      const question = row[2]?.trim();
      if (!id?.startsWith('GQ-') || !question || !/^(easy|medium|hard)$/i.test(level ?? '')) continue;
      const encodedConcept = id.match(/^GQ-([A-Z]\d+)-/i)?.[1];
      const conceptRefs = encodedConcept ? [encodedConcept] : setConcepts;
      generatedIds.add(id);
      items.push({
        kind: 'question', title: id, body: question, conceptRefs,
        difficulty: canonicalDifficulty(level), originalDifficulty: level, locator: `gq_set[${setIndex + 1}]/question[${id}]`,
        assessmentRef: id, answerForRef: null, assessmentSpec: assessmentSpec({ body: '', attrs: {} }),
      });
    }
  }
  for (const block of splitBlocks(text, 'answer_key', true)) {
    let section = '';
    for (const line of block.body.split('\n')) {
      const heading = line.match(/^\s*##\s+([^#]+?)\s*$/);
      if (heading) section = heading[1].trim();
      const direct = [...line.matchAll(/\*\*(GQ-[A-Z0-9-]+)\*\*\s+(.+?)(?=\s+·\s+\*\*GQ-|\s*$)/g)];
      const shorthand = section.match(/^C\d+$/i)
        ? [...line.matchAll(/\*\*((?:E|M|H)\d+)\*\*\s+(.+?)(?=\s+·\s+\*(?:\*)?(?:E|M|H)\d+\*\*|\s*$)/g)]
        : [];
      for (const match of direct) {
        const id = match[1];
        if (generatedIds.has(id)) items.push({
          kind: 'answer', title: `Answer for ${id}`, body: normalizeText(match[2]), conceptRefs: [id.match(/^GQ-([A-Z]\d+)-/)?.[1] ?? ''],
          difficulty: null, originalDifficulty: null, locator: `answer_key[${id}]`, assessmentRef: null, answerForRef: id,
        });
      }
      for (const match of shorthand) {
        const id = `GQ-${section}-${match[1]}`;
        if (generatedIds.has(id)) items.push({
          kind: 'answer', title: `Answer for ${id}`, body: normalizeText(match[2]), conceptRefs: [section],
          difficulty: null, originalDifficulty: null, locator: `answer_key[${id}]`, assessmentRef: null, answerForRef: id,
        });
      }
    }
  }
  for (const [index, block] of splitBlocks(text, 'flashcard', true).entries()) {
    const markdown = block.body.match(/\*\*Q:\*\*\s*([\s\S]*?)\n+\s*\*\*A:\*\*\s*([\s\S]*)/i);
    if (!markdown) continue;
    items.push({
      kind: 'flashcard', title: block.attrs.id ?? `Flashcard ${index + 1}`,
      body: `**Q:** ${normalizeText(markdown[1])}\n\n**A:** ${normalizeText(markdown[2])}`,
      conceptRefs: itemConceptRefs(block.attrs), difficulty: null, originalDifficulty: null,
      locator: sourceLocator('flashcard', index, block.attrs), assessmentRef: null, answerForRef: null,
    });
  }
  for (const [index, block] of splitBlocks(text, 'glossary', true).entries()) {
    for (const row of markdownTableRows(block.body).slice(1)) {
      if (row.length < 3) continue;
      const term = row[0].match(/\*\*(.+?)\*\*/)?.[1] ?? row[0].replace(/`[^`]+`/g, '').trim();
      const body = row[2].trim();
      if (!term || !body || /^term$/i.test(term)) continue;
      items.push({
        kind: 'information_snippet', title: term, body, conceptRefs: refsFrom(row[1]), difficulty: null, originalDifficulty: null,
        locator: `glossary[${index + 1}]/term[${row[0].match(/`([^`]+)`/)?.[1] ?? term}]`, assessmentRef: null, answerForRef: null,
      });
    }
  }
  for (const [index, block] of splitBlocks(text, 'misconceptions', true).entries()) {
    for (const row of markdownTableRows(block.body).slice(1)) {
      if (row.length < 6 || !row[0] || /^id$/i.test(row[0])) continue;
      items.push({
        kind: 'information_snippet', title: `Misconception ${row[0]}`, body: `**Error:** ${row[3]}\n\n**Repair move:** ${row[5]}`,
        conceptRefs: refsFrom(row[1]), difficulty: null, originalDifficulty: null,
        locator: `misconceptions[${index + 1}]/${row[0]}`, assessmentRef: null, answerForRef: null,
      });
    }
  }
  for (const [index, block] of splitBlocks(text, 'glossary_term').entries()) {
    const term = tag(block.body, 'term') ?? `Glossary ${index + 1}`;
    items.push({
      kind: 'information_snippet', title: term, body: tag(block.body, 'definition') ?? stripTags(block.body),
      conceptRefs: refsFrom(block.attrs.concept_id ?? tag(block.body, 'concept_id')), difficulty: null,
      originalDifficulty: null, locator: sourceLocator('glossary_term', index, block.attrs), assessmentRef: null, answerForRef: null,
    });
  }
  const enclosingBlocks = [...splitBlocks(text, 'question_block'), ...splitBlocks(text, 'worked_example')];
  for (const [index, block] of splitBlocks(text, 'answer').entries()) {
    if (enclosingBlocks.some((enclosing) => block.index > enclosing.index && block.end < enclosing.end)) continue;
    items.push({
      kind: 'answer', title: block.attrs.id ?? `Answer ${index + 1}`, body: stripTags(block.body),
      conceptRefs: refsFrom(block.attrs.concept_id ?? tag(block.body, 'concept_id')), difficulty: null,
      originalDifficulty: null, locator: sourceLocator('answer', index, block.attrs), assessmentRef: null,
      answerForRef: block.attrs.question_id ?? block.attrs.for ?? tag(block.body, 'question_id'),
    });
  }
  const cardRegex = /(?:^|\n)#{0,4}\s*Card\s+(\d+)\s*\n+(?:\*\*)?Front(?:\*\*)?:?\s*([\s\S]*?)\n+(?:\*\*)?Back(?:\*\*)?:?\s*([\s\S]*?)(?=\n+#{0,4}\s*Card\s+\d+|$)/gi;
  for (const match of text.matchAll(cardRegex)) {
    items.push({
      kind: 'flashcard', title: `Flashcard ${match[1]}`, body: `**Front:** ${normalizeText(match[2])}\n\n**Back:** ${normalizeText(match[3])}`,
      conceptRefs: [], difficulty: null, originalDifficulty: null, locator: `flashcard[${match[1]}]`, assessmentRef: null, answerForRef: null,
    });
  }
  return annotateItemMetadata(text, items.filter((item) => item.body.length > 0));
}

function conceptDefinitionItems(concepts: ConceptCandidate[]): ItemCandidate[] {
  return concepts.filter((concept) => concept.definition.trim()).map((concept) => ({
    kind: 'information_snippet',
    title: `${concept.title} — definition`,
    body: concept.definition,
    conceptRefs: [concept.sourceCode],
    difficulty: null,
    originalDifficulty: null,
    locator: `concept_definition[${concept.sourceCode}]`,
    assessmentRef: null,
    answerForRef: null,
  }));
}

function annotateItemMetadata(text: string, items: ItemCandidate[]): ItemCandidate[] {
  const openingTags = [...text.matchAll(/<([A-Za-z_][\w.-]*)(\s[^>]*)?>/g)];
  return items.map((item) => {
    const marker = item.assessmentRef ?? item.locator;
    const opening = openingTags.find((match) => {
      const attributes = attrs(match[2] ?? '');
      return attributes.id === marker || attributes.source_locator === item.locator || attributes.locator === item.locator;
    });
    const attributes = attrs(opening?.[2] ?? '');
    const confidence = numberOrNull(attributes.confidence);
    const provenance = attributes.provenance as ItemCandidate['provenance'] | undefined;
    return {
      ...item,
      itemType: attributes.item_type ?? item.itemType ?? item.kind,
      provenance: provenance && ['source-authored', 'generated', 'teacher-provided', 'agent-generated', 'student-provided'].includes(provenance)
        ? provenance : item.provenance ?? 'source-authored',
      confidence: confidence ?? item.confidence ?? 1,
      sourceReference: attributes.source_ref ?? item.sourceReference ?? item.locator,
    };
  });
}

function detectCycle(concepts: ConceptCandidate[], edges: EdgeCandidate[]): boolean {
  const graph = new Map<string, string[]>();
  for (const c of concepts) graph.set(c.sourceCode, []);
  for (const e of edges.filter((edge) => edge.type === 'prerequisite_of')) graph.get(e.from)?.push(e.to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    if ((graph.get(node) ?? []).some(visit)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return concepts.some((concept) => visit(concept.sourceCode));
}

export function inspectDocument(documentPath: string, metadata: Pick<ProposalOptions, 'sourceMimeType' | 'extractionMethod' | 'ocrProvider'> = {}): Inspection {
  const document = readDocument(documentPath, { ocrProvider: metadata.ocrProvider });
  const content = document.bytes;
  let text = document.text;
  let canonicalSchemaErrors: string[] = [];
  if (/\.json$/i.test(documentPath) && text.trim().startsWith('{')) {
    const canonical = parseCanonicalDocument(text);
    if (canonical.valid && canonical.value) text = canonicalDocumentToTaggedMarkdown(canonical.value);
    else canonicalSchemaErrors = canonical.errors;
  }
  const structured = /<document\b|<concept_graph\b|<question_block\b|<concept_essay\b|<worked_example\b|<source_question\b|<essay\b|<gq_set\b|<glossary\b|<flashcard\b/i.test(text);
  const { concepts: parsedConcepts, nestedEdges } = extractConcepts(text);
  const edges = [...nestedEdges, ...extractDependencies(text)].filter((edge, index, all) =>
    index === all.findIndex((other) => other.from === edge.from && other.to === edge.to && other.type === edge.type));
  const extractedItems = extractItems(text);
  const concepts = parsedConcepts.map((concept) => ({
    ...concept,
    definition: concept.definition || extractedItems.find((item) =>
      item.kind === 'information_snippet' && item.conceptRefs.includes(concept.sourceCode))?.body.slice(0, 2000) || '',
  }));
  const items = [...conceptDefinitionItems(concepts), ...extractedItems].map((item) => ({
    ...item,
    itemType: item.itemType ?? item.kind,
    provenance: item.provenance ?? 'source-authored' as const,
    confidence: item.confidence ?? 1,
    sourceReference: item.sourceReference ?? item.locator,
  }));
  const seen = new Map<string, string>();
  let duplicateContent = 0;
  for (const item of items) {
    const hash = sha256(normalizeText(item.body).toLowerCase());
    const prior = seen.get(hash);
    if (prior) {
      item.duplicateOf = prior;
      duplicateContent += 1;
    } else seen.set(hash, item.locator);
  }
  const sourceCodes = new Set(concepts.map((c) => c.sourceCode));
  const aliasProposals: { ref: string; candidates: string[] }[] = [];
  for (const ref of new Set(items.flatMap((item) => item.conceptRefs))) {
    if (sourceCodes.has(ref)) continue;
    const candidates = concepts.filter((c) => c.sourceCode.startsWith(`${ref}_`) || c.sourceCode.includes(ref)).map((c) => c.sourceCode);
    aliasProposals.push({ ref, candidates });
  }
  const warnings: string[] = [];
  warnings.push(...document.warnings, ...canonicalSchemaErrors.map((error) => `canonicalizer output: ${error}`));
  if (document.status !== 'ready') warnings.push(`document intake status: ${document.status}`);
  if (!structured) warnings.push('raw source requires an approved canonical Base_doc before commit');
  if (duplicateContent) warnings.push(`${duplicateContent} normalized duplicate content item(s) will be deduplicated`);
  if (aliasProposals.length) warnings.push(`${aliasProposals.length} concept reference alias(es) require review`);
  const known = new Set(concepts.map((c) => c.sourceCode));
  const dangling = edges.filter((e) => !known.has(e.from) || !known.has(e.to));
  if (dangling.length) warnings.push(`${dangling.length} dangling graph edge(s)`);
  const invalidEdges = edges.filter((e) => !KNOWN_EDGE_TYPES.has(e.type));
  if (invalidEdges.length) warnings.push(`${invalidEdges.length} unsupported edge type(s)`);
  if (detectCycle(concepts, edges)) warnings.push('prerequisite cycle detected');
  if (structured && concepts.length === 0) warnings.push('structured document contains no parseable concepts; this is valid only for a tagged enrichment document');
  const promptInjectionQuoted = /ignore (?:all )?(?:previous|prior) instructions|export (?:the )?(?:database|student)|reveal (?:secrets|memory)/i.test(text);
  if (promptInjectionQuoted) warnings.push('instruction-like source text preserved as quoted curriculum data');
  const difficulty = { low: 0, medium: 0, high: 0 };
  for (const item of items) if (item.kind === 'question' || item.kind === 'mcq') {
    if (item.difficulty) difficulty[item.difficulty] += 1;
    else warnings.push(`${item.locator} has unsupported or missing difficulty`);
  }
  const questionRefs = new Set(items
    .filter((item) => item.kind === 'question' || item.kind === 'mcq')
    .map((item) => item.assessmentRef)
    .filter((ref): ref is string => Boolean(ref)));
  const questionRefList = items
    .filter((item) => item.kind === 'question' || item.kind === 'mcq')
    .map((item) => item.assessmentRef)
    .filter((ref): ref is string => Boolean(ref));
  const duplicateQuestionRefs = [...new Set(questionRefList.filter((ref, index) => questionRefList.indexOf(ref) !== index))];
  if (duplicateQuestionRefs.length) warnings.push(`duplicate assessment ID(s): ${duplicateQuestionRefs.join(', ')}`);
  const answerRefs = new Set(items
    .filter((item) => item.kind === 'answer' && !item.duplicateOf && item.answerForRef && questionRefs.has(item.answerForRef))
    .map((item) => item.answerForRef as string));
  const answersLinked = items.filter((item) =>
    item.kind === 'answer' && !item.duplicateOf && item.answerForRef && questionRefs.has(item.answerForRef)).length;
  const answersUnlinked = items.filter((item) =>
    item.kind === 'answer' && !item.duplicateOf && (!item.answerForRef || !questionRefs.has(item.answerForRef))).length;
  const questionsWithoutAnswers = [...questionRefs].filter((ref) => !answerRefs.has(ref)).length;
  if (answersUnlinked) warnings.push(`${answersUnlinked} answer item(s) are not linked to a known question`);
  if (questionsWithoutAnswers) warnings.push(`${questionsWithoutAnswers} question(s) have no linked answer key`);
  const invalidRubrics = items.filter((item) => {
    const spec = item.assessmentSpec;
    return spec && (
      new Set(spec.criteria.map((criterion) => criterion.id)).size !== spec.criteria.length ||
      spec.criteria.some((criterion) => !criterion.id || !criterion.description || !Number.isFinite(criterion.weight) || criterion.weight <= 0) ||
      (spec.ageMin !== null && spec.ageMax !== null && spec.ageMin > spec.ageMax)
    );
  });
  if (invalidRubrics.length) warnings.push(`${invalidRubrics.length} question rubric(s) have invalid criteria, weights, or age bounds`);
  const blocking = document.status !== 'ready' || canonicalSchemaErrors.length > 0 || !structured || (concepts.length === 0 && items.length === 0) || dangling.length > 0 || invalidEdges.length > 0 || detectCycle(concepts, edges) || invalidRubrics.length > 0 || duplicateQuestionRefs.length > 0;
  return {
    inputMode: structured ? 'structured_base_doc' : 'raw_source', documentHash: sha256(content), filename: path.basename(documentPath),
    documentMimeType: document.mimeType,
    extractionMethod: metadata.extractionMethod ?? document.extractionMethod,
    concepts, edges, items, questions: items.filter((i) => i.kind === 'question' || i.kind === 'mcq').length,
    answersLinked, answersUnlinked, questionsWithoutAnswers,
    rubricQuestions: items.filter((item) =>
      (item.kind === 'question' || item.kind === 'mcq') && Boolean(item.assessmentSpec?.criteria.length)).length,
    difficulty, duplicateContent, aliasProposals, warnings, promptInjectionQuoted,
    canonicalizationRequired: !structured || canonicalSchemaErrors.length > 0, commitAllowed: !blocking,
    documentFormat: document.format, intakeStatus: document.status,
  };
}

function stageFile(sourcePath: string, destination: string): void {
  if (!fs.existsSync(sourcePath)) throw new TutorError('document file not found', 66);
  ensureDir(path.dirname(destination));
  if (path.resolve(sourcePath) !== path.resolve(destination)) fs.copyFileSync(sourcePath, destination);
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function stagedArtifact(kind: ProposalArtifact['kind'], file: string, mimeType: string, locators?: Array<{ locator: string; confidence?: number }>, textAlternative?: string): ProposalArtifact {
  const stat = fs.statSync(file);
  return { kind, path: file, mimeType, sha256: sha256File(file), byteSize: stat.size, ...(locators?.length ? { locators } : {}), ...(textAlternative ? { textAlternative } : {}) };
}

function canonicalText(documentPath: string): { read: ReturnType<typeof readDocument>; text: string } {
  const read = readDocument(documentPath);
  if (/\.json$/i.test(documentPath) && read.text.trim().startsWith('{')) {
    const parsed = parseCanonicalDocument(read.text);
    if (parsed.valid && parsed.value) return { read, text: canonicalDocumentToTaggedMarkdown(parsed.value) };
  }
  return { read, text: read.text };
}

function portablePath(root: string, value: string): string {
  const absolute = path.resolve(value);
  const rootPath = path.resolve(root);
  return absolute === rootPath || absolute.startsWith(`${rootPath}${path.sep}`)
    ? path.relative(rootPath, absolute).split(path.sep).join('/')
    : value;
}

function nextDisplayCode(db: ReturnType<typeof openCourse>, graphId: string): string {
  const rows = db.query("SELECT code FROM concepts WHERE graph_id=$graph AND code GLOB 'C[0-9][0-9]'").all({ $graph: graphId }) as Array<{ code: string }>;
  const used = new Set(rows.map((row) => row.code));
  let index = 1;
  while (used.has(`C${String(index).padStart(2, '0')}`)) index += 1;
  return `C${String(index).padStart(2, '0')}`;
}

function graphIdFor(root: string, graph: string): string {
  const classDb = openClass(root);
  const config = classDb.query('SELECT class_name,subject FROM class_config WHERE id=1').get() as { class_name: string; subject: string } | null;
  classDb.close();
  if (!config) throw new TutorError('class is not initialized', 78);
  return stableId('kg', config.class_name, config.subject, graph);
}

function validateRoleAndMappings(root: string, inspection: Inspection, graph: string, role: string): string[] {
  const warnings: string[] = [];
  if (!INGESTION_ROLES.has(role)) {
    warnings.push(`unsupported ingestion role '${role}'; use base, supplement, assessment_bank, reference, or generated_material`);
    return warnings;
  }
  const graphId = graphIdFor(root, graph);
  const db = openCourse(root);
  try {
    const graphRow = db.query('SELECT id,base_document_id FROM knowledge_graphs WHERE id=$id').get({ $id: graphId }) as { id: string; base_document_id: string | null } | null;
    const enrichment = role !== 'base';
    if (enrichment && (!graphRow || !graphRow.base_document_id)) {
      warnings.push('supplemental ingestion requires an existing graph with an approved Base_doc');
      return warnings;
    }
    if (!enrichment && inspection.concepts.length === 0) {
      warnings.push('base ingestion requires a parseable concept graph');
    }
    if (!enrichment) return warnings;

    const registry = db.query(`SELECT source_code,code,canonical_concept_id FROM concepts
      WHERE graph_id=$graph AND status='active'`).all({ $graph: graphId }) as Array<{ source_code: string | null; code: string; canonical_concept_id: string | null }>;
    const known = new Set(registry.flatMap((row) => [row.source_code, row.code, row.canonical_concept_id].filter((value): value is string => Boolean(value))));
    const refs = inspection.items.flatMap((item) => item.conceptRefs);
    const unknown = [...new Set(refs.filter((ref) => !known.has(ref)))];
    const conceptDeclarations = inspection.concepts.filter((concept) => !known.has(concept.sourceCode));
    if (conceptDeclarations.length) unknown.push(...conceptDeclarations.map((concept) => concept.sourceCode));
    if (unknown.length) warnings.push(`concept reference(s) are outside the fixed Base_doc concept registry: ${[...new Set(unknown)].join(', ')}`);
    const unmapped = inspection.items.filter((item) => item.kind !== 'flashcard' && item.conceptRefs.length === 0);
    if (unmapped.length) warnings.push(`${unmapped.length} enrichment item(s) have no concept mapping`);
    const unstableQuestions = inspection.items.filter((item) =>
      (item.kind === 'question' || item.kind === 'mcq') && (!item.assessmentRef || item.assessmentRef.startsWith('question_block[')),
    );
    if (unstableQuestions.length) warnings.push(`${unstableQuestions.length} enrichment question(s) need stable assessment IDs`);
    if (!inspection.items.length) warnings.push('enrichment document contains no extractable teaching or assessment items');
    return warnings;
  } finally { db.close(); }
}

export function createProposal(
  root: string,
  actor: ActorContext,
  documentPath: string,
  graph: string,
  scopeType: string,
  scopeLabel: string,
  role = 'base',
  options: ProposalOptions = {},
): Proposal {
  requireTutor(actor);
  const inspection = inspectDocument(documentPath, options);
  const classDb = openClass(root);
  const audience = classDb.query('SELECT age_min,age_max,explanation_level FROM class_config WHERE id=1').get() as {
    age_min: number; age_max: number; explanation_level: string;
  } | null;
  classDb.close();
  if (audience) {
    const outside = inspection.items.filter((item) => {
      const spec = item.assessmentSpec;
      return (item.kind === 'question' || item.kind === 'mcq') && spec &&
        ((spec.ageMin !== null && spec.ageMin > audience.age_max) || (spec.ageMax !== null && spec.ageMax < audience.age_min));
    }).length;
    if (outside) inspection.warnings.push(`${outside} authored question(s) fall outside the class age range; they remain source-authored but will not be selected while compatible items exist`);
  }
  if (!INGESTION_ROLES.has(role)) inspection.commitAllowed = false;
  const roleWarnings = validateRoleAndMappings(root, inspection, graph, role);
  if (roleWarnings.length) {
    inspection.warnings.push(...roleWarnings);
    if (role !== 'base' || roleWarnings.some((warning) => warning.includes('base ingestion requires') || warning.includes('unsupported ingestion role'))) {
      inspection.commitAllowed = false;
    }
  }
  const id = newId('ing');
  const dir = path.join(paths(root).proposalsDir, id);
  ensureDir(dir);
  const canonicalExt = path.extname(documentPath) || '.md';
  const sourcePath = options.sourcePath ?? documentPath;
  const sourceExt = path.extname(sourcePath) || '.bin';
  const stagedDocumentPath = path.join(dir, `canonical${canonicalExt}`);
  const stagedSourcePath = path.join(dir, `source${sourceExt}`);
  stageFile(documentPath, stagedDocumentPath);
  stageFile(sourcePath, stagedSourcePath);
  const sourceSize = fs.statSync(sourcePath).size;
  const sourceRead = readDocument(sourcePath, { ocrProvider: options.ocrProvider });
  const sourceIsSeparate = path.resolve(sourcePath) !== path.resolve(documentPath);
  const sourceHash = sha256File(sourcePath);
  if (sourceRead.warnings.length) inspection.warnings.push(...sourceRead.warnings.map((warning) => `source intake: ${warning}`));
  if (!sourceIsSeparate && sourceRead.status !== 'ready') inspection.commitAllowed = false;
  if (sourceRead.status === 'corrupt' || sourceRead.status === 'oversized') {
    inspection.warnings.push(`source intake status prevents commit: ${sourceRead.status}`);
    inspection.commitAllowed = false;
  }
  if (sourceIsSeparate && !options.canonicalizerVersion) inspection.warnings.push('a separate source requires the fixed canonicalizer version to be recorded');
  if (sourceIsSeparate && !options.canonicalizerVersion) inspection.commitAllowed = false;
  if (sourceIsSeparate && /\.json$/i.test(documentPath)) {
    const canonical = parseCanonicalDocument(fs.readFileSync(documentPath, 'utf8'));
    if (canonical.valid && canonical.value && canonical.value.source.sha256.toLowerCase() !== sourceHash.toLowerCase()) {
      inspection.warnings.push('canonical JSON source.sha256 does not match the retained source bytes');
      inspection.commitAllowed = false;
    }
  }
  if (options.pageCount !== undefined && options.pageCount !== null && (!Number.isInteger(options.pageCount) || options.pageCount <= 0)) {
    inspection.warnings.push('page count must be a positive whole number'); inspection.commitAllowed = false;
  }
  if (options.ocrConfidence !== undefined && options.ocrConfidence !== null && (!Number.isFinite(options.ocrConfidence) || options.ocrConfidence < 0 || options.ocrConfidence > 1)) {
    inspection.warnings.push('OCR confidence must be between 0 and 1'); inspection.commitAllowed = false;
  }
  const artifactDir = path.join(dir, 'artifacts');
  ensureDir(artifactDir);
  const textAlternative = normalizeText(inspection.items.map((item) => `${item.title}: ${item.body}`).join('\n\n')) ||
    normalizeText(inspection.concepts.map((concept) => `${concept.title}: ${concept.definition}`).join('\n\n'));
  const artifacts: ProposalArtifact[] = [
    stagedArtifact('original', stagedSourcePath, sourceRead.mimeType),
    stagedArtifact('canonical', stagedDocumentPath, inspection.documentMimeType),
  ];
  if (sourceRead.text) {
    const extractedPath = path.join(artifactDir, 'extracted.txt');
    fs.writeFileSync(extractedPath, `${sourceRead.text}\n`);
    const locators = sourceRead.segments.map((segment) => ({ locator: segment.locator, confidence: segment.confidence }));
    artifacts.push(stagedArtifact('extracted', extractedPath, 'text/plain', locators));
    if (/ocr|tesseract/i.test(sourceRead.extractionMethod)) artifacts.push(stagedArtifact('ocr', extractedPath, 'text/plain', locators));
  }
  const structuredPath = path.join(artifactDir, 'structured.json');
  writeJsonAtomic(structuredPath, sourceRead.structuredJson);
  artifacts.push(stagedArtifact('structured', structuredPath, 'application/json'));
  for (const [index, artifactPath] of (options.generatedArtifactPaths ?? []).entries()) {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      inspection.warnings.push(`generated artifact not found: ${artifactPath}`); inspection.commitAllowed = false; continue;
    }
    const safeName = path.basename(artifactPath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const stagedArtifactPath = path.join(artifactDir, `generated-${index + 1}-${safeName}`);
    stageFile(artifactPath, stagedArtifactPath);
    if (/\.html?$/i.test(stagedArtifactPath)) fs.writeFileSync(stagedArtifactPath, htmlArtifactSafe(fs.readFileSync(stagedArtifactPath, 'utf8')));
    const generatedRead = readDocument(stagedArtifactPath, { ocrProvider: options.ocrProvider });
    artifacts.push(stagedArtifact('generated', stagedArtifactPath, mimeTypeForPath(artifactPath), undefined, generatedRead.text || textAlternative));
  }
  const unsigned = {
    ...inspection, id, graph, scopeType, scopeLabel, documentPath: stagedDocumentPath,
    sourcePath: stagedSourcePath, sourceFilename: path.basename(sourcePath), sourceHash, sourceByteSize: sourceSize,
    sourceMimeType: options.sourceMimeType ?? sourceRead.mimeType,
    extractorVersion: options.extractorVersion ?? sourceRead.extractorVersion ?? null, canonicalizerVersion: options.canonicalizerVersion ?? null,
    canonicalizerPromptHash: options.canonicalizerPromptHash ?? null, canonicalizerModel: options.canonicalizerModel ?? null,
    pageCount: options.pageCount ?? sourceRead.pageCount ?? null, ocrConfidence: options.ocrConfidence ?? sourceRead.ocrConfidence ?? null, role,
    extractionMethod: options.extractionMethod ?? sourceRead.extractionMethod,
    uploaderId: actor.actorId, uploaderRole: actor.role, uploadedAt: now(), intakeStatus: sourceRead.status, artifacts,
    createdAt: now(),
  };
  const proposalHash = sha256(JSON.stringify(unsigned));
  const proposal: Proposal = { ...unsigned, proposalHash };
  writeJsonAtomic(path.join(dir, 'proposal.json'), proposal);
  audit(root, actor.role, actor.actorId, 'ingestion.propose', 'proposal', id, {
    graph, proposalHash, role, sourceHash: proposal.sourceHash, sourceMimeType: proposal.sourceMimeType,
  });
  return proposal;
}

export function loadProposal(root: string, id: string): Proposal {
  if (!/^ing_[a-f0-9-]+$/i.test(id)) throw new TutorError('invalid proposal id', 64);
  const file = path.join(paths(root).proposalsDir, id, 'proposal.json');
  if (!fs.existsSync(file)) throw new TutorError('proposal not found', 66);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Proposal;
}

function vector(text: string, size = 64): number[] {
  const out = Array<number>(size).fill(0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const h = sha256(token);
    const index = Number.parseInt(h.slice(0, 8), 16) % size;
    out[index] += 1;
  }
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

function textSimilarity(left: string, right: string): number {
  const a = new Set(normalizeText(left).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const b = new Set(normalizeText(right).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  return [...a].filter((token) => b.has(token)).length / union.size;
}

export function commitProposal(root: string, actor: ActorContext, proposalId: string, expectedHash: string): { revision: number; graph: string; graphId: string; documentId: string; idempotent: boolean; migration?: Record<string, number> } {
  requireTutor(actor);
  const proposal = loadProposal(root, proposalId);
  if (proposal.proposalHash !== expectedHash) throw new TutorError('proposal hash mismatch', 65);
  if (!proposal.commitAllowed) throw new TutorError('proposal validation failed', 65);
  const classDb = openClass(root);
  const config = classDb.query('SELECT class_name, subject, grade_level, target_age FROM class_config WHERE id=1').get() as {
    class_name: string; subject: string; grade_level: string | number | null; target_age: number | null;
  } | null;
  classDb.close();
  if (!config) throw new TutorError('class is not initialized', 78);

  const db = openCourse(root);
  const graphId = stableId('kg', config.class_name, config.subject, proposal.graph);
  const documentId = stableId('doc', proposal.sourceHash, proposal.documentHash, PARSER_VERSION, proposal.role, proposal.canonicalizerVersion ?? '');
  const prior = db.query('SELECT version,base_document_id FROM knowledge_graphs WHERE id=$id').get({ $id: graphId }) as { version: number; base_document_id: string | null } | null;
  const priorQuestions = db.query(`SELECT id,assessment_ref,body_md,provenance_hash
    FROM content_items WHERE graph_id=$graph AND status='active'
      AND kind IN ('question','mcq') AND assessment_ref IS NOT NULL`).all({ $graph: graphId }) as Array<{
        id: string; assessment_ref: string; body_md: string; provenance_hash: string;
      }>;
  const existingRun = db.query(`SELECT id FROM ingestion_runs WHERE id=$id AND graph_id=$graph AND status='committed'`).get({ $id: proposal.id, $graph: graphId });
  const existingDocument = db.query(`SELECT d.id FROM source_documents d WHERE d.id=$id AND d.role=$role AND (
    EXISTS (SELECT 1 FROM content_items i WHERE i.graph_id=$graph AND i.source_document_id=d.id)
    OR EXISTS (SELECT 1 FROM knowledge_graphs g WHERE g.id=$graph AND g.base_document_id=d.id)
  )`).get({ $id: documentId, $role: proposal.role, $graph: graphId });
  if (existingRun || existingDocument || (proposal.role === 'base' && prior?.base_document_id === documentId)) {
    db.close();
    audit(root, actor.role, actor.actorId, 'ingestion.commit_noop', 'graph', graphId, { revision: prior?.version ?? 0, proposalId, documentId });
    return { revision: prior?.version ?? 0, graph: proposal.graph, graphId, documentId, idempotent: true };
  }
  if (proposal.role !== 'base' && (!prior || !prior.base_document_id)) {
    db.close();
    throw new TutorError('supplemental ingestion requires an existing graph with an approved Base_doc', 65);
  }
  const revision = (prior?.version ?? 0) + 1;
  const migrationSummary = { added: 0, unchanged: 0, revised: 0, retired: 0 };
  const sourceDir = path.join(paths(root).courseDir, 'documents', documentId);
  ensureDir(sourceDir);
  const ext = path.extname(proposal.sourceFilename) || '.bin';
  const originalPath = path.join(sourceDir, `original${ext}`);
  const normalizedPath = path.join(sourceDir, 'normalized.md');
  if (!fs.existsSync(originalPath)) fs.copyFileSync(proposal.sourcePath || proposal.documentPath, originalPath);
  const canonical = canonicalText(proposal.documentPath);
  if (!canonical.text) {
    db.close();
    throw new TutorError('canonical document has no extractable text; provide the fixed tagged Markdown derivative', 65);
  }
  if (!fs.existsSync(normalizedPath)) fs.writeFileSync(normalizedPath, normalizeText(canonical.text) + '\n');

  const previousSource = db.query(`SELECT d.id,d.revision_number FROM source_documents d
    JOIN content_items i ON i.source_document_id=d.id
    WHERE i.graph_id=$graph AND d.role=$role AND COALESCE(d.source_filename,d.filename)=$filename
    ORDER BY d.created_at DESC LIMIT 1`).get({
      $graph: graphId, $role: proposal.role, $filename: proposal.sourceFilename,
    }) as { id: string; revision_number: number } | null;
  const sourceRevisionOf = previousSource && previousSource.id !== documentId ? previousSource.id : null;
  const sourceRevisionNumber = (previousSource?.revision_number ?? 0) + 1;

  db.exec('BEGIN IMMEDIATE');
  try {
    const nextBaseDocumentId = proposal.role === 'base' ? documentId : prior?.base_document_id ?? null;
    db.query(`INSERT INTO knowledge_graphs
      (id,slug,class_name,subject,scope_type,scope_label,title,version,status,base_document_id,created_at)
      VALUES ($id,$slug,$class,$subject,$scopeType,$scopeLabel,$title,$version,'active',$doc,$at)
      ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type,scope_label=excluded.scope_label,title=excluded.title,
      version=excluded.version,status='active',base_document_id=excluded.base_document_id`).run({
        $id: graphId, $slug: proposal.graph, $class: config.class_name, $subject: config.subject,
        $scopeType: proposal.scopeType, $scopeLabel: proposal.scopeLabel, $title: proposal.scopeLabel,
        $version: revision, $doc: nextBaseDocumentId, $at: now(),
      });
    db.query(`INSERT OR IGNORE INTO source_documents
      (id,sha256,filename,mime_type,role,original_path,normalized_path,parser_version,created_at,
       source_sha256,source_mime_type,extraction_method,extractor_version,canonicalizer_version,page_count,ocr_confidence,status,
       source_filename,source_byte_size,uploader_id,uploader_role,uploaded_at,source_revision_of,revision_number,storage_path)
      VALUES ($id,$hash,$filename,$mime,$role,$original,$normalized,$parser,$at,
        $sourceHash,$sourceMime,$extraction,$extractor,$canonicalizer,$pageCount,$ocrConfidence,'active',
        $sourceFilename,$sourceByteSize,$uploaderId,$uploaderRole,$uploadedAt,$sourceRevisionOf,$sourceRevisionNumber,$storagePath)`).run({
        $id: documentId, $hash: proposal.documentHash, $filename: proposal.filename, $mime: proposal.documentMimeType,
        $role: proposal.role, $original: portablePath(root, originalPath), $normalized: portablePath(root, normalizedPath), $parser: PARSER_VERSION, $at: now(),
        $sourceHash: proposal.sourceHash, $sourceMime: proposal.sourceMimeType, $extraction: proposal.extractionMethod,
        $extractor: proposal.extractorVersion, $canonicalizer: proposal.canonicalizerVersion,
        $pageCount: proposal.pageCount, $ocrConfidence: proposal.ocrConfidence,
        $sourceFilename: proposal.sourceFilename, $sourceByteSize: proposal.sourceByteSize, $uploaderId: proposal.uploaderId,
        $uploaderRole: proposal.uploaderRole, $uploadedAt: proposal.uploadedAt, $sourceRevisionOf: sourceRevisionOf, $sourceRevisionNumber: sourceRevisionNumber,
        $storagePath: portablePath(root, originalPath),
      });
    db.query(`UPDATE source_documents SET canonicalizer_prompt_hash=$promptHash,canonicalizer_model=$model WHERE id=$id`).run({
      $id: documentId, $promptHash: proposal.canonicalizerPromptHash, $model: proposal.canonicalizerModel,
    });
    const proposalDir = path.resolve(path.dirname(proposal.documentPath));
    const artifactTargets: Partial<Record<ProposalArtifact['kind'], string>> = {
      original: originalPath,
      canonical: path.join(sourceDir, `canonical${path.extname(proposal.filename) || '.md'}`),
      normalized: normalizedPath,
      extracted: path.join(sourceDir, 'extracted.txt'),
      ocr: path.join(sourceDir, 'ocr.txt'),
      structured: path.join(sourceDir, 'structured.json'),
    };
    for (const artifact of proposal.artifacts ?? []) {
      const source = path.resolve(artifact.path);
      if (source !== path.resolve(proposal.documentPath) && !source.startsWith(`${proposalDir}${path.sep}`)) throw new TutorError('proposal artifact escaped its staging directory', 65);
      const target = artifact.kind === 'generated'
        ? path.join(sourceDir, 'artifacts', path.basename(source))
        : artifactTargets[artifact.kind];
      if (!target) continue;
      if (artifact.kind === 'ocr' && target === artifactTargets.extracted) continue;
      ensureDir(path.dirname(target));
      if (!fs.existsSync(target) || artifact.kind === 'canonical' || artifact.kind === 'structured') fs.copyFileSync(source, target);
      const targetStat = fs.statSync(target);
      db.query(`INSERT OR IGNORE INTO source_artifacts
        (id,source_document_id,kind,path,mime_type,sha256,byte_size,locator_json,text_alternative,status,created_at)
        VALUES ($id,$document,$kind,$path,$mime,$hash,$size,$locators,$textAlternative,'active',$at)`).run({
        $id: stableId('artifact', documentId, artifact.kind, artifact.sha256), $document: documentId, $kind: artifact.kind,
        $path: portablePath(root, target), $mime: artifact.mimeType, $hash: artifact.sha256, $size: targetStat.size,
          $locators: JSON.stringify(artifact.locators ?? []), $textAlternative: artifact.textAlternative ?? null, $at: now(),
        });
    }
    const normalizedStat = fs.statSync(normalizedPath);
    db.query(`INSERT OR IGNORE INTO source_artifacts
      (id,source_document_id,kind,path,mime_type,sha256,byte_size,locator_json,status,created_at)
      VALUES ($id,$document,'normalized',$path,'text/markdown',$hash,$size,'[]','active',$at)`).run({
        $id: stableId('artifact', documentId, 'normalized', sha256File(normalizedPath)), $document: documentId,
        $path: portablePath(root, normalizedPath), $hash: sha256File(normalizedPath), $size: normalizedStat.size, $at: now(),
      });
    if (proposal.role === 'base' && prior?.base_document_id && prior.base_document_id !== documentId) {
      db.query(`UPDATE content_items SET status='retired' WHERE graph_id=$graph AND source_document_id=$doc`).run({ $graph: graphId, $doc: prior.base_document_id });
      db.query(`UPDATE concept_edges SET status='retired' WHERE graph_id=$graph AND source_document_id=$doc`).run({ $graph: graphId, $doc: prior.base_document_id });
      db.query("UPDATE source_documents SET status='superseded' WHERE id=$id").run({ $id: prior.base_document_id });
    }
    if (sourceRevisionOf) {
      db.query("UPDATE content_items SET status='retired' WHERE source_document_id=$id AND status='active'").run({ $id: sourceRevisionOf });
      db.query("UPDATE concept_edges SET status='retired' WHERE source_document_id=$id AND status='active'").run({ $id: sourceRevisionOf });
      db.query("UPDATE source_documents SET status='superseded' WHERE id=$id").run({ $id: sourceRevisionOf });
    }
    const conceptId = new Map<string, string>();
    const conceptMeta = new Map<string, { code: string; canonicalId: string }>();
    const registryRows = db.query(`SELECT id,code,source_code,title,definition,canonical_path,canonical_concept_id,aliases_json,status
      FROM concepts WHERE graph_id=$graph AND status='active'`).all({ $graph: graphId }) as Array<{
        id: string; code: string; source_code: string | null; title: string; definition: string; canonical_path: string;
        canonical_concept_id: string | null; aliases_json: string; status: string;
      }>;
    const registryBySource = new Map(registryRows.filter((row) => row.source_code).map((row) => [row.source_code!, row]));
    const conceptsToPersist = proposal.role === 'base'
      ? proposal.concepts
      : registryRows.filter((row) => row.source_code).map((row) => ({
        sourceCode: row.source_code!, code: row.code, title: row.title, definition: row.definition,
        canonicalPath: row.canonical_path, aliases: JSON.parse(row.aliases_json || '[]') as string[],
      }));
    const activeSources = new Set(conceptsToPersist.map((concept) => concept.sourceCode));
    if (proposal.role === 'base') {
      db.query(`UPDATE concepts SET status='retired' WHERE graph_id=$graph AND status='active'
        AND source_code IS NOT NULL AND source_code NOT IN (${[...activeSources].map((_, i) => `$source${i}`).join(',') || "''"})`).run({
          $graph: graphId, ...Object.fromEntries([...activeSources].map((source, i) => [`$source${i}`, source])),
        });
    }
    const usedCodes = new Set(registryRows.filter((row) => row.status !== 'retired').map((row) => row.code));
    for (const concept of conceptsToPersist) {
      const previous = registryBySource.get(concept.sourceCode);
      const id = previous?.id ?? stableId('cpt', graphId, concept.sourceCode);
      const code = previous?.code ?? (usedCodes.has(concept.code) ? nextDisplayCode(db, graphId) : concept.code);
      usedCodes.add(code);
      const canonicalId = previous?.canonical_concept_id ?? stableId('ccpt', config.class_name, config.subject, concept.sourceCode);
      const canonicalPath = previous?.canonical_path ?? `source:${concept.sourceCode}`;
      conceptId.set(concept.sourceCode, id);
      conceptMeta.set(concept.sourceCode, { code, canonicalId });
      db.query(`INSERT INTO canonical_concepts
        (id,class_name,subject,canonical_path,title,aliases_json,status,created_at,updated_at)
        VALUES ($id,$class,$subject,$path,$title,$aliases,'active',$at,$at)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,
        aliases_json=excluded.aliases_json,status='active',updated_at=excluded.updated_at`).run({
          $id: canonicalId, $class: config.class_name, $subject: config.subject,
          $path: canonicalPath, $title: concept.title,
          $aliases: JSON.stringify(concept.aliases), $at: now(),
        });
      db.query(`INSERT INTO concepts
        (id,graph_id,code,source_code,title,definition,objective,canonical_path,status,aliases_json,canonical_concept_id)
        VALUES ($id,$graph,$code,$source,$title,$definition,'',$path,'active',$aliases,$canonical)
        ON CONFLICT(id) DO UPDATE SET code=excluded.code,title=excluded.title,definition=excluded.definition,
        aliases_json=excluded.aliases_json,canonical_concept_id=excluded.canonical_concept_id,status='active'`).run({
          $id: id, $graph: graphId, $code: code, $source: concept.sourceCode, $title: concept.title,
          $definition: concept.definition, $path: canonicalPath, $aliases: JSON.stringify(concept.aliases),
          $canonical: canonicalId,
        });
    }
    for (const row of registryRows) {
      const meta = { code: row.code, canonicalId: row.canonical_concept_id ?? row.id };
      for (const ref of [row.source_code, row.code, row.canonical_concept_id].filter((value): value is string => Boolean(value))) {
        conceptId.set(ref, row.id);
        conceptMeta.set(ref, meta);
      }
    }
    for (const edge of proposal.edges) {
      const from = conceptId.get(edge.from);
      const to = conceptId.get(edge.to);
      if (!from || !to) continue;
      db.query(`INSERT OR IGNORE INTO concept_edges
        (id,graph_id,from_concept_id,to_concept_id,type,confidence,source_document_id,rationale)
        VALUES ($id,$graph,$from,$to,$type,1,$doc,$rationale)`).run({
          $id: stableId('edge', graphId, from, to, edge.type), $graph: graphId, $from: from, $to: to,
          $type: edge.type, $doc: documentId, $rationale: edge.rationale,
        });
      db.query(`UPDATE concept_edges SET status='active',source_document_id=$doc,rationale=$rationale
        WHERE id=$id`).run({ $id: stableId('edge', graphId, from, to, edge.type), $doc: documentId, $rationale: edge.rationale });
    }
    const insertedHashes = new Set<string>();
    const questionIds = new Map<string, string>();
    const answerIds = new Map<string, string>();
    for (const item of proposal.items) {
      const normalizedHash = sha256(normalizeText(item.body).toLowerCase());
      if (item.duplicateOf) continue;
      const linkedConcepts = item.conceptRefs.flatMap((ref) => {
        const direct = conceptMeta.get(ref);
        if (direct) return [direct];
        const alias = [...conceptMeta.entries()].find(([source]) => source.startsWith(`${ref}_`))?.[1];
        return alias ? [alias] : [];
      });
      const mappingHash = sha256(JSON.stringify(linkedConcepts.map((concept) => concept.canonicalId).sort()));
      const dedupeKey = sha256(`${normalizedHash}\u001f${item.itemType ?? item.kind}\u001f${mappingHash}`);
      if (insertedHashes.has(dedupeKey)) continue;
      insertedHashes.add(dedupeKey);
      const existingCandidates = db.query(`SELECT id FROM content_items
        WHERE graph_id=$graph AND kind=$kind AND provenance_hash=$hash AND status='active'`).all({
          $graph: graphId, $kind: item.kind, $hash: normalizedHash,
        }) as Array<{ id: string }>;
      const existing = existingCandidates.find((candidate) => {
        const existingMapping = db.query(`SELECT COALESCE(c.canonical_concept_id,c.id) AS canonical_id
          FROM item_concepts ic JOIN concepts c ON c.id=ic.concept_id WHERE ic.item_id=$item ORDER BY canonical_id`).all({ $item: candidate.id }) as Array<{ canonical_id: string }>;
        return sha256(JSON.stringify(existingMapping.map((row) => row.canonical_id))) === mappingHash;
      });
      const itemId = existing?.id ?? stableId('item', graphId, documentId, normalizedHash, item.itemType ?? item.kind, mappingHash);
      if (item.assessmentRef) questionIds.set(item.assessmentRef, itemId);
      if (item.answerForRef) answerIds.set(item.answerForRef, itemId);
      if (!existing && item.assessmentRef && (item.kind === 'question' || item.kind === 'mcq')) {
        db.query(`UPDATE content_items SET status='retired' WHERE graph_id=$graph AND assessment_ref=$ref AND id<>$id`)
          .run({ $graph: graphId, $ref: item.assessmentRef, $id: itemId });
        db.query(`UPDATE content_items SET status='retired' WHERE graph_id=$graph AND answer_for_ref=$ref AND id<>$id`)
          .run({ $graph: graphId, $ref: item.assessmentRef, $id: itemId });
      }
      if (existing) continue;
      const tags = contentItemTags(item, linkedConcepts, proposal.graph, documentId, proposal.role, config);
      const provenance = item.provenance ?? 'source-authored';
      const generated = proposal.role === 'generated_material' || provenance === 'generated' || provenance === 'agent-generated' ? 1 : 0;
      db.query(`INSERT OR IGNORE INTO content_items
        (id,graph_id,kind,item_type,title,body_md,difficulty,original_difficulty,source_document_id,source_locator,source_reference,provenance_hash,generated,assessment_ref,answer_for_ref,tags_json,provenance,confidence)
        VALUES ($id,$graph,$kind,$itemType,$title,$body,$difficulty,$originalDifficulty,$doc,$locator,$sourceReference,$hash,$generated,$assessmentRef,$answerForRef,$tags,$provenance,$confidence)`).run({
          $id: itemId, $graph: graphId, $kind: item.kind, $title: item.title, $body: item.body,
          $difficulty: item.difficulty, $originalDifficulty: item.originalDifficulty, $doc: documentId,
          $itemType: item.itemType ?? item.kind, $locator: item.locator, $sourceReference: item.sourceReference ?? item.locator,
          $hash: normalizedHash, $generated: generated, $assessmentRef: item.assessmentRef, $answerForRef: item.answerForRef,
          $tags: JSON.stringify(tags), $provenance: provenance, $confidence: item.confidence ?? 1,
        });
      db.query("UPDATE content_items SET status='active' WHERE id=$id").run({ $id: itemId });
      for (const ref of item.conceptRefs) {
        const direct = conceptId.get(ref);
        const alias = direct ?? [...conceptId.entries()].find(([source]) => source.startsWith(`${ref}_`))?.[1];
        if (alias) db.query(`INSERT OR IGNORE INTO item_concepts (item_id,concept_id,relation,weight)
          VALUES ($item,$concept,'primary',1)`).run({ $item: itemId, $concept: alias });
      }
      db.query(`INSERT OR REPLACE INTO embeddings (content_hash,item_id,model,vector_json,created_at)
        VALUES ($hash,$item,'hash-bow-v1',$vector,$at)`).run({
          $hash: normalizedHash, $item: itemId, $vector: JSON.stringify(vector(`${item.title} ${item.body}`)), $at: now(),
        });
      try {
        db.query('INSERT INTO content_fts (item_id,title,body) VALUES ($id,$title,$body)').run({ $id: itemId, $title: item.title, $body: item.body });
      } catch { /* bounded LIKE fallback remains available */ }
    }
    for (const item of proposal.items.filter((candidate) => candidate.assessmentRef && (candidate.kind === 'question' || candidate.kind === 'mcq'))) {
      const questionId = questionIds.get(item.assessmentRef!);
      if (!questionId) continue;
      const answerId = answerIds.get(item.assessmentRef!);
      const linkedAnswer = answerId
        ? db.query("SELECT body_md FROM content_items WHERE id=$id AND status='active'").get({ $id: answerId }) as { body_md: string } | null
        : null;
      const spec = item.assessmentSpec ?? assessmentSpec({ body: '', attrs: {} });
      const criteria = spec.criteria.length ? spec.criteria : linkedAnswer ? [{
        id: 'answer-key', description: 'The response is accurate against the approved answer key and explains the reasoning.',
        weight: 1, evidence: linkedAnswer.body_md,
      }] : [];
      const acceptableAnswers = [...new Set([...spec.acceptableAnswers, ...(linkedAnswer ? [linkedAnswer.body_md] : [])])];
      const metadataTags = [...new Set([
        ...spec.tags, ...item.conceptRefs.map((ref) => `concept:${ref}`),
        ...(item.difficulty ? [`difficulty:${item.difficulty}`] : []),
        ...(spec.cognitiveLevel ? [`cognitive:${spec.cognitiveLevel}`] : []),
      ])];
      db.query(`INSERT INTO assessment_specs
        (question_item_id,answer_item_id,rubric_json,acceptable_answers_json,misconceptions_json,distractors_json,
         cognitive_level,estimated_minutes,age_min,age_max,tags_json,updated_at)
        VALUES ($question,$answer,$rubric,$acceptable,$misconceptions,$distractors,$cognitive,$minutes,$ageMin,$ageMax,$tags,$at)
        ON CONFLICT(question_item_id) DO UPDATE SET answer_item_id=excluded.answer_item_id,rubric_json=excluded.rubric_json,
        acceptable_answers_json=excluded.acceptable_answers_json,misconceptions_json=excluded.misconceptions_json,
        distractors_json=excluded.distractors_json,cognitive_level=excluded.cognitive_level,
        estimated_minutes=excluded.estimated_minutes,age_min=excluded.age_min,age_max=excluded.age_max,
        tags_json=excluded.tags_json,updated_at=excluded.updated_at`).run({
          $question: questionId, $answer: answerId ?? null,
          $rubric: JSON.stringify({ schema: 1, criteria }), $acceptable: JSON.stringify(acceptableAnswers),
          $misconceptions: JSON.stringify(spec.misconceptions), $distractors: JSON.stringify(spec.distractors),
          $cognitive: spec.cognitiveLevel, $minutes: spec.estimatedMinutes, $ageMin: spec.ageMin, $ageMax: spec.ageMax,
          $tags: JSON.stringify(metadataTags), $at: now(),
        });
    }
    const newQuestions = db.query(`SELECT id,assessment_ref,body_md,provenance_hash FROM content_items
      WHERE graph_id=$graph AND status='active' AND kind IN ('question','mcq')
        AND assessment_ref IS NOT NULL`).all({ $graph: graphId }) as Array<{
          id: string; assessment_ref: string; body_md: string; provenance_hash: string;
        }>;
    const priorByRef = new Map(priorQuestions.map((question) => [question.assessment_ref, question]));
    const newRefs = new Set(newQuestions.map((question) => question.assessment_ref));
    for (const question of newQuestions) {
      const before = priorByRef.get(question.assessment_ref);
      const changeType = !before ? 'added' : before.provenance_hash === question.provenance_hash ? 'unchanged' : 'revised';
      migrationSummary[changeType] += 1;
      db.query(`INSERT INTO assessment_item_lineage
        (id,graph_id,from_item_id,to_item_id,assessment_ref,change_type,evidence_policy,similarity,from_revision,to_revision,created_at)
        VALUES ($id,$graph,$from,$to,$ref,$change,$policy,$similarity,$fromRevision,$toRevision,$at)`).run({
          $id: stableId('lineage', graphId, before?.id ?? 'none', question.id, String(revision)),
          $graph: graphId, $from: before?.id ?? null, $to: question.id, $ref: question.assessment_ref,
          $change: changeType, $policy: changeType === 'unchanged' ? 'carry' : 'reset',
          $similarity: before ? textSimilarity(before.body_md, question.body_md) : 0,
          $fromRevision: prior?.version ?? null, $toRevision: revision, $at: now(),
        });
    }
    for (const question of priorQuestions.filter((candidate) => !newRefs.has(candidate.assessment_ref))) {
      migrationSummary.retired += 1;
      db.query(`INSERT INTO assessment_item_lineage
        (id,graph_id,from_item_id,to_item_id,assessment_ref,change_type,evidence_policy,similarity,from_revision,to_revision,created_at)
        VALUES ($id,$graph,$from,NULL,$ref,'retired','reset',0,$fromRevision,$toRevision,$at)`).run({
          $id: stableId('lineage', graphId, question.id, 'retired', String(revision)), $graph: graphId,
          $from: question.id, $ref: question.assessment_ref, $fromRevision: prior?.version ?? null,
          $toRevision: revision, $at: now(),
        });
    }
    const revisionId = stableId('rev', graphId, String(revision), proposal.proposalHash);
    db.query(`INSERT INTO graph_revisions (id,graph_id,version,proposal_hash,summary_json,created_at,revision_kind)
      VALUES ($id,$graph,$version,$hash,$summary,$at,$kind)`).run({
        $id: revisionId, $graph: graphId, $version: revision, $hash: proposal.proposalHash,
        $summary: JSON.stringify({ concepts: proposal.concepts.length, edges: proposal.edges.length, items: proposal.items.length, assessment_migration: migrationSummary }), $at: now(),
        $kind: proposal.role === 'base' ? 'ontology' : 'enrichment',
      });
    db.query(`INSERT INTO ingestion_runs (id,graph_id,document_id,status,proposal_hash,warnings_json,created_at,committed_at)
      VALUES ($id,$graph,$doc,'committed',$hash,$warnings,$at,$at)`).run({
        $id: proposal.id, $graph: graphId, $doc: documentId, $hash: proposal.proposalHash,
        $warnings: JSON.stringify(proposal.warnings), $at: now(),
      });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  const graphDir = path.join(paths(root).graphsDir, graphId);
  const snippetDir = path.join(graphDir, 'snippets');
  ensureDir(snippetDir);
  const conceptRows = db.query("SELECT id,code,title,definition,source_code,canonical_concept_id FROM concepts WHERE graph_id=$graph AND status='active' ORDER BY code").all({ $graph: graphId }) as Record<string, string>[];
  const edgeRows = db.query(`SELECT a.code AS from_code,b.code AS to_code,e.type FROM concept_edges e
    JOIN concepts a ON a.id=e.from_concept_id JOIN concepts b ON b.id=e.to_concept_id WHERE e.graph_id=$graph AND e.status='active'`).all({ $graph: graphId }) as Record<string, string>[];
  const graphMd = [`# ${proposal.scopeLabel}`, '', `Revision: ${revision}`, '', '## Concepts', ...conceptRows.map((c) => `- ${c.code}: ${c.title} (${c.canonical_concept_id})`), '', '## Edges', ...edgeRows.map((e) => `- ${e.from_code} --${e.type}--> ${e.to_code}`), ''].join('\n');
  fs.writeFileSync(path.join(graphDir, 'graph.md'), graphMd);
  for (const concept of conceptRows) {
    const items = db.query(`SELECT i.* FROM content_items i JOIN item_concepts ic ON ic.item_id=i.id
      WHERE ic.concept_id=$concept AND i.status='active' ORDER BY i.kind,i.id`).all({ $concept: concept.id }) as Record<string, string | null>[];
    for (const item of items) {
      const file = path.join(snippetDir, concept.code, `${item.id}.md`);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, `---\nitem_id: ${item.id}\nconcept_id: ${concept.id}\ncanonical_concept_id: ${concept.canonical_concept_id}\nconcept_code: ${concept.code}\nkind: ${item.kind}\ndifficulty: ${item.difficulty ?? ''}\nassessment_ref: ${item.assessment_ref ?? ''}\nanswer_for_ref: ${item.answer_for_ref ?? ''}\ntags: ${item.tags_json ?? '[]'}\nsource_document_id: ${documentId}\nsource_locator: ${item.source_locator}\nsource_hash: ${proposal.documentHash}\ngraph_revision: ${revision}\n---\n\n# ${item.title}\n\n${item.body_md}\n`);
    }
  }
  db.close();
  audit(root, actor.role, actor.actorId, 'ingestion.commit', 'graph', graphId, { revision, proposalId, proposalHash: expectedHash });
  return { revision, graph: proposal.graph, graphId, documentId, idempotent: false, migration: migrationSummary };
}

export function showGraph(root: string, slug: string): unknown {
  const db = openCourse(root);
  try {
    const graph = db.query('SELECT * FROM knowledge_graphs WHERE slug=$slug').get({ $slug: slug }) as Record<string, unknown> | null;
    if (!graph) throw new TutorError('knowledge graph not found', 66);
    const graphId = String(graph.id);
    const concepts = db.query('SELECT id,canonical_concept_id,code,source_code,title,definition,status FROM concepts WHERE graph_id=$id ORDER BY code').all({ $id: graphId });
    const edges = db.query(`SELECT a.code AS from_code,b.code AS to_code,e.type,e.rationale
      FROM concept_edges e JOIN concepts a ON a.id=e.from_concept_id JOIN concepts b ON b.id=e.to_concept_id
      WHERE e.graph_id=$id ORDER BY a.code,b.code`).all({ $id: graphId });
    const revisions = db.query('SELECT id,version,proposal_hash,summary_json,revision_kind,created_at FROM graph_revisions WHERE graph_id=$id ORDER BY version').all({ $id: graphId });
    return { graph, concepts, edges, revisions };
  } finally {
    db.close();
  }
}
