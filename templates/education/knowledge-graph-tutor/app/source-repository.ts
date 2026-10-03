import fs from 'node:fs';
import path from 'node:path';

import { type ActorContext, requireStudent, requireTutor } from './context';
import { openCourse, paths } from './store';
import { TutorError } from './util';

function resolveStored(root: string, stored: string): string {
  const value = path.isAbsolute(stored) ? stored : path.resolve(root, stored);
  const rootPath = path.resolve(root);
  if (value !== rootPath && !value.startsWith(`${rootPath}${path.sep}`)) throw new TutorError('source artifact path escaped tutor storage', 77);
  return value;
}

function artifactRows(root: string, db: any, documentId: string): unknown[] {
  return (db.query(`SELECT id,kind,path,mime_type,sha256,byte_size,locator_json,text_alternative,status
    FROM source_artifacts WHERE source_document_id=$document AND status='active' ORDER BY kind`).all({ $document: documentId }) as Array<Record<string, unknown>>)
    .map((row) => ({
      ...row,
      path: resolveStored(root, String(row.path)),
      exists: fs.existsSync(resolveStored(root, String(row.path))),
      locators: (() => { try { return JSON.parse(String(row.locator_json ?? '[]')); } catch { return []; } })(),
    }));
}

export function listSourceDocuments(root: string, actor: ActorContext, graph?: string): unknown {
  const tutor = actor.role === 'tutor';
  if (tutor) requireTutor(actor); else requireStudent(actor);
  const db = openCourse(root);
  try {
    const rows = db.query(`SELECT DISTINCT d.*,g.slug AS graph_slug,g.version AS graph_version
      FROM source_documents d
      JOIN knowledge_graphs g ON g.base_document_id=d.id
        OR EXISTS (SELECT 1 FROM content_items i WHERE i.source_document_id=d.id AND i.graph_id=g.id)
      WHERE ($activeOnly=0 OR d.status='active') AND ($graph IS NULL OR g.slug=$graph)
      ORDER BY d.created_at DESC`).all({ $activeOnly: tutor ? 0 : 1, $graph: graph ?? null }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), filename: String(row.source_filename ?? row.filename), canonical_filename: String(row.filename), role: String(row.role), status: String(row.status),
      source_hash: row.source_sha256, canonical_hash: row.sha256, mime_type: row.source_mime_type ?? row.mime_type, byte_size: row.source_byte_size,
      extraction_method: row.extraction_method, extractor_version: row.extractor_version, canonicalizer_version: row.canonicalizer_version,
      page_count: row.page_count, ocr_confidence: row.ocr_confidence, uploader_id: tutor ? row.uploader_id : undefined,
      uploader_role: tutor ? row.uploader_role : undefined,
      uploaded_at: row.uploaded_at ?? row.created_at, source_revision_of: row.source_revision_of, revision_number: row.revision_number,
      graph: row.graph_slug, graph_revision: row.graph_version, artifacts: artifactRows(root, db, String(row.id)),
    }));
  } finally { db.close(); }
}

export function getSourceDocument(root: string, actor: ActorContext, id: string): unknown {
  if (!/^doc_[a-f0-9-]+$/i.test(id)) throw new TutorError('invalid source document id', 64);
  const db = openCourse(root);
  try {
    const row = db.query(`SELECT d.*,EXISTS(SELECT 1 FROM knowledge_graphs g WHERE g.base_document_id=d.id AND g.status='active') AS is_base,
      EXISTS(SELECT 1 FROM content_items i WHERE i.source_document_id=d.id AND i.status='active') AS has_active_content
      FROM source_documents d WHERE d.id=$id`).get({ $id: id }) as Record<string, unknown> | null;
    if (!row || (actor.role === 'student' && (row.status !== 'active' || (!row.is_base && !row.has_active_content)))) throw new TutorError('source document not found', 66);
    if (actor.role === 'student') requireStudent(actor); else requireTutor(actor);
    return {
      id, filename: String(row.source_filename ?? row.filename), canonical_filename: String(row.filename), role: row.role, status: row.status,
      source_hash: row.source_sha256, canonical_hash: row.sha256, mime_type: row.source_mime_type ?? row.mime_type, byte_size: row.source_byte_size,
      extraction_method: row.extraction_method, extractor_version: row.extractor_version, canonicalizer_version: row.canonicalizer_version,
      page_count: row.page_count, ocr_confidence: row.ocr_confidence, uploaded_at: row.uploaded_at ?? row.created_at,
      uploader_id: actor.role === 'tutor' ? row.uploader_id : undefined,
      uploader_role: actor.role === 'tutor' ? row.uploader_role : undefined,
      source_revision_of: row.source_revision_of, revision_number: row.revision_number,
      original_path: resolveStored(root, String(row.original_path)), normalized_path: resolveStored(root, String(row.normalized_path)),
      artifacts: artifactRows(root, db, id),
      delivery: 'Use send_file with original_path or normalized_path; extracted/OCR/structured artifacts are available in artifacts.',
    };
  } finally { db.close(); }
}

export function sourceStorageSummary(root: string, actor: ActorContext): unknown {
  requireTutor(actor);
  const documents = listSourceDocuments(root, actor) as unknown[];
  return { documents, storage_root: paths(root).documentsDir };
}
