import { normalizeText } from './util';

export const CANONICALIZATION_SCHEMA_VERSION = 1;
export const CANONICALIZER_PROMPT_VERSION = 'kg-tutor-canonicalizer-v1';

export const CANONICAL_ITEM_TYPES = [
  'explanation', 'definition', 'worked_example', 'question', 'practice_question', 'answer',
  'flashcard', 'glossary', 'misconception', 'essay', 'artifact',
] as const;
export type CanonicalItemType = typeof CANONICAL_ITEM_TYPES[number];
export const CANONICAL_PROVENANCE = ['source-authored', 'generated', 'teacher-provided', 'agent-generated', 'student-provided'] as const;
export type CanonicalProvenance = typeof CANONICAL_PROVENANCE[number];

export interface CanonicalItem {
  item_type: CanonicalItemType;
  id: string;
  source_reference: string;
  title: string;
  body: string;
  concept_source_codes: string[];
  locator: string;
  provenance: CanonicalProvenance;
  confidence: number;
  problem?: string;
  solution?: string;
  reasoning?: string;
  artifact_paths?: string[];
}

export interface CanonicalDocument {
  schema_version: number;
  source: { filename: string; sha256: string };
  concepts?: Array<{ source_code: string; title: string; definition?: string }>;
  items: CanonicalItem[];
}

export interface CanonicalValidation {
  valid: boolean;
  errors: string[];
  value?: CanonicalDocument;
}

function string(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }

export function validateCanonicalDocument(input: unknown): CanonicalValidation {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['canonical document must be an object'] };
  const document = input as Record<string, unknown>;
  if (document.schema_version !== CANONICALIZATION_SCHEMA_VERSION) errors.push(`schema_version must be ${CANONICALIZATION_SCHEMA_VERSION}`);
  const source = document.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) errors.push('source metadata is required');
  else {
    const sourceRecord = source as Record<string, unknown>;
    if (!string(sourceRecord.filename)) errors.push('source.filename is required');
    if (!isSha256(sourceRecord.sha256)) errors.push('source.sha256 must be a SHA-256 hex digest');
  }
  const concepts = document.concepts ?? [];
  if (!Array.isArray(concepts)) errors.push('concepts must be an array');
  const knownConcepts = new Set<string>();
  for (const [index, concept] of (Array.isArray(concepts) ? concepts : []).entries()) {
    const record = concept && typeof concept === 'object' ? concept as Record<string, unknown> : {};
    if (!string(record.source_code)) errors.push(`concepts[${index}].source_code is required`);
    else if (knownConcepts.has(record.source_code)) errors.push(`concepts[${index}] duplicates source_code ${record.source_code}`);
    else knownConcepts.add(record.source_code);
  }
  if (!Array.isArray(document.items) || document.items.length === 0) errors.push('items must be a non-empty array');
  const ids = new Set<string>();
  for (const [index, item] of (Array.isArray(document.items) ? document.items : []).entries()) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (!CANONICAL_ITEM_TYPES.includes(record.item_type as CanonicalItemType)) errors.push(`items[${index}].item_type is unsupported`);
    if (!string(record.id) || ids.has(record.id as string)) errors.push(`items[${index}].id is required and must be unique`);
    else ids.add(record.id as string);
    for (const field of ['source_reference', 'title', 'body', 'locator']) if (!string(record[field])) errors.push(`items[${index}].${field} is required`);
    if (!Array.isArray(record.concept_source_codes) || record.concept_source_codes.length === 0 || record.concept_source_codes.some((value) => !string(value))) {
      errors.push(`items[${index}].concept_source_codes must contain at least one source code`);
    }
    if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) errors.push(`items[${index}].confidence must be between 0 and 1`);
    if (!CANONICAL_PROVENANCE.includes(record.provenance as CanonicalProvenance)) errors.push(`items[${index}].provenance is unsupported`);
    if (Array.isArray(record.concept_source_codes)) for (const code of record.concept_source_codes) {
      if (!knownConcepts.has(code)) errors.push(`items[${index}] references unknown concept ${String(code)}`);
    }
    if (record.artifact_paths !== undefined && (!Array.isArray(record.artifact_paths) || record.artifact_paths.some((value) => !string(value)))) errors.push(`items[${index}].artifact_paths must be strings`);
  }
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], value: document as unknown as CanonicalDocument };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function itemTag(item: CanonicalItem): string {
  const concept = item.concept_source_codes.join(' ');
  const attrs = ` id="${escapeXml(item.id)}" source_ref="${escapeXml(item.source_reference)}" concept_id="${escapeXml(concept)}" source_locator="${escapeXml(item.locator)}" provenance="${item.provenance}" confidence="${item.confidence}"`;
  if (item.item_type === 'worked_example') return `<worked_example${attrs}><title>${escapeXml(item.title)}</title><problem>${escapeXml(item.problem ?? item.body)}</problem>${item.reasoning ? `<steps><step>${escapeXml(item.reasoning)}</step></steps>` : ''}<solution>${escapeXml(item.solution ?? item.body)}</solution></worked_example>`;
  if (item.item_type === 'question' || item.item_type === 'practice_question') return `<source_question${attrs}><question_text>${escapeXml(item.body)}</question_text></source_question>`;
  if (item.item_type === 'answer') return `<answer${attrs}><answer_text>${escapeXml(item.body)}</answer_text></answer>`;
  if (item.item_type === 'flashcard') return `<flashcard${attrs}>${escapeXml(item.body)}</flashcard>`;
  if (item.item_type === 'glossary' || item.item_type === 'definition') return `<glossary_term${attrs}><term>${escapeXml(item.title)}</term><definition>${escapeXml(item.body)}</definition></glossary_term>`;
  if (item.item_type === 'essay') return `<essay${attrs}>${escapeXml(item.body)}</essay>`;
  if (item.item_type === 'misconception') return `<concept_essay${attrs}><title>${escapeXml(item.title)}</title><content>${escapeXml(item.body)}</content></concept_essay>`;
  return `<concept_essay${attrs}><title>${escapeXml(item.title)}</title><content>${escapeXml(item.body)}</content></concept_essay>`;
}

/** Convert validated JSON into the tagged derivative consumed by the tutor parser. */
export function canonicalDocumentToTaggedMarkdown(document: CanonicalDocument): string {
  const concepts = (document.concepts ?? []).map((concept) => `<concept id="${escapeXml(concept.source_code)}"><concept_name>${escapeXml(concept.title)}</concept_name>${concept.definition ? `<definition>${escapeXml(concept.definition)}</definition>` : ''}</concept>`).join('\n');
  return `# Canonical tutor derivative\n\n<!-- schema_version: ${document.schema_version}; source: ${escapeXml(document.source.filename)} -->\n<document schema_version="${document.schema_version}">\n<concept_graph>\n${concepts}\n</concept_graph>\n${document.items.map(itemTag).join('\n')}\n</document>\n`;
}

/** Bounded JSON parsing for canonicalizer output; malformed output never reaches graph commit. */
export function parseCanonicalDocument(value: string): CanonicalValidation {
  try { return validateCanonicalDocument(JSON.parse(value)); }
  catch { return { valid: false, errors: ['canonicalizer output is not valid JSON'] }; }
}

export function canonicalTextAlternative(document: CanonicalDocument): string {
  return normalizeText(document.items.map((item) => `${item.title}: ${item.body}`).join('\n\n'));
}
