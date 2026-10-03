import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

export interface TutorApplicationGroup {
  id: string;
  name: string;
  folder: string;
}

export interface TutorApplicationStatus {
  id: string;
  name: string;
  folder: string;
  initialized: boolean;
  class: { class_name: string; subject: string } | null;
  students: number;
  graphs: number;
  courseRevisions: number;
  materials: {
    total: number; active: number; proposed: number; missing_files: number; concepts_with_materials: number;
    source_documents?: number; source_items?: number; generated_resources?: number;
  };
}

function resolveStoredPath(root: string, value: string): string {
  if (!value) return value;
  if (!path.isAbsolute(value)) return path.resolve(root, value);
  if (fs.existsSync(value)) return path.resolve(value);
  const normalized = value.replaceAll('\\', '/');
  const marker = '/tutor-app/';
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0 ? path.join(root, ...normalized.slice(markerIndex + marker.length).split('/')) : value;
}

function stableDefinitionId(graphId: string, documentId: string, conceptId: string): string {
  return createHash('sha256').update([graphId, documentId, conceptId].join('\u001f')).digest('hex').slice(0, 20);
}

function readApplicationDatabases(group: TutorApplicationGroup, tutorRoot: string): TutorApplicationStatus {
  const classPath = path.join(tutorRoot, 'class.db');
  const coursePath = path.join(tutorRoot, 'course', 'course.db');
  const initialized = fs.existsSync(classPath);
  let classInfo: TutorApplicationStatus['class'] = null;
  let students = 0;

  if (initialized) {
    const db = new Database(classPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      classInfo = db.prepare('SELECT class_name,subject FROM class_config WHERE id=1').get() as TutorApplicationStatus['class'];
      students = (db.prepare("SELECT COUNT(*) AS n FROM students WHERE status='approved'").get() as { n: number }).n;
    } finally {
      db.close();
    }
  }

  let graphs = 0;
  let courseRevisions = 0;
  let materials: TutorApplicationStatus['materials'] = {
    total: 0, active: 0, proposed: 0, missing_files: 0, concepts_with_materials: 0,
  };
  if (fs.existsSync(coursePath)) {
    const db = new Database(coursePath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      graphs = (db.prepare('SELECT COUNT(*) AS n FROM knowledge_graphs').get() as { n: number }).n;
      courseRevisions = (db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM knowledge_graphs').get() as { n: number }).n;
      try {
        const counts = db.prepare(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status='proposed' THEN 1 ELSE 0 END) AS proposed,
          COUNT(DISTINCT canonical_concept_id) AS concepts_with_materials
          FROM instruction_resources`).get() as {
          total: number; active: number; proposed: number; concepts_with_materials: number;
        };
        const rows = db.prepare(`SELECT artifact_path FROM instruction_resources
          WHERE status IN ('active','proposed')`).all() as Array<{ artifact_path: string }>;
        materials = {
          total: Number(counts.total ?? 0), active: Number(counts.active ?? 0), proposed: Number(counts.proposed ?? 0),
          missing_files: rows.filter((row) => !fs.existsSync(resolveStoredPath(tutorRoot, row.artifact_path))).length,
          concepts_with_materials: Number(counts.concepts_with_materials ?? 0),
          generated_resources: Number(counts.total ?? 0),
        };
      } catch {
        // Older or partially initialized tutor applications do not have the catalogue yet.
      }
      try {
        const sourceGraphs = db.prepare(`SELECT g.id,g.slug,g.version,g.base_document_id,d.filename,d.role,d.sha256,d.normalized_path
          FROM knowledge_graphs g JOIN source_documents d ON d.id=g.base_document_id
          WHERE g.status='active'`).all() as Array<{
            id: string; slug: string; version: number; base_document_id: string; filename: string; role: string;
            sha256: string; normalized_path: string;
          }>;
        let sourceDocuments = 0;
        let sourceItems = 0;
        let missing = materials.missing_files;
        const concepts = new Set<string>();
        for (const graph of sourceGraphs) {
          const documentRows = db.prepare(`SELECT d.id,d.normalized_path FROM source_documents d
            WHERE d.id=? OR EXISTS (
              SELECT 1 FROM content_items i WHERE i.graph_id=? AND i.source_document_id=d.id AND i.generated=0
            )`).all(graph.base_document_id, graph.id) as Array<{ id: string; normalized_path: string }>;
          sourceDocuments += documentRows.length;
          for (const document of documentRows) {
            if (!fs.existsSync(resolveStoredPath(tutorRoot, document.normalized_path))) missing += 1;
          }
          const graphConcepts = db.prepare(`SELECT id,code,source_code,canonical_concept_id,definition
            FROM concepts WHERE graph_id=? AND status='active' ORDER BY code`).all(graph.id) as Array<{
              id: string; code: string; source_code: string; canonical_concept_id: string | null; definition: string;
            }>;
          for (const concept of graphConcepts) {
            concepts.add(concept.canonical_concept_id ?? concept.id);
            const definitionLocator = `concept_definition[${concept.source_code || concept.code}]`;
            const hasDefinition = db.prepare(`SELECT 1 FROM content_items
              WHERE graph_id=? AND source_document_id=? AND generated=0 AND source_locator=? LIMIT 1`).get(
                graph.id, graph.base_document_id, definitionLocator,
              );
            if (!hasDefinition && concept.definition.trim()) {
              sourceItems += 1;
              const file = path.join(tutorRoot, 'course', 'graphs', graph.id, 'snippets', concept.code,
                `item-definition_${stableDefinitionId(graph.id, graph.base_document_id, concept.id)}.md`);
              if (!fs.existsSync(file)) missing += 1;
            }
          }
          const itemRows = db.prepare(`SELECT id,kind FROM content_items
            WHERE graph_id=? AND generated=0`).all(graph.id) as Array<{ id: string; kind: string }>;
          sourceItems += itemRows.length;
          const itemConcepts = db.prepare(`SELECT ic.item_id,c.code FROM item_concepts ic JOIN concepts c ON c.id=ic.concept_id
            WHERE c.graph_id=? AND c.status='active'`).all(graph.id) as Array<{ item_id: string; code: string }>;
          const snippets = new Set<string>();
          for (const item of itemConcepts) {
            const file = path.join(tutorRoot, 'course', 'graphs', graph.id, 'snippets', item.code, `${item.item_id}.md`);
            if (!snippets.has(file)) {
              snippets.add(file);
              if (!fs.existsSync(file)) missing += 1;
            }
          }
        }
        const generated = db.prepare(`SELECT canonical_concept_id FROM instruction_resources
          WHERE status IN ('active','proposed')`).all() as Array<{ canonical_concept_id: string | null }>;
        for (const row of generated) if (row.canonical_concept_id) concepts.add(row.canonical_concept_id);
        materials = {
          ...materials, total: materials.total + sourceDocuments + sourceItems,
          active: materials.active + sourceDocuments + sourceItems, missing_files: missing,
          concepts_with_materials: concepts.size || materials.concepts_with_materials,
          source_documents: sourceDocuments, source_items: sourceItems,
          generated_resources: materials.generated_resources ?? materials.total,
        };
      } catch {
        // The source catalogue tables may not exist in an older application database.
      }
    } finally {
      db.close();
    }
  }

  return { id: group.id, name: group.name, folder: group.folder, initialized, class: classInfo, students, graphs, courseRevisions, materials };
}

export function readTutorApplicationStatusForGroup(root: string, group: TutorApplicationGroup): TutorApplicationStatus {
  return readApplicationDatabases(group, path.join(path.resolve(root), 'groups', group.folder, 'tutor-app'));
}

export function readTutorApplicationStatus(root: string, id: string): TutorApplicationStatus {
  const centralPath = path.join(path.resolve(root), 'data', 'v2.db');
  if (!fs.existsSync(centralPath)) throw new Error(`NanoClaw database not found: ${centralPath}`);
  const db = new Database(centralPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const group = db.prepare('SELECT id,name,folder FROM agent_groups WHERE id=?').get(id) as TutorApplicationGroup | undefined;
    if (!group) throw new Error(`agent group not found: ${id}`);
    return readTutorApplicationStatusForGroup(root, group);
  } finally {
    db.close();
  }
}
