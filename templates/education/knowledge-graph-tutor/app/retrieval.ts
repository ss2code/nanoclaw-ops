import { type ActorContext } from './context';
import { resolveConcept } from './concepts';
import { openCourse, openStudent } from './store';
import { appendTrace } from './trace';
import { canonicalDifficulty, sha256, TutorError } from './util';

function queryVector(text: string, size = 64): number[] {
  const out = Array<number>(size).fill(0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const index = Number.parseInt(sha256(token).slice(0, 8), 16) % size;
    out[index] += 1;
  }
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
  return out.map((value) => value / norm);
}

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

export function searchCourse(root: string, actor: ActorContext, query: string, conceptRef?: string, difficultyValue?: string, limit = 8, traceId?: string): unknown {
  const resolved = conceptRef ? resolveConcept(root, conceptRef) : null;
  const db = openCourse(root);
  try {
    const difficulty = difficultyValue ? canonicalDifficulty(difficultyValue) : null;
    if (difficultyValue && !difficulty) throw new TutorError('difficulty must be low, medium, or high', 64);
    const rows = db.query(`SELECT i.id,i.graph_id,i.kind,i.title,i.body_md,i.difficulty,i.source_document_id,
      i.assessment_ref,i.answer_for_ref,
      i.source_locator,i.provenance_hash,e.vector_json,g.version AS graph_revision,
      GROUP_CONCAT(c.code) AS concept_codes,GROUP_CONCAT(c.id) AS concept_ids,
      GROUP_CONCAT(COALESCE(c.canonical_concept_id,c.code)) AS canonical_concept_ids,
      CASE WHEN SUM(CASE WHEN COALESCE(c.canonical_concept_id,c.code)=$concept THEN 1 ELSE 0 END)>0 THEN 1 ELSE 0 END AS concept_match
      FROM content_items i
      JOIN knowledge_graphs g ON g.id=i.graph_id
      LEFT JOIN embeddings e ON e.item_id=i.id
      LEFT JOIN item_concepts ic ON ic.item_id=i.id LEFT JOIN concepts c ON c.id=ic.concept_id
      WHERE i.status='active' AND ($concept IS NULL OR EXISTS (
        SELECT 1 FROM item_concepts ic2 JOIN concepts c2 ON c2.id=ic2.concept_id
        WHERE ic2.item_id=i.id AND COALESCE(c2.canonical_concept_id,c2.code)=$concept
      )) AND ($difficulty IS NULL OR i.difficulty IS NULL OR i.difficulty=$difficulty)
      GROUP BY i.id LIMIT 300`).all({
        $concept: resolved?.canonical_id ?? null, $difficulty: difficulty,
      }) as Array<Record<string, string | number | null>>;
    const qv = queryVector(query);
    const tokens = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const results = rows.map((row) => {
      const haystack = `${row.title} ${row.body_md}`.toLowerCase();
      const lexical = [...tokens].filter((token) => haystack.includes(token)).length / Math.max(1, tokens.size);
      const semantic = row.vector_json ? cosine(qv, JSON.parse(String(row.vector_json))) : 0;
      const conceptBoost = Number(row.concept_match) ? 0.25 : 0;
      const body = String(row.body_md ?? '');
      const maxBodyChars = 6000;
      return {
        snippet_id: row.id,
        kind: row.kind,
        title: row.title,
        body_md: body.slice(0, maxBodyChars),
        body_truncated: body.length > maxBodyChars,
        difficulty: row.difficulty,
        assessment_ref: row.assessment_ref,
        answer_for_ref: row.answer_for_ref,
        concept_ids: row.concept_ids ? String(row.concept_ids).split(',') : [],
        concept_codes: row.concept_codes ? String(row.concept_codes).split(',') : [],
        canonical_concept_ids: row.canonical_concept_ids ? String(row.canonical_concept_ids).split(',') : [],
        source_document_id: row.source_document_id,
        source_locator: row.source_locator,
        source_hash: row.provenance_hash,
        graph_revision: row.graph_revision,
        score: Number((lexical * 0.55 + semantic * 0.45 + conceptBoost).toFixed(6)),
      };
    }).filter((result) => result.score > 0 || (query.trim() === '' && result.concept_ids.length > 0))
      .sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 20)));
    if (traceId && actor.role === 'student') {
      const student = openStudent(root, actor.studentId);
      appendTrace(student, actor.studentId, traceId, 'retrieval', resolved?.canonical_id ?? null, {
        query_hash: sha256(query), difficulty, hit_count: results.length,
        sources: results.map((result) => ({
          snippet_id: result.snippet_id, source_document_id: result.source_document_id,
          source_locator: result.source_locator, source_hash: result.source_hash,
          graph_revision: result.graph_revision, score: result.score,
        })),
      });
      student.close();
    }
    return { query, concept: resolved?.canonical_id ?? null, display_code: resolved?.display_code ?? null, difficulty, hit_count: results.length, results };
  } finally {
    db.close();
  }
}
