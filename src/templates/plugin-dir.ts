/** Hardened walk/copy boundary for Agent Plugin content. */
import fs from 'fs';
import path from 'path';

export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_DEPTH = 16;

export interface PluginFile {
  rel: string;
  abs: string;
  size: number;
  mode: number;
}

/** Reject symlinks, special files, escapes, and abusive plugin trees. */
export function walkPluginDir(root: string): PluginFile[] {
  const resolvedRoot = path.resolve(root);
  const files: PluginFile[] = [];
  let totalBytes = 0;

  const visit = (relDir: string, depth: number): void => {
    const absDir = relDir ? path.join(resolvedRoot, relDir) : resolvedRoot;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw new Error(`Plugin rejected: entry name "${name}" is not allowed`);
      }
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);
      if (path.relative(resolvedRoot, abs).startsWith('..')) {
        throw new Error(`Plugin rejected: "${rel}" escapes the plugin root`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin rejected: "${rel}" is a symlink (symlinks are not allowed in plugins)`);
      }
      if (depth + 1 > MAX_PLUGIN_DEPTH) {
        throw new Error(`Plugin rejected: "${rel}" exceeds the maximum nesting depth of ${MAX_PLUGIN_DEPTH}`);
      }
      if (entry.isDirectory()) {
        visit(rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Plugin rejected: "${rel}" is not a regular file or directory`);
      const stat = fs.lstatSync(abs);
      files.push({ rel, abs, size: stat.size, mode: stat.mode });
      totalBytes += stat.size;
      if (files.length > MAX_PLUGIN_FILES) throw new Error(`Plugin rejected: more than ${MAX_PLUGIN_FILES} files`);
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        throw new Error(`Plugin rejected: total size exceeds ${MAX_PLUGIN_TOTAL_BYTES} bytes`);
      }
    }
  };

  visit('', 0);
  return files;
}

export function assertSafePluginDir(root: string): void {
  walkPluginDir(root);
}

/** Copy a validated plugin tree without following links. */
export function copyPluginDir(src: string, dest: string): void {
  const files = walkPluginDir(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) {
    const target = path.join(dest, ...file.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.abs, target);
    fs.chmodSync(target, file.mode & 0o777);
  }
}
