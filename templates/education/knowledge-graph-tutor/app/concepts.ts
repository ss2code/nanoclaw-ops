import { openCourse } from './store';
import { TutorError } from './util';

export interface ResolvedConcept {
  canonical_id: string;
  display_code: string;
  title: string;
  canonical_path: string;
}

export function conceptKey(row: { canonical_concept_id?: string | null; code: string }): string {
  return row.canonical_concept_id || row.code;
}

export function resolveConcept(root: string, ref: string): ResolvedConcept {
  const db = openCourse(root);
  try {
    const rows = db.query(`SELECT c.code,c.title,c.canonical_path,c.canonical_concept_id
      FROM concepts c WHERE c.status='active' AND
      (c.canonical_concept_id=$ref OR c.id=$ref OR c.code=$ref OR c.source_code=$ref)
      ORDER BY c.graph_id,c.code`).all({ $ref: ref }) as Array<{
        code: string; title: string; canonical_path: string; canonical_concept_id: string | null;
      }>;
    if (!rows.length) throw new TutorError('concept not found', 66);
    const identities = new Set(rows.map((row) => conceptKey(row)));
    if (identities.size !== 1) throw new TutorError('concept reference is ambiguous; use canonical_concept_id', 65);
    const row = rows[0];
    return {
      canonical_id: conceptKey(row), display_code: row.code, title: row.title, canonical_path: row.canonical_path,
    };
  } finally { db.close(); }
}
