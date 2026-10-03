import fs from 'node:fs';
import path from 'node:path';

import { resolveConcept } from './concepts';
import { type ActorContext, requireStudent, requireTutor } from './context';
import { htmlArtifactSafe, mimeTypeForPath } from './document-format';
import { audit, openClass, openCourse, paths } from './store';
import { ensureDir, now, sha256, stableId, TutorError } from './util';

type Row = Record<string, unknown>;

interface ConceptLink {
  id: string;
  code: string;
  title: string;
  canonicalId: string;
}

interface CatalogueItem {
  id: string;
  concept: string | null;
  concepts: string[];
  canonical_concept_ids: string[];
  concept_title: string | null;
  kind: string;
  title: string;
  status: 'active' | 'proposed';
  summary: string;
  format: string[];
  generated: boolean;
  source: 'curriculum' | 'generated';
  artifact_path: string;
  preview_path: string;
  artifact_paths: string[];
  text_alternative: string;
  tags: string[];
  provenance: string[];
  audience: Record<string, unknown>;
  source_document_id?: string;
  source_item_id?: string;
  assessment_ref?: string | null;
  answer_item_id?: string | null;
  review_instruction: string;
  resend: { tool: string; path: string; caption: string };
}

function stringList(values: string[], name: string): string[] {
  const cleaned = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (cleaned.length > 30 || cleaned.some((value) => value.length > 80)) throw new TutorError(`${name} exceeds bounded limits`, 64);
  return cleaned;
}

function audience(root: string): Record<string, unknown> {
  const db = openClass(root);
  try {
    return db.query(`SELECT grade_level,age_min,age_max,target_age,explanation_level
      FROM class_config WHERE id=1`).get() as Record<string, unknown>;
  } finally { db.close(); }
}

function safeArtifact(root: string, artifactPath: string, studentId?: string): string {
  const absolute = path.resolve(artifactPath);
  const allowed = studentId
    ? path.resolve(paths(root).studentsDir, studentId, 'artifacts')
    : path.resolve(root);
  if (absolute !== allowed && !absolute.startsWith(`${allowed}${path.sep}`)) {
    throw new TutorError('instruction artifact is outside the allowed tutor workspace', 77);
  }
  const stat = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
  if (!stat?.isFile()) throw new TutorError('instruction artifact file not found', 66);
  if (stat.size > 5_000_000) throw new TutorError('instruction artifact exceeds 5 MB', 64);
  return absolute;
}

interface ResourceInput {
  concept: string;
  kind: string;
  title: string;
  artifactPath: string;
  artifactPaths?: string[];
  textAlternative: string;
  tags: string[];
  provenance: string[];
  idempotency: string;
}

function parseJson(value: unknown, fallback: unknown): any {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}

