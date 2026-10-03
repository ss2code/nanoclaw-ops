/**
 * Generic, read-only SQLite inventory for ops surfaces.
 *
 * This is intentionally schema-light: it opens candidate files readonly,
 * lists user tables, counts rows, and reports a best-effort freshness column.
 * Domain readers can scope which files to inspect without coupling this helper
 * to their private schemas.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface SqliteTableSummary {
  name: string;
  rowCount: number | null;
  timestampColumn: string | null;
  latestTimestamp: string | null;
  previewColumns: string[];
  previewRows: Record<string, string>[];
  error: string | null;
}

export interface SqliteDbInventory {
  label: string;
  path: string;
  scope: string;
  exists: boolean;
  readable: boolean;
  sizeBytes: number | null;
  mtime: string | null;
  tableCount: number;
  tables: SqliteTableSummary[];
  error: string | null;
}

const TIMESTAMP_COLUMNS = [
  'updated_at',
  'created_at',
  'timestamp',
  'delivered_at',
  'completed_at',
  'status_changed',
  'last_seen',
  'first_seen',
  'process_after',
];

const PREVIEW_TABLE_DENYLIST = [/_fts(?:_|$)/i];

function openReadonly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return db;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[]).map((row) => row.name);
}

function hasRowid(db: Database.Database, table: string): boolean {
  try {
    db.prepare(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function stringifyCell(value: unknown): string {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return `<blob ${value.length} bytes>`;
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function previewRows(
  db: Database.Database,
  table: string,
  columns: string[],
  timestampColumn: string | null,
): { previewColumns: string[]; previewRows: Record<string, string>[] } {
  if (PREVIEW_TABLE_DENYLIST.some((pattern) => pattern.test(table))) {
    return { previewColumns: [], previewRows: [] };
  }
  const previewColumns = columns.slice(0, 8);
  if (previewColumns.length === 0) return { previewColumns, previewRows: [] };
  const orderBy = timestampColumn
    ? ` ORDER BY ${quoteIdent(timestampColumn)} DESC`
    : hasRowid(db, table)
      ? ' ORDER BY rowid DESC'
      : '';
  const selectList = previewColumns.map(quoteIdent).join(', ');
  const rows = db.prepare(`SELECT ${selectList} FROM ${quoteIdent(table)}${orderBy} LIMIT 3`).all() as Record<
    string,
    unknown
  >[];
  return {
    previewColumns,
    previewRows: rows.map((row) =>
      Object.fromEntries(previewColumns.map((column) => [column, stringifyCell(row[column])])) as Record<
        string,
        string
      >,
    ),
  };
}

function inspectTable(db: Database.Database, table: string): SqliteTableSummary {
  try {
    const rowCount = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number } | undefined)?.n ?? 0,
    );
    const names = columnNames(db, table);
    const columns = new Set(names);
    const timestampColumn = TIMESTAMP_COLUMNS.find((column) => columns.has(column)) ?? null;
    const latestTimestamp = timestampColumn
      ? ((
          db.prepare(`SELECT MAX(${quoteIdent(timestampColumn)}) AS ts FROM ${quoteIdent(table)}`).get() as {
            ts: string | null;
          }
        )?.ts ?? null)
      : null;
    return {
      name: table,
      rowCount,
      timestampColumn,
      latestTimestamp,
      ...previewRows(db, table, names, timestampColumn),
      error: null,
    };
  } catch (error) {
    return {
      name: table,
      rowCount: null,
      timestampColumn: null,
      latestTimestamp: null,
      previewColumns: [],
      previewRows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function inspectSqliteDb(file: string, opts: { label?: string; scope?: string } = {}): SqliteDbInventory {
  const label = opts.label ?? path.basename(file);
  const scope = opts.scope ?? 'database';
  if (!fs.existsSync(file)) {
    return {
      label,
      path: file,
      scope,
      exists: false,
      readable: false,
      sizeBytes: null,
      mtime: null,
      tableCount: 0,
      tables: [],
      error: 'file missing',
    };
  }
  const stat = fs.statSync(file);
  let db: Database.Database | null = null;
  try {
    db = openReadonly(file);
    const names = tableNames(db);
    const tables = names.map((table) => inspectTable(db!, table));
    return {
      label,
      path: file,
      scope,
      exists: true,
      readable: true,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      tableCount: names.length,
      tables,
      error: null,
    };
  } catch (error) {
    return {
      label,
      path: file,
      scope,
      exists: true,
      readable: false,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      tableCount: 0,
      tables: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

export function listSqliteFiles(dir: string, opts: { recursive?: boolean; maxDepth?: number } = {}): string[] {
  if (!fs.existsSync(dir)) return [];
  const recursive = opts.recursive ?? false;
  const maxDepth = opts.maxDepth ?? 1;
  const out: string[] = [];
  const walk = (current: string, depth: number) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.(db|sqlite|sqlite3)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}
