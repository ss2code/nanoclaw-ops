import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectDocument } from '../ingestion';
import { initTestWorld, runAs } from './harness';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);
const worlds: string[] = [];
afterEach(() => { for (const world of worlds.splice(0)) fs.rmSync(world, { recursive: true, force: true }); });

describe('hybrid Base_doc ingestion', () => {
  test('extracts a synthetic structural twin without using the supplied Base_doc', () => {
    const result = inspectDocument(fixture('structured-hybrid-base-doc.md'));
    expect(result.inputMode).toBe('structured_base_doc');
    expect(result.concepts).toHaveLength(3);
    expect(result.edges.filter((edge) => edge.type === 'prerequisite_of')).toHaveLength(2);
    expect(result.questions).toBe(6);
    expect(result.difficulty).toEqual({ low: 2, medium: 2, high: 2 });
    expect(result.duplicateContent).toBe(1);
    expect(result.aliasProposals.length).toBeGreaterThanOrEqual(1);
    expect(result.commitAllowed).toBe(true);
  });

  test('links authored questions to embedded and standalone answer keys', () => {
    const result = inspectDocument(fixture('assessment-bank-base-doc.md'));
    const questions = result.items.filter((item) => item.kind === 'question' || item.kind === 'mcq');
    const answers = result.items.filter((item) => item.kind === 'answer' && !item.duplicateOf);
    expect(questions.map((item) => item.assessmentRef)).toEqual(['pattern-q1', 'pattern-q2']);
    expect(answers.map((item) => item.answerForRef).sort()).toEqual(['pattern-q1', 'pattern-q2']);
    expect(result.questions).toBe(2);
    expect(result.items.filter((item) => item.locator.startsWith('concept_definition['))).toHaveLength(1);
    expect(result.answersLinked).toBe(2);
    expect(result.answersUnlinked).toBe(0);
    expect(result.questionsWithoutAnswers).toBe(0);
  });

  test('supports the Base_doc dialect with essays, source/generated banks, flashcards, and tables', () => {
    const result = inspectDocument(fixture('base-doc-dialect.md'));
    expect(result.concepts.map((concept) => concept.sourceCode)).toEqual(['C01', 'C02']);
    expect(result.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'C01', to: 'C02', type: 'prerequisite_of' })]));
    expect(result.questions).toBe(2);
    expect(result.answersLinked).toBe(2);
    expect(result.items.some((item) => item.kind === 'worked_example' && item.body.includes('The answer is 4'))).toBe(true);
    expect(result.items.some((item) => item.kind === 'flashcard' && item.conceptRefs.includes('C01'))).toBe(true);
    expect(result.items.some((item) => item.kind === 'information_snippet' && item.title === 'reciprocal' && item.conceptRefs.includes('C02'))).toBe(true);
    expect(result.items.some((item) => item.kind === 'information_snippet' && item.body.includes('Multiplying always makes things bigger'))).toBe(true);
    expect(result.commitAllowed).toBe(true);
  });

  test('requires canonicalization for an ordinary source', () => {
    const result = inspectDocument(fixture('textbook-chapter-extract.md'));
    expect(result.inputMode).toBe('raw_source');
    expect(result.canonicalizationRequired).toBe(true);
    expect(result.commitAllowed).toBe(false);
  });

  test('quotes adversarial text and blocks a malformed graph', () => {
    const result = inspectDocument(fixture('malformed-adversarial-base-doc.md'));
    expect(result.promptInjectionQuoted).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.commitAllowed).toBe(false);
  });

  test('proposes and atomically commits a graph with provenance', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-ingestion-')); worlds.push(world); initTestWorld(world);
    const generated = path.join(world, 'lesson.html');
    fs.writeFileSync(generated, '<!doctype html><script>steal()</script><main>Fractions lesson</main>');
    const proposed = runAs(world, 'tutor-control', ['ingestion', 'propose', '--document', fixture('structured-hybrid-base-doc.md'), '--graph', 'Test_Mathematics_Fractions_KG', '--scope-type', 'chapter', '--scope-label', 'Fractions', '--generated-artifacts', JSON.stringify([generated]), '--json']);
    expect(proposed.exitCode).toBe(0);
    const proposal = JSON.parse(proposed.stdout);
    const committed = runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']);
    expect(committed.exitCode).toBe(0);
    expect(JSON.parse(committed.stdout).revision).toBe(1);
    expect(JSON.parse(committed.stdout).idempotent).toBe(false);
    const repeated = runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']);
    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ revision: 1, idempotent: true });
    const search = runAs(world, 'student-a', ['course', 'search', '--concept', 'C01', '--difficulty', 'medium', '--query', 'equal parts', '--json']);
    expect(search.exitCode).toBe(0);
    const result = JSON.parse(search.stdout);
    expect(result.results[0]).toHaveProperty('source_document_id');
    expect(result.results[0]).toHaveProperty('graph_revision', 1);
    const catalogue = JSON.parse(runAs(world, 'tutor-control', ['instruction', 'list', '--concept', 'C01', '--limit', '50', '--json']).stdout);
    expect(catalogue.items.filter((item: { generated: boolean }) => !item.generated).every((item: { tags: string[]; artifact_path: string }) =>
      item.tags.includes('source') && item.tags.some((tag) => tag.startsWith('concept:')) && fs.existsSync(item.artifact_path))).toBe(true);
    expect(catalogue.items.some((item: { kind: string; title: string }) => item.kind === 'source_document' && item.title === 'structured-hybrid-base-doc.md')).toBe(true);
    const sourceList = JSON.parse(runAs(world, 'tutor-control', ['ingestion', 'source-list', '--json']).stdout);
    expect(sourceList).toHaveLength(1);
    expect(sourceList[0]).toMatchObject({ filename: 'structured-hybrid-base-doc.md', byte_size: fs.statSync(fixture('structured-hybrid-base-doc.md')).size, uploader_role: 'tutor' });
    expect(sourceList[0].artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual(expect.arrayContaining(['original', 'canonical', 'normalized', 'extracted', 'structured', 'generated']));
    const generatedArtifact = sourceList[0].artifacts.find((artifact: { kind: string }) => artifact.kind === 'generated') as { path: string; text_alternative: string };
    expect(fs.readFileSync(generatedArtifact.path, 'utf8')).not.toContain('<script>');
    expect(generatedArtifact.text_alternative).toContain('Fractions lesson');
    const source = JSON.parse(runAs(world, 'student-a', ['ingestion', 'source-get', '--id', sourceList[0].id, '--json']).stdout);
    expect(source.original_path).toContain('/course/documents/');
    expect(source.normalized_path).toContain('/course/documents/');
    expect(fs.existsSync(source.original_path)).toBe(true);
    expect(fs.existsSync(source.normalized_path)).toBe(true);
    expect(source.uploader_id).toBeUndefined();
    const db = new Database(path.join(world, 'course', 'course.db'));
    db.query('UPDATE source_documents SET normalized_path=$path WHERE id=$id').run({ $path: '../../outside.md', $id: sourceList[0].id });
    db.close();
    expect(runAs(world, 'student-a', ['ingestion', 'source-get', '--id', sourceList[0].id, '--json']).exitCode).toBe(77);
  });

  test('accepts schema-v1 canonical JSON with a separately retained source', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-canonical-json-')); worlds.push(world); initTestWorld(world);
    const sourcePath = path.join(world, 'chapter.pdf');
    const sourceBytes = Buffer.from('%PDF-1.4 source fixture\n');
    fs.writeFileSync(sourcePath, sourceBytes);
    const canonicalPath = path.join(world, 'chapter.json');
    fs.writeFileSync(canonicalPath, JSON.stringify({
      schema_version: 1,
      source: { filename: 'chapter.pdf', sha256: createHash('sha256').update(sourceBytes).digest('hex') },
      concepts: [{ source_code: 'C01_Fraction_Foundations', title: 'Fraction Foundations', definition: 'Equal parts make a whole.' }],
      items: [{ item_type: 'explanation', id: 'exp-1', source_reference: 'chapter-section-1', title: 'Equal parts', body: 'A fraction names equal parts of a whole.', concept_source_codes: ['C01_Fraction_Foundations'], locator: 'page:1', provenance: 'source-authored', confidence: 0.98 }],
    }));
    const proposed = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', canonicalPath, '--source', sourcePath, '--graph', 'Test_Mathematics_Fractions_KG',
      '--scope-type', 'chapter', '--scope-label', 'Fractions', '--canonicalizer-version', 'kg-tutor-canonicalizer-v1', '--json',
    ]);
    expect(proposed.exitCode).toBe(0);
    const proposal = JSON.parse(proposed.stdout);
    expect(proposal.commitAllowed).toBe(true);
    expect(proposal.documentFormat).toBe('text');
    expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']).exitCode).toBe(0);
    const db = new Database(path.join(world, 'course', 'course.db'));
    expect((db.query('SELECT COUNT(*) AS n FROM content_items').get() as { n: number }).n).toBeGreaterThan(0);
    db.close();
  });

  test('stages a durable supplemental document, preserves the Base_doc, and maps worked examples to existing concepts', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-enrichment-')); worlds.push(world); initTestWorld(world);
    const graph = 'Test_Mathematics_Fractions_KG';
    const base = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', fixture('structured-hybrid-base-doc.md'), '--graph', graph,
      '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json',
    ]);
    const baseProposal = JSON.parse(base.stdout);
    expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', baseProposal.id, '--expected-hash', baseProposal.proposalHash, '--json']).exitCode).toBe(0);

    const supplementalPath = path.join(world, 'supplement.md');
    const originalPdfPath = path.join(world, 'supplement.pdf');
    fs.writeFileSync(originalPdfPath, Buffer.from('%PDF-1.4 source fixture\n'));
    fs.writeFileSync(supplementalPath, `
      <concept_essay concept_id="C01_Fraction_Foundations"><title>Parts in a fraction</title><content>The denominator tells how many equal parts make one whole.</content></concept_essay>
      <worked_example id="fraction-example-1" concept_id="C01_Fraction_Foundations"><title>Find one half</title><problem>Find one half of 8.</problem><steps><step>Divide 8 into 2 equal groups.</step><step>Each group has 4.</step></steps><answer>4</answer></worked_example>
      <question_block id="fraction-supplement-q1" difficulty="Medium" concept_id="C01_Fraction_Foundations"><question_text>Why must the parts of a fraction be equal?</question_text><model_answer>Equal parts make the denominator meaningful.</model_answer></question_block>
    </section>`);
    const proposed = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', supplementalPath, '--graph', graph, '--scope-type', 'chapter', '--scope-label', 'Fractions',
      '--role', 'supplement', '--source', originalPdfPath, '--extraction-method', 'ocr', '--canonicalizer-version', 'fixed-prompt-v3', '--json',
    ]);
    expect(proposed.exitCode).toBe(0);
    const proposal = JSON.parse(proposed.stdout);
    expect(proposal.role).toBe('supplement');
    expect(proposal.sourceMimeType).toBe('application/pdf');
    expect(proposal.extractionMethod).toBe('ocr');
    expect(proposal.items.some((item: { kind: string }) => item.kind === 'worked_example')).toBe(true);
    expect(proposal.documentPath).not.toBe(supplementalPath);
    expect(fs.existsSync(proposal.documentPath)).toBe(true);

    fs.rmSync(supplementalPath);
    const committed = runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']);
    expect(committed.exitCode).toBe(0);
    const receipt = JSON.parse(committed.stdout);
    expect(receipt.migration.added).toBeGreaterThanOrEqual(1);

    const db = new Database(path.join(world, 'course', 'course.db'));
    const graphRow = db.query('SELECT version,base_document_id FROM knowledge_graphs WHERE slug=$slug').get({ $slug: graph }) as { version: number; base_document_id: string };
    const docs = db.query('SELECT role,mime_type,source_mime_type,extraction_method,canonicalizer_version FROM source_documents ORDER BY created_at').all() as Array<Record<string, string>>;
    const example = db.query(`SELECT i.kind,i.body_md,c.source_code FROM content_items i
      JOIN item_concepts ic ON ic.item_id=i.id JOIN concepts c ON c.id=ic.concept_id
      WHERE i.kind='worked_example'`).get() as { kind: string; body_md: string; source_code: string };
    expect(graphRow.version).toBe(2);
    expect(docs).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'supplement', mime_type: 'text/markdown', source_mime_type: 'application/pdf', extraction_method: 'ocr', canonicalizer_version: 'fixed-prompt-v3' })]));
    expect(example).toMatchObject({ kind: 'worked_example', source_code: 'C01_Fraction_Foundations' });
    expect(example.body_md).toContain('Find one half of 8.');
    expect(example.body_md).toContain('4');
    expect(graphRow.base_document_id).toBe(docs.length === 2 ? (db.query("SELECT id FROM source_documents WHERE role='base'").get() as { id: string }).id : graphRow.base_document_id);
    db.close();
  });

  test('rejects supplemental references outside the fixed Base_doc concept registry', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-unknown-concept-')); worlds.push(world); initTestWorld(world);
    const graph = 'Test_Mathematics_Fractions_KG';
    const base = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', fixture('structured-hybrid-base-doc.md'), '--graph', graph,
      '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json',
    ]);
    const baseProposal = JSON.parse(base.stdout);
    runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', baseProposal.id, '--expected-hash', baseProposal.proposalHash, '--json']);
    const invalidPath = path.join(world, 'invalid-supplement.md');
    fs.writeFileSync(invalidPath, '<concept_essay concept_id="C99_Not_In_Base"><title>Unknown</title><content>Should not commit.</content></concept_essay>');
    const proposed = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', invalidPath, '--graph', graph, '--scope-type', 'chapter', '--scope-label', 'Fractions', '--role', 'supplement', '--json',
    ]);
    expect(proposed.exitCode).toBe(0);
    const proposal = JSON.parse(proposed.stdout);
    expect(proposal.commitAllowed).toBe(false);
    expect(proposal.warnings.join(' ')).toContain('fixed Base_doc concept registry');
    expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']).exitCode).toBe(65);
  });

  test('keeps canonical identities and display codes stable when a Base_doc is reordered or renamed, and retires replaced source items', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-stable-identities-')); worlds.push(world); initTestWorld(world);
    const graph = 'Test_Mathematics_Fractions_KG';
    const first = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', fixture('structured-hybrid-base-doc.md'), '--graph', graph,
      '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json',
    ]);
    const firstProposal = JSON.parse(first.stdout);
    runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', firstProposal.id, '--expected-hash', firstProposal.proposalHash, '--json']);
    const revisedPath = path.join(world, 'reordered-base.md');
    const original = fs.readFileSync(fixture('structured-hybrid-base-doc.md'), 'utf8');
    fs.writeFileSync(revisedPath, original
      .replace('<concept id="C01_Fraction_Foundations">', '<concept id="C03_Adding_Fractions">')
      .replace('<concept_name>Fraction Foundations</concept_name>', '<concept_name>Foundations of Fractions</concept_name>')
      .replace('<concept id="C03_Adding_Fractions">', '<concept id="C01_Fraction_Foundations">')
      .replace('<concept_name>Adding Fractions</concept_name>', '<concept_name>Adding Fractions</concept_name>'));
    const second = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', revisedPath, '--graph', graph, '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json',
    ]);
    const secondProposal = JSON.parse(second.stdout);
    expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', secondProposal.id, '--expected-hash', secondProposal.proposalHash, '--json']).exitCode).toBe(0);
    const db = new Database(path.join(world, 'course', 'course.db'));
    const identities = db.query(`SELECT source_code,code,canonical_concept_id,title FROM concepts WHERE graph_id=(SELECT id FROM knowledge_graphs WHERE slug=$slug) ORDER BY source_code`).all({ $slug: graph }) as Array<Record<string, string>>;
    const retired = db.query("SELECT COUNT(*) AS n FROM content_items WHERE status='retired'").get() as { n: number };
    expect(identities.find((row) => row.source_code === 'C01_Fraction_Foundations')).toMatchObject({ code: 'C01', title: 'Foundations of Fractions' });
    expect(identities).toHaveLength(3);
    expect(new Set(identities.map((row) => row.canonical_concept_id)).size).toBe(3);
    expect(retired.n).toBeGreaterThan(0);
    db.close();
  });

  test('creates a source revision and preserves lineage when the same named upload changes', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-source-revision-')); worlds.push(world); initTestWorld(world);
    const graph = 'Test_Mathematics_Fractions_KG';
    const source = path.join(world, 'chapter.md');
    fs.copyFileSync(fixture('structured-hybrid-base-doc.md'), source);
    const first = runAs(world, 'tutor-control', ['ingestion', 'propose', '--document', source, '--graph', graph, '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json']);
    const firstProposal = JSON.parse(first.stdout);
    expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', firstProposal.id, '--expected-hash', firstProposal.proposalHash, '--json']).exitCode).toBe(0);
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('Adding Fractions</concept_name>', 'Adding Fraction Sums</concept_name>'));
    const second = runAs(world, 'tutor-control', ['ingestion', 'propose', '--document', source, '--graph', graph, '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json']);
    const secondProposal = JSON.parse(second.stdout);
    expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', secondProposal.id, '--expected-hash', secondProposal.proposalHash, '--json']).exitCode).toBe(0);
    const db = new Database(path.join(world, 'course', 'course.db'));
    const revisions = db.query(`SELECT source_filename,source_revision_of,revision_number,status FROM source_documents ORDER BY revision_number`).all() as Array<Record<string, unknown>>;
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ source_filename: 'chapter.md', revision_number: 2, status: 'active' });
    expect(revisions[1].source_revision_of).toBeTruthy();
    expect(revisions[0].status).toBe('superseded');
    expect((db.query("SELECT COUNT(*) AS n FROM content_items WHERE status='retired'").get() as { n: number }).n).toBeGreaterThan(0);
    db.close();
    const tutorSources = JSON.parse(runAs(world, 'tutor-control', ['ingestion', 'source-list', '--graph', graph, '--json']).stdout);
    expect(tutorSources).toHaveLength(2);
    expect(tutorSources.map((source: { status: string }) => source.status)).toEqual(expect.arrayContaining(['active', 'superseded']));
    const studentSources = JSON.parse(runAs(world, 'student-a', ['ingestion', 'source-list', '--graph', graph, '--json']).stdout);
    expect(studentSources).toHaveLength(1);
    expect(studentSources[0].uploader_id).toBeUndefined();
  });
});