function previewPath(artifactPath: string, artifactPaths: string[] = []): string {
  const candidates = [
    ...artifactPaths,
    path.join(path.dirname(artifactPath), 'index.html'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && path.basename(candidate).toLowerCase() === 'index.html')
    ?? artifactPath;
}

/** Visual rendering produces a portable three-file bundle even when the CLI receives only visual.svg. */
function expandArtifactBundle(artifactPaths: string[]): string[] {
  const unique = [...new Set(artifactPaths.map((value) => path.resolve(value)))];
  const primary = unique[0];
  if (primary && path.basename(primary).toLowerCase() === 'visual.svg') {
    for (const sibling of ['visual.txt', 'index.html', 'manifest.json']) {
      const candidate = path.join(path.dirname(primary), sibling);
      if (fs.existsSync(candidate)) unique.push(candidate);
    }
  }
  return [...new Set(unique)];
}

function summary(title: string, conceptTitle: string, textAlternative: string): string {
  const firstSentence = textAlternative.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  const base = `${title} explains ${conceptTitle}.`;
  const detail = firstSentence && firstSentence !== base ? ` ${firstSentence}` : '';
  return `${base}${detail}`.slice(0, 320);
}

/** Convert a path under the tutor app to a root-relative path before it enters SQLite. */
function portablePath(root: string, value: string): string {
  const absolute = path.resolve(value);
  const rootPath = path.resolve(root);
  if (absolute === rootPath || absolute.startsWith(`${rootPath}${path.sep}`)) {
    return path.relative(rootPath, absolute).split(path.sep).join('/');
  }
  const normalized = absolute.replaceAll('\\', '/');
  const marker = '/tutor-app/';
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : value;
}

/** Resolve both new relative paths and old host/container absolute paths. */
function resolveStoredPath(root: string, value: string): string {
  if (!value) return value;
  if (!path.isAbsolute(value)) return path.resolve(root, value);
  if (fs.existsSync(value)) return path.resolve(value);
  const normalized = value.replaceAll('\\', '/');
  const marker = '/tutor-app/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return path.join(root, ...normalized.slice(markerIndex + marker.length).split('/'));
  return value;
}

/** Repair paths written by pre-portability versions without requiring re-ingestion. */
function normalizeStoredPaths(root: string, db: any): void {
  const resources = db.query('SELECT id,artifact_path,artifact_paths_json FROM instruction_resources').all() as Array<{ id: string; artifact_path: string; artifact_paths_json: string | null }>;
  for (const row of resources) {
    const resolved = resolveStoredPath(root, row.artifact_path);
    const stored = portablePath(root, resolved);
    const paths = parseJson(row.artifact_paths_json, []) as unknown;
    const resolvedPaths = Array.isArray(paths) && paths.length ? paths.map((value) => resolveStoredPath(root, String(value))) : [resolved];
    const storedPaths = resolvedPaths.map((value) => portablePath(root, value));
    if ((stored !== row.artifact_path || JSON.stringify(storedPaths) !== JSON.stringify(paths)) && fs.existsSync(resolved)) {
      db.query('UPDATE instruction_resources SET artifact_path=$path,artifact_paths_json=$paths WHERE id=$id').run({
        $path: stored, $paths: JSON.stringify(storedPaths), $id: row.id,
      });
    }
  }
  const documents = db.query('SELECT id,original_path,normalized_path FROM source_documents').all() as Array<{
    id: string; original_path: string; normalized_path: string;
  }>;
  for (const row of documents) {
    const original = resolveStoredPath(root, row.original_path);
    const normalized = resolveStoredPath(root, row.normalized_path);
    const storedOriginal = portablePath(root, original);
    const storedNormalized = portablePath(root, normalized);
    if (storedOriginal !== row.original_path || storedNormalized !== row.normalized_path) {
      db.query(`UPDATE source_documents SET original_path=$original,normalized_path=$normalized WHERE id=$id`).run({
        $id: row.id, $original: storedOriginal, $normalized: storedNormalized,
      });
    }
  }
}

function copySharedArtifact(root: string, id: string, artifactPaths: string[]): string {
  const targetDir = path.join(paths(root).resourcesDir, id);
  ensureDir(targetDir);
  const uniquePaths = [...new Set(artifactPaths.map((value) => path.resolve(value)))];
  for (const source of uniquePaths) {
    const file = path.basename(source);
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size > 5_000_000) continue;
    const target = path.join(targetDir, file);
    if (path.resolve(source) !== path.resolve(target)) {
      if (file.toLowerCase().endsWith('.html')) fs.writeFileSync(target, htmlArtifactSafe(fs.readFileSync(source, 'utf8')));
      else fs.copyFileSync(source, target);
    }
  }
  const target = path.join(targetDir, path.basename(uniquePaths[0]));
  if (!fs.existsSync(target)) throw new TutorError('instruction artifact could not be promoted to shared course resources', 74);
  return target;
}

function sourceTags(
  graph: string,
  documentId: string,
  role: string,
  kind: string,
  classAudience: Record<string, unknown>,
  links: ConceptLink[],
  difficulty?: string | null,
  assessmentTags: string[] = [],
  cognitiveLevel?: string | null,
): string[] {
  return stringList([
    'source', 'curriculum', `kind:${kind}`, `graph:${graph}`, `source-document:${documentId}`, `source-role:${role}`,
    `grade:${String(classAudience.grade_level ?? 'unknown')}`, `eli:${String(classAudience.target_age ?? 'unknown')}`,
    // A source document can cover the whole ontology. Keep the tag set bounded while
    // retaining one canonical concept tag per linked concept; display codes remain in
    // the structured `concepts`/`canonical_concept_ids` fields.
    ...links.map((link) => `concept:${link.canonicalId}`),
    ...(difficulty ? [`difficulty:${difficulty}`] : []), ...assessmentTags,
    ...(cognitiveLevel ? [`cognitive:${cognitiveLevel}`] : []),
    ...(links.length ? [] : ['concept:unmapped', 'mapping:unmapped']),
  ], 'tags');
}

