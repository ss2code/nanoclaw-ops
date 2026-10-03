import fs from 'node:fs';
import path from 'node:path';

import { type ActorContext, requireStudent } from './context';
import { openCourse, openStudent, paths } from './store';
import { appendTrace } from './trace';
import { ensureDir, now, sha256, stableId, TutorError, writeJsonAtomic } from './util';

export type VisualKind = 'graph' | 'process' | 'comparison' | 'worked_example';

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(value: string, length = 42): string[] {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (`${line} ${word}`.trim().length > length && line) { lines.push(line); line = word; }
    else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function cardsSvg(title: string, description: string, items: string[], kind: VisualKind): string {
  const height = Math.max(420, 170 + items.length * 92);
  const cards = items.map((item, index) => {
    const y = 120 + index * 92;
    const lines = wrap(item).map((line, lineIndex) => `<text x="132" y="${y + 32 + lineIndex * 20}" class="body">${escape(line)}</text>`).join('');
    const connector = index < items.length - 1 ? `<path d="M90 ${y + 62} V${y + 92}" class="edge" marker-end="url(#arrow)"/>` : '';
    return `<g><rect x="70" y="${y}" width="820" height="70" rx="14" class="card"/><circle cx="98" cy="${y + 35}" r="18" class="step"/><text x="98" y="${y + 41}" text-anchor="middle" class="number">${index + 1}</text>${lines}${connector}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4f71be"/></marker></defs>
  <style>.bg{fill:#f7f9fc}.heading{font:700 28px system-ui;fill:#17233e}.body{font:17px system-ui;fill:#1f2d4d}.card{fill:#fff;stroke:#9eb0d3;stroke-width:2}.step{fill:#315da8}.number{font:700 15px system-ui;fill:#fff}.edge{stroke:#4f71be;stroke-width:3;fill:none}</style>
  <rect width="960" height="${height}" class="bg"/><text x="48" y="60" class="heading">${escape(title)}</text><text x="48" y="88" class="body">${escape(kind.replace('_', ' '))} · deterministic tutor visual</text>${cards}</svg>`;
}

function graphSvg(title: string, description: string, nodes: Array<{ code: string; title: string }>, edges: Array<{ from_code: string; to_code: string }>): string {
  const positions = new Map(nodes.map((node, index) => [node.code, { x: 80 + (index % 3) * 290, y: 130 + Math.floor(index / 3) * 120 }]));
  const height = Math.max(430, 210 + Math.ceil(nodes.length / 3) * 120);
  const edgeSvg = edges.map((edge) => {
    const from = positions.get(edge.from_code); const to = positions.get(edge.to_code);
    return from && to ? `<path d="M${from.x + 220} ${from.y + 36} L${to.x} ${to.y + 36}" class="edge" marker-end="url(#arrow)"/>` : '';
  }).join('');
  const nodeSvg = nodes.map((node) => {
    const position = positions.get(node.code)!;
    return `<g><rect x="${position.x}" y="${position.y}" width="220" height="72" rx="14" class="node"/><text x="${position.x + 16}" y="${position.y + 28}" class="code">${escape(node.code)}</text><text x="${position.x + 16}" y="${position.y + 52}" class="body">${escape(node.title.slice(0, 25))}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4f71be"/></marker></defs><style>.bg{fill:#f7f9fc}.heading{font:700 28px system-ui;fill:#17233e}.body{font:16px system-ui;fill:#1f2d4d}.code{font:700 15px ui-monospace;fill:#244a88}.node{fill:#fff;stroke:#7f98c5;stroke-width:2}.edge{stroke:#4f71be;stroke-width:3;fill:none}</style><rect width="960" height="${height}" class="bg"/><text x="48" y="60" class="heading">${escape(title)}</text>${edgeSvg}${nodeSvg}</svg>`;
}

export function renderVisual(root: string, actor: ActorContext, kind: VisualKind, title: string, conceptCode: string | undefined, items: string[], provenance: string[]): unknown {
  requireStudent(actor);
  if (!['graph', 'process', 'comparison', 'worked_example'].includes(kind)) throw new TutorError('unsupported visual kind', 64);
  if (!title.trim()) throw new TutorError('visual title is required', 64);
  if (items.length > 12 || items.some((item) => item.length > 500)) throw new TutorError('visual content exceeds bounded limits', 64);
  const course = openCourse(root);
  let svg: string;
  let textAlternative: string;
  let resolvedProvenance = [...new Set(provenance)].slice(0, 20);
  if (kind === 'graph') {
    const nodes = course.query(`SELECT code,title FROM concepts WHERE status='active'
      AND ($concept IS NULL OR code=$concept OR id IN (
        SELECT from_concept_id FROM concept_edges WHERE to_concept_id=(SELECT id FROM concepts WHERE code=$concept LIMIT 1)
        UNION SELECT to_concept_id FROM concept_edges WHERE from_concept_id=(SELECT id FROM concepts WHERE code=$concept LIMIT 1)
      )) ORDER BY code LIMIT 12`).all({ $concept: conceptCode ?? null }) as Array<{ code: string; title: string }>;
    if (!nodes.length) { course.close(); throw new TutorError('no graph concepts available for visual', 66); }
    const codes = new Set(nodes.map((node) => node.code));
    const edges = (course.query(`SELECT a.code AS from_code,b.code AS to_code FROM concept_edges e
      JOIN concepts a ON a.id=e.from_concept_id JOIN concepts b ON b.id=e.to_concept_id
      WHERE e.type='prerequisite_of' ORDER BY a.code,b.code`).all() as Array<{ from_code: string; to_code: string }>).filter((edge) => codes.has(edge.from_code) && codes.has(edge.to_code));
    const revision = course.query('SELECT slug,version,base_document_id FROM knowledge_graphs WHERE status=\'active\' ORDER BY version DESC LIMIT 1').get() as { slug: string; version: number; base_document_id: string };
    resolvedProvenance = [...new Set([...resolvedProvenance, `${revision.slug}@${revision.version}`, revision.base_document_id])];
    textAlternative = `${title}. Concepts: ${nodes.map((node) => `${node.code}, ${node.title}`).join('; ')}. Prerequisites: ${edges.map((edge) => `${edge.from_code} before ${edge.to_code}`).join('; ') || 'none'}.`;
    svg = graphSvg(title, textAlternative, nodes, edges);
  } else {
    if (!items.length) { course.close(); throw new TutorError('visual items are required', 64); }
    textAlternative = `${title}. ${items.map((item, index) => `${index + 1}. ${item}`).join(' ')}`;
    svg = cardsSvg(title, textAlternative, items, kind);
  }
  course.close();
  const id = stableId('visual', actor.studentId, kind, title, conceptCode ?? '', JSON.stringify(items), JSON.stringify(resolvedProvenance));
  const dir = path.join(paths(root).studentsDir, actor.studentId, 'artifacts', id);
  ensureDir(dir);
  const svgPath = path.join(dir, 'visual.svg');
  const textPath = path.join(dir, 'visual.txt');
  const htmlPath = path.join(dir, 'index.html');
  fs.writeFileSync(svgPath, svg);
  fs.writeFileSync(textPath, textAlternative + '\n');
  fs.writeFileSync(htmlPath, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font-family:system-ui;margin:0;background:#f7f9fc;color:#17233e}main{max-width:960px;margin:auto;padding:16px}img{width:100%;height:auto}details{margin-top:16px}</style></head><body><main><img src="visual.svg" alt="${escape(textAlternative)}"><details><summary>Text alternative</summary><p>${escape(textAlternative)}</p></details></main></body></html>`);
  const contentHash = sha256(svg);
  const manifest = { schema: 1, id, generated_at: now(), generated: true, kind, title, concept_code: conceptCode ?? null, text_alternative: textAlternative, provenance: resolvedProvenance, content_hash: contentHash };
  writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  const db = openStudent(root, actor.studentId);
  db.query(`INSERT OR REPLACE INTO visual_artifacts
    (id,at,kind,concept_code,title,svg_path,html_path,text_path,provenance_json,content_hash)
    VALUES ($id,$at,$kind,$concept,$title,$svg,$html,$text,$provenance,$hash)`).run({
      $id: id, $at: now(), $kind: kind, $concept: conceptCode ?? null, $title: title.slice(0, 300),
      $svg: svgPath, $html: htmlPath, $text: textPath, $provenance: JSON.stringify(resolvedProvenance), $hash: contentHash,
    });
  appendTrace(db, actor.studentId, id, 'visual', conceptCode ?? null, {
    kind, title, content_hash: contentHash, provenance: resolvedProvenance, text_alternative_length: textAlternative.length,
  });
  db.close();
  return { ...manifest, svg_path: svgPath, html_path: htmlPath, text_path: textPath, receipt: 'ACCESSIBLE VISUAL RENDERED' };
}
