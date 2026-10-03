import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { readTutorApplicationStatus, readTutorApplicationStatusForGroup } from '../templates/education/knowledge-graph-tutor/host/status.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createDatabase(file: string, schema: string, rows: unknown[][] = []): void {
  const db = new Database(file);
  db.exec(schema);
  const placeholders = rows[0] ? rows[0].map(() => '?').join(',') : '';
  if (placeholders) {
    const insert = db.prepare(`INSERT INTO ${schema.includes('agent_groups') ? 'agent_groups' : schema.includes('class_config') ? 'class_config' : 'knowledge_graphs'} VALUES (${placeholders})`);
    for (const row of rows) insert.run(...row);
  }
  db.close();
}

describe('knowledge-graph tutor application status', () => {
  test('reads class roster and course graph revision from their authoritative databases', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-status-'));
    cleanup.push(root);
    const group = { id: 'ag-maths', name: 'Maths Tutor', folder: 'maths' };
    const tutorRoot = path.join(root, 'groups', group.folder, 'tutor-app');
    fs.mkdirSync(path.join(tutorRoot, 'course'), { recursive: true });
    createDatabase(path.join(tutorRoot, 'class.db'), `
      CREATE TABLE class_config (id INTEGER PRIMARY KEY, class_name TEXT NOT NULL, subject TEXT NOT NULL);
      CREATE TABLE students (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    `, [[1, 'Class 7', 'Maths']]);
    const classDb = new Database(path.join(tutorRoot, 'class.db'));
    classDb.prepare('INSERT INTO students VALUES (?, ?)').run('stu-1', 'approved');
    classDb.prepare('INSERT INTO students VALUES (?, ?)').run('stu-2', 'pending');
    classDb.close();
    createDatabase(path.join(tutorRoot, 'course', 'course.db'), `
      CREATE TABLE knowledge_graphs (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    `, [[1, 4], [2, 7]]);
    const courseDb = new Database(path.join(tutorRoot, 'course', 'course.db'));
    courseDb.exec(`CREATE TABLE instruction_resources (
      id TEXT PRIMARY KEY, canonical_concept_id TEXT, artifact_path TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    courseDb.prepare('INSERT INTO instruction_resources VALUES (?, ?, ?, ?)').run('resource-active', 'C01', path.join(tutorRoot, 'course', 'resources', 'active.html'), 'active');
    courseDb.prepare('INSERT INTO instruction_resources VALUES (?, ?, ?, ?)').run('resource-proposed', 'C02', path.join(tutorRoot, 'course', 'resources', 'proposed.html'), 'proposed');
    fs.mkdirSync(path.join(tutorRoot, 'course', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(tutorRoot, 'course', 'resources', 'active.html'), '<!doctype html>');
    courseDb.close();

    const status = readTutorApplicationStatusForGroup(root, group);
    expect(status).toMatchObject({
      id: 'ag-maths', name: 'Maths Tutor', folder: 'maths', initialized: true,
      class: { class_name: 'Class 7', subject: 'Maths' }, students: 1, graphs: 2, courseRevisions: 7,
      materials: { total: 2, active: 1, proposed: 1, missing_files: 1, concepts_with_materials: 2 },
    });
  });

  test('resolves the application group through central NanoClaw state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-status-central-'));
    cleanup.push(root);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const central = new Database(path.join(root, 'data', 'v2.db'));
    central.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL)');
    central.prepare('INSERT INTO agent_groups VALUES (?, ?, ?)').run('ag-empty', 'Empty Tutor', 'empty');
    central.close();

    expect(readTutorApplicationStatus(root, 'ag-empty')).toMatchObject({
      id: 'ag-empty', name: 'Empty Tutor', folder: 'empty', initialized: false, students: 0, graphs: 0, courseRevisions: 0,
    });
  });

  test('counts source documents and extracted items alongside generated resources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-status-source-'));
    cleanup.push(root);
    const group = { id: 'ag-source', name: 'Source Tutor', folder: 'source' };
    const tutorRoot = path.join(root, 'groups', group.folder, 'tutor-app');
    fs.mkdirSync(path.join(tutorRoot, 'course', 'graphs', 'kg-1', 'snippets', 'C01'), { recursive: true });
    fs.mkdirSync(path.join(tutorRoot, 'course', 'resources'), { recursive: true });
    fs.mkdirSync(path.join(tutorRoot, 'course', 'documents', 'doc-1'), { recursive: true });
    fs.writeFileSync(path.join(tutorRoot, 'course', 'documents', 'doc-1', 'normalized.md'), '# Source');
    fs.writeFileSync(path.join(tutorRoot, 'course', 'graphs', 'kg-1', 'snippets', 'C01', 'item-1.md'), '# Question');
    fs.writeFileSync(path.join(tutorRoot, 'course', 'resources', 'resource-1.html'), '<!doctype html>');
    fs.mkdirSync(path.join(tutorRoot), { recursive: true });
    createDatabase(path.join(tutorRoot, 'class.db'), `
      CREATE TABLE class_config (id INTEGER PRIMARY KEY, class_name TEXT NOT NULL, subject TEXT NOT NULL);
      CREATE TABLE students (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    `, [[1, 'Class 7', 'Maths']]);
    const courseDb = new Database(path.join(tutorRoot, 'course', 'course.db'));
    courseDb.exec(`
      CREATE TABLE knowledge_graphs (id TEXT PRIMARY KEY, slug TEXT, version INTEGER, status TEXT, base_document_id TEXT, scope_label TEXT);
      CREATE TABLE source_documents (id TEXT PRIMARY KEY, filename TEXT, role TEXT, sha256 TEXT, normalized_path TEXT);
      CREATE TABLE concepts (id TEXT PRIMARY KEY, graph_id TEXT, code TEXT, source_code TEXT, canonical_concept_id TEXT, definition TEXT, status TEXT);
      CREATE TABLE content_items (id TEXT PRIMARY KEY, graph_id TEXT, source_document_id TEXT, generated INTEGER, kind TEXT, source_locator TEXT);
      CREATE TABLE item_concepts (item_id TEXT, concept_id TEXT);
      CREATE TABLE instruction_resources (id TEXT PRIMARY KEY, canonical_concept_id TEXT, artifact_path TEXT, status TEXT);
    `);
    courseDb.prepare('INSERT INTO knowledge_graphs VALUES (?, ?, ?, ?, ?, ?)').run('kg-1', 'numbers', 1, 'active', 'doc-1', 'Numbers');
    courseDb.prepare('INSERT INTO source_documents VALUES (?, ?, ?, ?, ?)').run('doc-1', 'base.md', 'base', 'hash', path.join(tutorRoot, 'course', 'documents', 'doc-1', 'normalized.md'));
    courseDb.prepare('INSERT INTO concepts VALUES (?, ?, ?, ?, ?, ?, ?)').run('cpt-1', 'kg-1', 'C01', 'N01', 'ccpt-1', '', 'active');
    courseDb.prepare('INSERT INTO content_items VALUES (?, ?, ?, ?, ?, ?)').run('item-1', 'kg-1', 'doc-1', 0, 'question', 'question[1]');
    courseDb.prepare('INSERT INTO item_concepts VALUES (?, ?)').run('item-1', 'cpt-1');
    courseDb.prepare('INSERT INTO instruction_resources VALUES (?, ?, ?, ?)').run('resource-1', 'ccpt-1', path.join(tutorRoot, 'course', 'resources', 'resource-1.html'), 'active');
    courseDb.close();

    const status = readTutorApplicationStatusForGroup(root, group);
    expect(status.materials).toMatchObject({
      total: 3, active: 3, proposed: 0, missing_files: 0, concepts_with_materials: 1,
      source_documents: 1, source_items: 1, generated_resources: 1,
    });
  });
});