function graphLinks(db: any, graphId: string): ConceptLink[] {
  return db.query(`SELECT id,code,title,COALESCE(canonical_concept_id,id) AS canonical_id
    FROM concepts WHERE graph_id=$graph AND status='active' ORDER BY code`).all({ $graph: graphId }).map((row: Row) => ({
      id: String(row.id), code: String(row.code), title: String(row.title), canonicalId: String(row.canonical_id),
    }));
}

function itemLinks(db: any): Map<string, ConceptLink[]> {
  const links = new Map<string, ConceptLink[]>();
  const rows = db.query(`SELECT ic.item_id,c.id,c.code,c.title,COALESCE(c.canonical_concept_id,c.id) AS canonical_id
    FROM item_concepts ic JOIN concepts c ON c.id=ic.concept_id AND c.status='active'
    ORDER BY ic.item_id,c.code`).all() as Row[];
  for (const row of rows) {
    const itemId = String(row.item_id);
    const values = links.get(itemId) ?? [];
    values.push({ id: String(row.id), code: String(row.code), title: String(row.title), canonicalId: String(row.canonical_id) });
    links.set(itemId, values);
  }
  return links;
}

function ensureSourceSnippet(root: string, item: {
  id: string; graphId: string; concept: ConceptLink; kind: string; difficulty?: string | null;
  assessmentRef?: string | null; answerForRef?: string | null; sourceDocumentId: string; sourceLocator: string;
  sourceHash: string; revision: number; title: string; body: string; tags: string[];
}): string {
  const file = path.join(paths(root).graphsDir, item.graphId, 'snippets', item.concept.code, `${item.id}.md`);
  ensureDir(path.dirname(file));
  const frontmatter = `---\nitem_id: ${item.id}\nconcept_id: ${item.concept.id}\ncanonical_concept_id: ${item.concept.canonicalId}\nconcept_code: ${item.concept.code}\nkind: ${item.kind}\ndifficulty: ${item.difficulty ?? ''}\nassessment_ref: ${item.assessmentRef ?? ''}\nanswer_for_ref: ${item.answerForRef ?? ''}\ntags: ${JSON.stringify(item.tags)}\nsource_document_id: ${item.sourceDocumentId}\nsource_locator: ${item.sourceLocator}\nsource_hash: ${item.sourceHash}\ngraph_revision: ${item.revision}\n---\n\n# ${item.title}\n\n${item.body}\n`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, frontmatter);
  else {
    const existing = fs.readFileSync(file, 'utf8');
    const end = existing.indexOf('\n---', 3);
    if (end >= 0 && !/^tags:/m.test(existing.slice(0, end))) {
      fs.writeFileSync(file, `${existing.slice(0, end)}\ntags: ${JSON.stringify(item.tags)}${existing.slice(end)}`);
    }
  }
  return file;
}

function materialFormats(artifactPaths: string[], preview: string, source = false): string[] {
  const formats = new Set<string>(source ? ['text alternative'] : ['text alternative']);
  for (const artifactPath of artifactPaths) {
    const mime = mimeTypeForPath(artifactPath);
    if (mime === 'text/markdown' || mime === 'text/plain') formats.add('Markdown');
    if (mime === 'application/pdf') formats.add('PDF');
    if (mime === 'text/html' || artifactPath.toLowerCase().endsWith('.html')) formats.add('HTML');
    if (mime === 'image/svg+xml' || artifactPath.toLowerCase().endsWith('.svg')) formats.add('SVG');
  }
  if (fs.existsSync(preview) && preview.toLowerCase().endsWith('.html')) formats.add('HTML');
  return [...formats];
}

function sourceCatalogue(root: string, db: any, classAudience: Record<string, unknown>): CatalogueItem[] {
  const linksByItem = itemLinks(db);
    const graphs = db.query(`SELECT g.id,g.slug,g.version,g.scope_label,g.base_document_id,
      d.filename,d.role,d.sha256,d.original_path,d.normalized_path
      FROM knowledge_graphs g JOIN source_documents d ON d.id=g.base_document_id
    WHERE g.status='active' ORDER BY g.slug`).all() as Row[];
  const items: CatalogueItem[] = [];
  for (const graph of graphs) {
    const graphId = String(graph.id);
    const documentId = String(graph.base_document_id);
    const graphLinksValue = graphLinks(db, graphId);
    const sourceRows = db.query(`SELECT i.*,d.filename,d.role,d.sha256 AS document_hash,
        s.answer_item_id,s.cognitive_level,s.tags_json AS assessment_tags_json
      FROM content_items i JOIN source_documents d ON d.id=i.source_document_id
      LEFT JOIN assessment_specs s ON s.question_item_id=i.id
      WHERE i.graph_id=$graph AND i.generated=0 AND i.status='active'
      ORDER BY i.kind,i.id`).all({ $graph: graphId }) as Row[];
    const documentRows = db.query(`SELECT d.id,d.filename,d.role,d.sha256,d.original_path,d.normalized_path,d.status
      FROM source_documents d
      WHERE (d.id=$base AND d.status='active') OR EXISTS (
        SELECT 1 FROM content_items i WHERE i.graph_id=$graph AND i.source_document_id=d.id AND i.generated=0 AND i.status='active'
      ) ORDER BY CASE WHEN d.id=$base THEN 0 ELSE 1 END,d.id`).all({ $base: documentId, $graph: graphId }) as Row[];
    for (const document of documentRows) {
      const currentDocumentId = String(document.id);
      const documentLinks = currentDocumentId === documentId
        ? graphLinksValue
        : [...new Map(sourceRows.filter((row) => String(row.source_document_id) === currentDocumentId)
          .flatMap((row) => linksByItem.get(String(row.id)) ?? []).map((link) => [link.canonicalId, link])).values()];
      const documentTags = sourceTags(String(graph.slug), currentDocumentId, String(document.role), 'source_document', classAudience, documentLinks);
      const documentPath = resolveStoredPath(root, String(document.original_path ?? document.normalized_path));
      const normalizedPath = resolveStoredPath(root, String(document.normalized_path));
      const storedArtifacts = db.query(`SELECT path FROM source_artifacts
        WHERE source_document_id=$document AND status='active' ORDER BY kind`).all({ $document: currentDocumentId }) as Array<{ path: string }>;
      const documentArtifacts = [...new Set([
        documentPath, normalizedPath, ...storedArtifacts.map((artifact) => resolveStoredPath(root, artifact.path)),
      ])];
      const documentTitle = String(document.filename);
      const documentSummary = currentDocumentId === documentId
        ? `${documentTitle} is the approved base curriculum document for ${String(graph.scope_label)}.`
        : `${documentTitle} is supplemental source curriculum for ${String(graph.scope_label)}.`;
      items.push({
        id: `source-document_${currentDocumentId}`, concept: null, concepts: documentLinks.map((link) => link.code),
        canonical_concept_ids: documentLinks.map((link) => link.canonicalId), concept_title: null,
        kind: 'source_document', title: documentTitle, status: 'active', summary: documentSummary,
        format: materialFormats(documentArtifacts, documentPath, true), generated: false, source: 'curriculum',
        artifact_path: documentPath, preview_path: documentPath, artifact_paths: documentArtifacts, text_alternative: documentSummary,
        tags: documentTags, provenance: [`${graph.slug}@${graph.version}`, documentTitle], audience: classAudience,
        source_document_id: currentDocumentId,
        review_instruction: currentDocumentId === documentId
          ? 'This is source-authored curriculum. Explain it inline for normal teaching; use send_file with preview_path for the full source artifact.'
          : 'This is supplemental source-authored curriculum. Explain it inline for normal teaching; use send_file with preview_path for the full source artifact.',
        resend: { tool: 'send_file', path: documentPath, caption: documentSummary },
      });
    }
    const definitionLocators = new Set(sourceRows
      .filter((row) => String(row.source_locator).startsWith('concept_definition['))
      .map((row) => String(row.source_locator)));
    for (const link of graphLinksValue) {
      if (definitionLocators.has(`concept_definition[${String(db.query('SELECT source_code FROM concepts WHERE id=$id').get({ $id: link.id })?.source_code ?? link.code)}]`)) continue;
      const definition = String(db.query('SELECT definition FROM concepts WHERE id=$id').get({ $id: link.id })?.definition ?? '').trim();
      if (!definition) continue;
      const virtualId = stableId('item-definition', graphId, documentId, link.id);
      const tags = sourceTags(String(graph.slug), documentId, String(graph.role ?? 'base'), 'information_snippet', classAudience, [link]);
      const file = ensureSourceSnippet(root, {
        id: virtualId, graphId, concept: link, kind: 'information_snippet', sourceDocumentId: documentId,
        sourceLocator: `concept_definition[${String(db.query('SELECT source_code FROM concepts WHERE id=$id').get({ $id: link.id })?.source_code ?? link.code)}]`,
        sourceHash: String(graph.sha256), revision: Number(graph.version), title: `${link.title} — definition`, body: definition, tags,
      });
      const text = definition;
      items.push({
        id: `source_${virtualId}`, concept: link.code, concepts: [link.code], canonical_concept_ids: [link.canonicalId],
        concept_title: link.title, kind: 'information_snippet', title: `${link.title} — definition`, status: 'active',
        summary: summary(`${link.title} — definition`, link.title, text), format: materialFormats([file], file, true),
        generated: false, source: 'curriculum', artifact_path: file, preview_path: file, artifact_paths: [file], text_alternative: text,
        tags, provenance: [`${graph.slug}@${graph.version}`, String(graph.filename), `concept_definition[${link.code}]`],
        audience: classAudience, source_document_id: documentId, source_item_id: virtualId,
        review_instruction: 'This is source-authored curriculum. Re-send the Markdown snippet with send_file if needed.',
        resend: { tool: 'send_file', path: file, caption: `${link.title} definition` },
      });
    }
    for (const row of sourceRows) {
      const links = linksByItem.get(String(row.id)) ?? [];
      const link = links[0];
      if (!link) continue;
      const assessmentTags = parseJson(row.assessment_tags_json, []) as unknown;
      const rowDocumentId = String(row.source_document_id);
      const tags = sourceTags(String(graph.slug), rowDocumentId, String(row.role), String(row.kind), classAudience, links,
        row.difficulty == null ? null : String(row.difficulty), Array.isArray(assessmentTags) ? assessmentTags.map(String) : [],
        row.cognitive_level == null ? null : String(row.cognitive_level));
      db.query('UPDATE content_items SET tags_json=$tags WHERE id=$id AND tags_json<>$tags').run({ $id: row.id, $tags: JSON.stringify(tags) });
      const file = ensureSourceSnippet(root, {
        id: String(row.id), graphId, concept: link, kind: String(row.kind), difficulty: row.difficulty == null ? null : String(row.difficulty),
        assessmentRef: row.assessment_ref == null ? null : String(row.assessment_ref), answerForRef: row.answer_for_ref == null ? null : String(row.answer_for_ref),
        sourceDocumentId: rowDocumentId, sourceLocator: String(row.source_locator), sourceHash: String(row.document_hash),
        revision: Number(graph.version), title: String(row.title), body: String(row.body_md), tags,
      });
      const preview = file;
      const itemSummary = summary(String(row.title), link.title, String(row.body_md));
      items.push({
        id: `source_${row.id}`, concept: link.code, concepts: links.map((value) => value.code),
        canonical_concept_ids: links.map((value) => value.canonicalId), concept_title: link.title, kind: String(row.kind),
        title: String(row.title), status: 'active', summary: itemSummary, format: materialFormats([file], preview, true),
        generated: false, source: 'curriculum', artifact_path: file, preview_path: preview, artifact_paths: [file], text_alternative: String(row.body_md),
        tags, provenance: [`${graph.slug}@${graph.version}`, String(row.filename), String(row.source_locator)], audience: classAudience,
        source_document_id: rowDocumentId, source_item_id: String(row.id), assessment_ref: row.assessment_ref == null ? null : String(row.assessment_ref),
        answer_item_id: row.answer_item_id == null ? null : String(row.answer_item_id),
        review_instruction: 'This is source-authored curriculum. Re-send the Markdown snippet with send_file if needed.',
        resend: { tool: 'send_file', path: preview, caption: itemSummary },
      });
    }
  }
  return items;
}

function generatedCatalogue(root: string, db: any, statuses: string[], conceptId: string | null): CatalogueItem[] {
  const placeholders = statuses.map((_, index) => `$status${index}`).join(',');
  const params: Record<string, string | null> = { $concept: conceptId };
  statuses.forEach((status, index) => { params[`$status${index}`] = status; });
  const rows = db.query(`SELECT r.*,COALESCE(c.code,r.canonical_concept_id) AS display_code,
      COALESCE(c.title,r.canonical_concept_id) AS concept_title
    FROM instruction_resources r LEFT JOIN concepts c
      ON c.status='active' AND c.canonical_concept_id=r.canonical_concept_id
    WHERE r.status IN (${placeholders}) AND ($concept IS NULL OR r.canonical_concept_id=$concept)
    GROUP BY r.id ORDER BY r.updated_at DESC,r.id LIMIT 200`).all(params) as Row[];
  return rows.map((row) => {
    const artifactPath = resolveStoredPath(root, String(row.artifact_path));
    const parsedPaths = parseJson(row.artifact_paths_json, []) as unknown;
    const artifactPaths = Array.isArray(parsedPaths) && parsedPaths.length
      ? parsedPaths.map((value) => resolveStoredPath(root, String(value)))
      : [artifactPath];
    const preview = previewPath(artifactPath, artifactPaths);
    const conceptCode = String(row.display_code ?? row.canonical_concept_id);
    const itemSummary = summary(String(row.title), String(row.concept_title ?? conceptCode), String(row.text_alternative));
    return {
      id: String(row.id), concept: conceptCode, concepts: [conceptCode], canonical_concept_ids: [String(row.canonical_concept_id)],
      concept_title: row.concept_title == null ? null : String(row.concept_title), kind: String(row.kind), title: String(row.title),
      status: String(row.status) as 'active' | 'proposed', summary: itemSummary, format: materialFormats(artifactPaths, preview),
      generated: true, source: 'generated', artifact_path: artifactPath, preview_path: preview,
      artifact_paths: artifactPaths,
      text_alternative: String(row.text_alternative), tags: parseJson(row.tags_json, []) as string[],
      provenance: parseJson(row.provenance_json, []) as string[], audience: parseJson(row.audience_json, {}) as Record<string, unknown>,
      review_instruction: 'To resend this material on the current channel, use send_file with preview_path (or artifact_path for the raw asset).',
      resend: { tool: 'send_file', path: preview, caption: itemSummary },
    };
  });
}

function catalogueItems(root: string, db: any, statuses: string[], conceptId: string | null): CatalogueItem[] {
  normalizeStoredPaths(root, db);
  const classAudience = audience(root);
  const source = statuses.includes('active') ? sourceCatalogue(root, db, classAudience) : [];
  const generated = generatedCatalogue(root, db, statuses, conceptId);
  const items = conceptId
    ? [...source, ...generated].filter((item) => item.canonical_concept_ids.includes(conceptId))
    : [...source, ...generated];
  return items.sort((left, right) => Number(right.generated) - Number(left.generated) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function saveResource(root: string, actor: ActorContext, input: ResourceInput, status: 'proposed' | 'active'): unknown {
  const concept = resolveConcept(root, input.concept);
  const artifactPaths = expandArtifactBundle([input.artifactPath, ...(input.artifactPaths ?? [])])
    .map((value) => safeArtifact(root, value, actor.role === 'student' ? actor.studentId : undefined));
  const artifact = artifactPaths[0];
  const title = input.title.trim();
  const textAlternative = input.textAlternative.trim();
  if (!title || !textAlternative) throw new TutorError('title and text alternative are required', 64);
  if (!/^[a-z][a-z0-9_-]{1,39}$/i.test(input.kind)) throw new TutorError('invalid instruction resource kind', 64);
  const classAudience = audience(root);
  const tags = stringList([
    ...input.tags, `concept:${concept.canonical_id}`, `grade:${String(classAudience.grade_level ?? 'unknown')}`,
    `eli:${String(classAudience.target_age ?? 'unknown')}`,
  ], 'tags');
  const provenance = stringList(input.provenance, 'provenance');
  const contentHash = sha256(Buffer.concat(artifactPaths.map((value) => Buffer.concat([Buffer.from(path.basename(value)), fs.readFileSync(value)]))));
  const id = stableId('instruction', concept.canonical_id, contentHash);
  const sharedArtifact = status === 'active' ? copySharedArtifact(root, id, artifactPaths) : artifact;
  const sharedPaths = status === 'active' ? artifactPaths.map((value) => path.join(path.dirname(sharedArtifact), path.basename(value))) : artifactPaths;
  const storedArtifact = portablePath(root, sharedArtifact);
  const storedArtifactPaths = sharedPaths.map((value) => portablePath(root, value));
  const db = openCourse(root);
  const existing = db.query('SELECT * FROM instruction_resources WHERE id=$id').get({ $id: id }) as Row | null;
  if (existing) {
    if (status === 'active' && existing.status !== 'active') {
      db.query(`UPDATE instruction_resources SET status='active',artifact_path=$artifact,artifact_paths_json=$artifactPaths,tags_json=$tags,
        provenance_json=$provenance,audience_json=$audience,updated_at=$at WHERE id=$id`).run({
        $id: id, $artifact: storedArtifact, $artifactPaths: JSON.stringify(storedArtifactPaths), $tags: JSON.stringify(tags), $provenance: JSON.stringify(provenance),
        $audience: JSON.stringify(classAudience), $at: now(),
      });
      const resource = db.query('SELECT * FROM instruction_resources WHERE id=$id').get({ $id: id });
      db.close();
      audit(root, actor.role, actor.actorId, 'instruction.active', 'instruction_resource', id, { promoted: true });
      return { idempotent: false, resource, receipt: 'INSTRUCTION RESOURCE REGISTERED' };
    }
    if (existing.artifact_path !== storedArtifact) {
      db.query(`UPDATE instruction_resources SET artifact_path=$artifact,artifact_paths_json=$artifactPaths,tags_json=$tags,
        provenance_json=$provenance,audience_json=$audience,updated_at=$at WHERE id=$id`).run({
        $id: id, $artifact: storedArtifact, $artifactPaths: JSON.stringify(storedArtifactPaths), $tags: JSON.stringify(tags), $provenance: JSON.stringify(provenance),
        $audience: JSON.stringify(classAudience), $at: now(),
      });
    }
    db.close();
    return { idempotent: true, resource: existing };
  }
  db.query(`INSERT INTO instruction_resources
    (id,canonical_concept_id,kind,title,artifact_path,text_alternative,tags_json,provenance_json,
     audience_json,content_hash,status,created_by,created_at,updated_at,artifact_paths_json)
    VALUES ($id,$concept,$kind,$title,$artifact,$text,$tags,$provenance,$audience,$hash,$status,$created,$at,$at,$artifactPaths)`).run({
      $id: id, $concept: concept.canonical_id, $kind: input.kind, $title: title.slice(0, 300),
      $artifact: storedArtifact, $text: textAlternative.slice(0, 8000), $tags: JSON.stringify(tags),
      $provenance: JSON.stringify(provenance), $audience: JSON.stringify(classAudience), $hash: contentHash,
      $status: status, $created: actor.actorId, $at: now(), $artifactPaths: JSON.stringify(storedArtifactPaths),
    });
  const resource = db.query('SELECT * FROM instruction_resources WHERE id=$id').get({ $id: id });
  db.close();
  audit(root, actor.role, actor.actorId, `instruction.${status}`, 'instruction_resource', id, {
    canonical_concept_id: concept.canonical_id, kind: input.kind, tags, idempotency: input.idempotency,
    artifact_path: storedArtifact,
  });
  return { idempotent: false, resource, receipt: status === 'active' ? 'INSTRUCTION RESOURCE REGISTERED' : 'INSTRUCTION RESOURCE PROPOSED FOR TUTOR REVIEW' };
}

export function proposeInstructionResource(root: string, actor: ActorContext, input: ResourceInput): unknown {
  requireStudent(actor);
  return saveResource(root, actor, input, 'proposed');
}

export function registerInstructionResource(root: string, actor: ActorContext, input: ResourceInput): unknown {
  requireTutor(actor);
  return saveResource(root, actor, input, 'active');
}

export function approveInstructionResource(root: string, actor: ActorContext, id: string): unknown {
  requireTutor(actor);
  const db = openCourse(root);
  const row = db.query('SELECT * FROM instruction_resources WHERE id=$id').get({ $id: id }) as Row | null;
  if (!row) { db.close(); throw new TutorError('instruction resource not found', 66); }
  if (row.status === 'active') { db.close(); return { idempotent: true, resource: row }; }
  const sourceArtifact = resolveStoredPath(root, String(row.artifact_path));
  const parsedPaths = parseJson(row.artifact_paths_json, []) as unknown;
  const sourceArtifacts = Array.isArray(parsedPaths) && parsedPaths.length
    ? parsedPaths.map((value) => resolveStoredPath(root, String(value)))
    : [sourceArtifact];
  const sharedArtifact = copySharedArtifact(root, id, sourceArtifacts);
  const sharedPaths = sourceArtifacts.map((value) => path.join(path.dirname(sharedArtifact), path.basename(value)));
  db.query(`UPDATE instruction_resources SET status='active',artifact_path=$artifact,artifact_paths_json=$artifactPaths,updated_at=$at WHERE id=$id`).run({
    $id: id, $artifact: portablePath(root, sharedArtifact), $artifactPaths: JSON.stringify(sharedPaths.map((value) => portablePath(root, value))), $at: now(),
  });
  const resource = db.query('SELECT * FROM instruction_resources WHERE id=$id').get({ $id: id });
  db.close();
  audit(root, actor.role, actor.actorId, 'instruction.approve', 'instruction_resource', id, { artifact_path: portablePath(root, sharedArtifact) });
  return { idempotent: false, resource, receipt: 'INSTRUCTION RESOURCE APPROVED' };
}

export function listInstructionResources(
  root: string,
  actor: ActorContext,
  conceptRef?: string,
  statusRef?: string,
  limit = 20,
): unknown {
  if (actor.role === 'student') requireStudent(actor);
  else requireTutor(actor);
  const concept = conceptRef ? resolveConcept(root, conceptRef) : null;
  const requestedStatus = statusRef?.trim().toLowerCase() || 'all';
  const allowedStatuses = actor.role === 'student' ? ['active'] : ['active', 'proposed'];
  if (requestedStatus !== 'all' && !allowedStatuses.includes(requestedStatus)) throw new TutorError('status must be active, proposed, or all', 64);
  if (actor.role === 'student' && requestedStatus !== 'all' && requestedStatus !== 'active') {
    throw new TutorError('students can list only tutor-approved materials', 77);
  }
  const statuses = actor.role === 'student' ? ['active'] : requestedStatus === 'all' ? allowedStatuses : [requestedStatus];
  const db = openCourse(root);
  try {
    const catalogue = catalogueItems(root, db, statuses, concept?.canonical_id ?? null);
    const items = catalogue.slice(0, Math.max(1, Math.min(200, limit)));
    const scope = actor.role === 'student' ? 'approved_shared' : requestedStatus === 'proposed' ? 'tutor_review_queue' : 'tutor_review';
    return {
      surface: 'materials_catalogue', scope,
      one_liner: 'Concept-linked teaching materials; approved items are shared and can be re-sent on this channel for review.',
      format: 'Each item is listed as concept · status · title · kind/format · one-line explanation · provenance · resend preview path.',
      concept: concept ? { code: concept.display_code, canonical_id: concept.canonical_id, title: concept.title } : null,
      count: items.length, items,
      policy: actor.role === 'student'
        ? 'Only tutor-approved shared materials are listed.'
        : 'Tutor control lists source curriculum, proposed resources, and approved resources; approval promotes a proposal into shared course resources.',
    };
  } finally { db.close(); }
}

export function materialSummary(root: string, actor: ActorContext): unknown {
  requireTutor(actor);
  const db = openCourse(root);
  try {
    const items = catalogueItems(root, db, ['active', 'proposed'], null);
    const concepts = new Set(items.flatMap((item) => item.canonical_concept_ids));
    return {
      total: items.length, active: items.filter((item) => item.status === 'active').length,
      proposed: items.filter((item) => item.status === 'proposed').length,
      missing_files: items.filter((item) => item.artifact_paths.some((artifact) => !fs.existsSync(artifact))).length,
      concepts_with_materials: concepts.size,
      source_documents: items.filter((item) => item.kind === 'source_document').length,
      source_items: items.filter((item) => !item.generated && item.kind !== 'source_document').length,
      generated_resources: items.filter((item) => item.generated).length,
    };
  } finally { db.close(); }
}

export function searchInstructionResources(root: string, actor: ActorContext, query: string, conceptRef: string | undefined, requestedTags: string[], limit = 8): unknown {
  if (actor.role === 'student') requireStudent(actor);
  else requireTutor(actor);
  const concept = conceptRef ? resolveConcept(root, conceptRef) : null;
  const wanted = stringList(requestedTags, 'tags');
  const db = openCourse(root);
  try {
    const items = catalogueItems(root, db, ['active'], concept?.canonical_id ?? null);
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const results = items.map((item) => {
      const haystack = `${item.title} ${item.text_alternative} ${item.tags.join(' ')}`.toLowerCase();
      const lexical = terms.filter((term) => haystack.includes(term)).length;
      const tagMatches = wanted.filter((tag) => item.tags.includes(tag)).length;
      return {
        id: item.id, canonical_concept_id: item.canonical_concept_ids[0] ?? null, kind: item.kind, title: item.title,
        artifact_path: item.artifact_path, text_alternative: item.text_alternative, tags: item.tags,
        provenance: item.provenance, audience: item.audience, generated: item.generated, source: item.source,
        score: lexical + tagMatches * 2 + (concept ? 2 : 0),
      };
    }).filter((item) => (!terms.length || item.score > 0) && wanted.every((tag) => item.tags.includes(tag)))
      .sort((left, right) => right.score - left.score || String(left.title).localeCompare(String(right.title)))
      .slice(0, Math.max(1, Math.min(20, limit)));
    return {
      query, canonical_concept_id: concept?.canonical_id ?? null, requested_tags: wanted,
      audience: audience(root), hit_count: results.length, results,
      policy: actor.role === 'student' ? 'Only tutor-approved materials are returned.' : 'Active source and reusable materials are returned; proposed resources require explicit approval.',
    };
  } finally { db.close(); }
}
