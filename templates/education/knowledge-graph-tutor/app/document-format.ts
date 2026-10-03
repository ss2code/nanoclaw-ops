import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeText, TutorError } from './util';

/**
 * Document bytes are hostile input. Format detection is therefore signature
 * first, with the filename and declared MIME used only as hints for formats
 * which have no magic number (plain text and Markdown).
 */
export type DocumentFormat = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'docx' | 'pptx' | 'unknown';
export type DocumentStatus = 'ready' | 'needs-ocr' | 'needs-external-extractor' | 'unsupported' | 'corrupt' | 'oversized' | 'empty';

export interface DocumentFormatInfo {
  format: DocumentFormat;
  mimeType: string;
  confidence: 'signature' | 'content' | 'hint';
  reason?: string;
}

export interface ExtractedSegment {
  text: string;
  locator: string;
  confidence?: number;
}

export interface ExtractionResult {
  text: string;
  segments: ExtractedSegment[];
  method: string;
  extractorVersion?: string;
  ocrConfidence?: number | null;
  pageCount?: number | null;
  warnings?: string[];
}

export interface ExtractorInput {
  path: string;
  bytes: Buffer;
  format: DocumentFormat;
  mimeType: string;
}

export interface DocumentExtractor {
  id: string;
  version: string;
  supports: (format: DocumentFormat) => boolean;
  extract: (input: ExtractorInput) => ExtractionResult;
}

export interface OcrAdapter {
  id: string;
  version: string;
  supports: (format: DocumentFormat) => boolean;
  extract: (input: ExtractorInput) => ExtractionResult;
}

export interface DocumentReadOptions {
  forcedMimeType?: string;
  extractors?: DocumentExtractor[];
  ocrAdapter?: OcrAdapter;
  ocrProvider?: string;
  maxBytes?: number;
}

export interface DocumentReadResult {
  bytes: Buffer;
  text: string;
  mimeType: string;
  extractionMethod: string;
  format: DocumentFormat;
  status: DocumentStatus;
  warnings: string[];
  segments: ExtractedSegment[];
  extractorVersion: string | null;
  ocrConfidence: number | null;
  pageCount: number | null;
  structuredJson: Record<string, unknown>;
}

export const DEFAULT_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 2_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_MEMBER_BYTES = 20 * 1024 * 1024;

const MIME_BY_FORMAT: Record<DocumentFormat, string> = {
  markdown: 'text/markdown', text: 'text/plain', html: 'text/html', pdf: 'application/pdf',
  image: 'image/*', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', unknown: 'application/octet-stream',
};

function ascii(bytes: Buffer, length = Math.min(bytes.length, 512)): string {
  return bytes.subarray(0, length).toString('latin1');
}

function starts(bytes: Buffer, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function isZip(bytes: Buffer): boolean {
  return starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

function isImage(bytes: Buffer): { mime: string } | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png' };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg' };
  if (ascii(bytes, 6) === 'GIF87a' || ascii(bytes, 6) === 'GIF89a') return { mime: 'image/gif' };
  if (ascii(bytes, 4) === 'RIFF' && ascii(bytes.subarray(8), 4) === 'WEBP') return { mime: 'image/webp' };
  if (ascii(bytes, 4) === 'II*\0' || ascii(bytes, 4) === 'MM\0*') return { mime: 'image/tiff' };
  if (ascii(bytes, 2) === 'BM') return { mime: 'image/bmp' };
  return null;
}

function hintForPath(documentPath: string, forcedMimeType?: string): DocumentFormatInfo | null {
  const mime = (forcedMimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  const ext = path.extname(documentPath).toLowerCase();
  if (mime === 'text/markdown' || ['.md', '.markdown', '.mdown'].includes(ext)) return { format: 'markdown', mimeType: 'text/markdown', confidence: mime ? 'hint' : 'content' };
  if (mime === 'text/plain' || ext === '.txt' || ext === '.text') return { format: 'text', mimeType: 'text/plain', confidence: mime ? 'hint' : 'content' };
  if (mime === 'text/html' || ['.html', '.htm'].includes(ext)) return { format: 'html', mimeType: 'text/html', confidence: mime ? 'hint' : 'content' };
  if (mime === 'application/pdf' || ext === '.pdf') return { format: 'pdf', mimeType: 'application/pdf', confidence: mime ? 'hint' : 'content' };
  if (mime.includes('wordprocessingml.document') || ext === '.docx') return { format: 'docx', mimeType: MIME_BY_FORMAT.docx, confidence: mime ? 'hint' : 'content' };
  if (mime.includes('presentationml.presentation') || ext === '.pptx') return { format: 'pptx', mimeType: MIME_BY_FORMAT.pptx, confidence: mime ? 'hint' : 'content' };
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp'].includes(ext)) return { format: 'image', mimeType: mime.startsWith('image/') ? mime : MIME_BY_FORMAT.image, confidence: mime ? 'hint' : 'content' };
  return null;
}

interface ZipMember {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function u16(bytes: Buffer, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error('truncated ZIP header');
  return bytes.readUInt16LE(offset);
}

function u32(bytes: Buffer, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error('truncated ZIP header');
  return bytes.readUInt32LE(offset);
}

function unsafeArchiveName(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  return !normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').includes('..') || /^[a-zA-Z]:/.test(normalized);
}

function zipMembers(bytes: Buffer): ZipMember[] {
  const minOffset = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (offset >= 0 && bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('ZIP end-of-directory record not found');
  const count = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (count > MAX_ARCHIVE_MEMBERS || centralOffset + centralSize > bytes.length) throw new Error('unsafe or truncated ZIP central directory');
  const members: ZipMember[] = [];
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error('invalid ZIP central-directory member');
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error('truncated ZIP member');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (unsafeArchiveName(name)) throw new Error(`unsafe ZIP member path: ${name}`);
    if (uncompressedSize > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`ZIP member exceeds ${MAX_ARCHIVE_MEMBER_BYTES} byte limit`);
    total += uncompressedSize;
    if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error('ZIP archive exceeds uncompressed size limit');
    members.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor = end;
  }
  return members;
}

function zipMember(bytes: Buffer, sourcePath: string, member: ZipMember): Buffer {
  if (member.localOffset + 30 > bytes.length || u32(bytes, member.localOffset) !== 0x04034b50) throw new Error('invalid ZIP local header');
  const nameLength = u16(bytes, member.localOffset + 26);
  const extraLength = u16(bytes, member.localOffset + 28);
  const start = member.localOffset + 30 + nameLength + extraLength;
  const end = start + member.compressedSize;
  if (end > bytes.length) throw new Error('truncated ZIP member data');
  if (member.method === 0) return Buffer.from(bytes.subarray(start, end));
  if (member.method !== 8) throw new Error(`unsupported ZIP compression method: ${member.method}`);
  // Bun's native inflater is fast but ZIP uses raw DEFLATE. The container
  // image deliberately includes `unzip`; the member name is selected from a
  // validated allow-list and never passed through a shell.
  const result = Bun.spawnSync(['unzip', '-p', sourcePath, member.name], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`ZIP member could not be decompressed: ${result.stderr.toString().trim()}`);
  const output = Buffer.from(result.stdout);
  if (output.length > MAX_ARCHIVE_MEMBER_BYTES || output.length > member.uncompressedSize + 1024) throw new Error('decompressed ZIP member exceeded declared size');
  return output;
}

function archiveInfo(bytes: Buffer, sourcePath: string): { format: DocumentFormat; mimeType: string; members: ZipMember[] } {
  const members = zipMembers(bytes);
  const names = new Set(members.map((member) => member.name));
  // The part names are a stronger and safer discriminator than trusting the
  // package's optional content-type XML. Never extract arbitrary archive data
  // merely to identify a format.
  if (names.has('word/document.xml')) return { format: 'docx', mimeType: MIME_BY_FORMAT.docx, members };
  if ([...names].some((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))) return { format: 'pptx', mimeType: MIME_BY_FORMAT.pptx, members };
  throw new Error('ZIP is not a supported DOCX or PPTX package');
}

export function detectDocumentFormat(documentPath: string, bytes: Buffer, forcedMimeType?: string): DocumentFormatInfo {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: 'pdf', mimeType: 'application/pdf', confidence: 'signature' };
  const image = isImage(bytes);
  if (image) return { format: 'image', mimeType: image.mime, confidence: 'signature' };
  if (isZip(bytes)) {
    try {
      const info = archiveInfo(bytes, documentPath);
      return { format: info.format, mimeType: info.mimeType, confidence: 'signature' };
    } catch (error) {
      return { format: 'unknown', mimeType: 'application/octet-stream', confidence: 'signature', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const sample = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '');
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(sample) || /<\/html\s*>/i.test(sample)) return { format: 'html', mimeType: 'text/html', confidence: 'content' };
  const hint = hintForPath(documentPath, forcedMimeType);
  if (hint?.format === 'html' && /<\/?[a-z][^>]*>/i.test(sample)) return hint;
  if (bytes.includes(0)) return { format: 'unknown', mimeType: 'application/octet-stream', confidence: 'signature', reason: 'binary content has no supported signature' };
  if ([...bytes.subarray(0, 4096)].some((byte) => byte < 9 || (byte > 13 && byte < 32))) {
    return { format: 'unknown', mimeType: 'application/octet-stream', confidence: 'signature', reason: 'binary content has no supported signature' };
  }
  if (hint?.format === 'markdown') return hint;
  if (hint?.format === 'text') return hint;
  if (hint) return hint;
  return { format: 'text', mimeType: 'text/plain', confidence: 'content', reason: 'plain UTF-8 text fallback' };
}

export function mimeTypeForPath(documentPath: string): string {
  return hintForPath(documentPath)?.mimeType ?? 'application/octet-stream';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Math.min(Number(decimal), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)));
}

function safeHtmlText(text: string): string {
  return decodeEntities(text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ' ')
    .replace(/javascript\s*:/gi, '')
    .replace(/<[^>]+>/g, ' '));
}

function textResult(text: string, method: string, locator = 'document:1', extractorVersion = 'builtin-text-v1'): ExtractionResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error(`extracted text exceeded ${MAX_TEXT_BYTES} byte limit`);
  const normalized = normalizeText(text);
  return { text: normalized, segments: normalized ? [{ text: normalized, locator }] : [], method, extractorVersion };
}

function decodePdfLiteral(value: string): string {
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
  return value.replace(/\\([nrtbf()\\])/g, (_, escaped: string) => escapes[escaped] ?? escaped)
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function pdfLiteralStrings(text: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '(') continue;
    const start = ++index;
    let depth = 1;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '(') depth += 1;
      if (char === ')' && --depth === 0) break;
    }
    if (depth !== 0) break;
    let after = index + 1;
    while (/\s/.test(text[after] ?? '')) after += 1;
    if (text.slice(after, after + 2) === 'Tj' || text.slice(after, after + 2) === 'TJ') values.push(decodePdfLiteral(text.slice(start, index)));
  }
  return values;
}

function extractPdf(bytes: Buffer): ExtractionResult {
  const header = bytes.subarray(0, 9).toString('latin1');
  if (!/^%PDF-\d\.\d/.test(header)) throw new Error('invalid PDF header');
  const source = bytes.toString('latin1');
  const pageCount = [...source.matchAll(/\/Type\s*\/Page\b/g)].length || null;
  const segments: ExtractedSegment[] = [];
  for (const [index, match] of [...source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].entries()) {
    const headerStart = Math.max(0, (match.index ?? 0) - 4096);
    const objectHeader = source.slice(headerStart, match.index ?? 0);
    let streamText = match[1];
    if (/\/FlateDecode\b/.test(objectHeader)) {
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      const compressed = bytes.subarray(start, start + Buffer.byteLength(match[1], 'latin1'));
      try { streamText = Buffer.from((Bun as unknown as { inflateSync: (input: Uint8Array) => Uint8Array }).inflateSync(compressed)).toString('latin1'); }
      catch { continue; }
    }
    const values = pdfLiteralStrings(streamText).join(' ').trim();
    if (values) segments.push({ text: values, locator: `page:${Math.min(index + 1, pageCount ?? index + 1)}` });
  }
  const text = normalizeText(segments.map((segment) => segment.text).join('\n\n'));
  return { text, segments, method: text ? 'pdf-text-native' : 'pdf-text-native-empty', extractorVersion: 'builtin-pdf-text-v1', pageCount };
}

function xmlText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ' '));
}

function extractOffice(input: ExtractorInput, members: ZipMember[]): ExtractionResult {
  const targetPrefix = input.format === 'docx' ? /^word\/document\.xml$/i : /^ppt\/slides\/slide(\d+)\.xml$/i;
  const selected = members.filter((member) => targetPrefix.test(member.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const segments: ExtractedSegment[] = [];
  for (const member of selected) {
    const xml = zipMember(input.bytes, input.path, member).toString('utf8');
    const locator = input.format === 'docx' ? 'document:1' : `slide:${member.name.match(/slide(\d+)/i)?.[1] ?? segments.length + 1}`;
    const paragraphs = input.format === 'docx'
      ? [...xml.matchAll(/<(?:w:)?p\b[\s\S]*?<\/(?:w:)?p>/gi)].map((match) => xmlText(match[0]))
      : [xmlText(xml)];
    for (const [index, paragraph] of paragraphs.entries()) {
      const text = normalizeText(paragraph);
      if (text) segments.push({ text, locator: input.format === 'docx' ? `paragraph:${index + 1}` : locator });
    }
  }
  const text = normalizeText(segments.map((segment) => segment.text).join('\n\n'));
  return { text, segments, method: input.format === 'docx' ? 'docx-xml' : 'pptx-xml', extractorVersion: 'builtin-office-xml-v1', pageCount: input.format === 'pptx' ? selected.length : null };
}

function commandOutput(command: string[], maxBytes = MAX_TEXT_BYTES): Buffer {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
  const output = Buffer.from(result.stdout);
  if (output.length > maxBytes) throw new Error(`${command[0]} output exceeded safety limit`);
  return output;
}

export function createCommandOcrAdapter(provider = 'tesseract'): OcrAdapter | null {
  if (!['tesseract', 'builtin-tesseract'].includes(provider.toLowerCase())) return null;
  return {
    id: 'tesseract', version: 'command', supports: (format) => format === 'image' || format === 'pdf',
    extract: (input) => {
      if (input.format === 'image') {
        const text = commandOutput(['tesseract', input.path, 'stdout', '--dpi', '200'], MAX_TEXT_BYTES).toString('utf8');
        const normalized = normalizeText(text);
        return { text: normalized, segments: normalized ? [{ text: normalized, locator: 'image:1' }] : [], method: 'tesseract', extractorVersion: 'tesseract-command' };
      }
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-ocr-'));
      try {
        commandOutput(['pdftoppm', '-png', '-r', '150', input.path, path.join(temp, 'page')], 1_000_000);
        const pages = fs.readdirSync(temp).filter((name) => /^page-\d+\.png$/i.test(name)).sort();
        const segments: ExtractedSegment[] = [];
        for (const [index, page] of pages.entries()) {
          const text = normalizeText(commandOutput(['tesseract', path.join(temp, page), 'stdout'], MAX_TEXT_BYTES).toString('utf8'));
          if (text) segments.push({ text, locator: `page:${index + 1}` });
        }
        return { text: normalizeText(segments.map((segment) => segment.text).join('\n\n')), segments, method: 'tesseract-pdf', extractorVersion: 'tesseract-command', pageCount: pages.length || null };
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    },
  };
}

function builtinExtractors(): DocumentExtractor[] {
  return [{
    id: 'builtin', version: 'document-intake-v1', supports: (format) => ['markdown', 'text', 'html', 'pdf', 'docx', 'pptx'].includes(format),
    extract: (input) => {
      if (input.format === 'pdf') return extractPdf(input.bytes);
      if (input.format === 'html') return textResult(safeHtmlText(input.bytes.toString('utf8')), 'html-sanitized-text');
      if (input.format === 'docx' || input.format === 'pptx') return extractOffice(input, zipMembers(input.bytes));
      return textResult(input.bytes.toString('utf8'), input.format === 'markdown' ? 'utf8-markdown' : 'utf8-text');
    },
  }];
}

function emptyResult(method: string, extractorVersion: string | null = null): ExtractionResult {
  return { text: '', segments: [], method, extractorVersion: extractorVersion ?? undefined };
}

/** Read and extract one document; callers retain the original bytes separately. */
export function readDocument(documentPath: string, forcedMimeOrOptions?: string | DocumentReadOptions): DocumentReadResult {
  if (!fs.existsSync(documentPath)) throw new TutorError('document file not found', 66);
  const options: DocumentReadOptions = typeof forcedMimeOrOptions === 'string' ? { forcedMimeType: forcedMimeOrOptions } : (forcedMimeOrOptions ?? {});
  const stat = fs.statSync(documentPath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  if (!stat.isFile()) return { bytes: Buffer.alloc(0), text: '', mimeType: 'application/octet-stream', extractionMethod: 'none', format: 'unknown', status: 'unsupported', warnings: ['document path is not a regular file'], segments: [], extractorVersion: null, ocrConfidence: null, pageCount: null, structuredJson: {} };
  if (stat.size > maxBytes) return { bytes: Buffer.alloc(0), text: '', mimeType: 'application/octet-stream', extractionMethod: 'size-limit', format: 'unknown', status: 'oversized', warnings: [`document exceeds ${maxBytes} byte limit`], segments: [], extractorVersion: null, ocrConfidence: null, pageCount: null, structuredJson: {} };
  const bytes = fs.readFileSync(documentPath);
  const detected = detectDocumentFormat(documentPath, bytes, options.forcedMimeType);
  const warnings = detected.reason ? [detected.reason] : [];
  if (detected.format === 'unknown' && isZip(bytes)) return { bytes, text: '', mimeType: detected.mimeType, extractionMethod: 'archive-validation', format: 'unknown', status: 'corrupt', warnings: [`archive validation failed${warnings.length ? `: ${warnings.join('; ')}` : ''}`], segments: [], extractorVersion: null, ocrConfidence: null, pageCount: null, structuredJson: {} };
  const input: ExtractorInput = { path: documentPath, bytes, format: detected.format, mimeType: detected.mimeType };
  const extractor = (options.extractors ?? builtinExtractors()).find((candidate) => candidate.supports(detected.format));
  let result = emptyResult('no-extractor');
  let status: DocumentStatus = extractor ? 'ready' : (detected.format === 'image' ? 'needs-ocr' : 'unsupported');
  let extractionMethod = result.method;
  let extractorVersion = result.extractorVersion ?? (extractor?.version ?? null);
  let ocrConfidence = result.ocrConfidence ?? null;
  let pageCount = result.pageCount ?? null;
  if (!extractor) warnings.push(`no extractor is configured for ${detected.format}`);
  if (extractor) {
    try {
      result = extractor.extract(input);
      if (Buffer.byteLength(result.text, 'utf8') > MAX_TEXT_BYTES) {
        result = emptyResult('size-limit', extractor.version);
        status = 'oversized';
        warnings.push(`extracted text exceeded ${MAX_TEXT_BYTES} byte limit`);
      }
      extractionMethod = result.method;
      extractorVersion = result.extractorVersion ?? extractor.version;
      ocrConfidence = result.ocrConfidence ?? null;
      pageCount = result.pageCount ?? null;
    } catch (error) {
      status = 'corrupt';
      warnings.push(`extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (status !== 'corrupt' && status !== 'oversized' && (detected.format === 'image' || detected.format === 'pdf') && !result.text) {
    const ocr = options.ocrAdapter ?? (options.ocrProvider ? createCommandOcrAdapter(options.ocrProvider) : null);
    if (ocr?.supports(detected.format)) {
      try {
        result = ocr.extract(input);
        if (Buffer.byteLength(result.text, 'utf8') > MAX_TEXT_BYTES) {
          result = emptyResult('size-limit', `${ocr.id}@${ocr.version}`);
          status = 'oversized';
          warnings.push(`OCR text exceeded ${MAX_TEXT_BYTES} byte limit`);
        } else {
          status = result.text ? 'ready' : 'empty';
        }
        extractionMethod = result.method; extractorVersion = result.extractorVersion ?? `${ocr.id}@${ocr.version}`;
        ocrConfidence = result.ocrConfidence ?? null; pageCount = result.pageCount ?? pageCount;
      } catch (error) { status = 'needs-ocr'; warnings.push(`OCR failed: ${error instanceof Error ? error.message : String(error)}`); }
    } else { status = 'needs-ocr'; warnings.push('no OCR adapter is configured for this image/PDF'); }
  }
  if (detected.format === 'pdf' && !result.text && status === 'ready') status = 'needs-ocr';
  if (detected.format === 'image' && !result.text && status === 'ready') status = 'empty';
  if (result.warnings) warnings.push(...result.warnings);
  const text = normalizeText(result.text);
  if (!text && status === 'ready') status = 'empty';
  return {
    bytes, text, mimeType: detected.mimeType, extractionMethod, format: detected.format, status, warnings,
    segments: result.segments.filter((segment) => Boolean(normalizeText(segment.text))), extractorVersion,
    ocrConfidence, pageCount, structuredJson: {
      schema_version: 1, format: detected.format, mime_type: detected.mimeType, extraction_method: extractionMethod,
      segments: result.segments, page_count: pageCount, ocr_confidence: ocrConfidence,
    },
  };
}

/**
 * Source files are data, not instructions. This is also used when a caller
 * sanitizes generated HTML before promoting it to shared resources.
 */
export function htmlArtifactSafe(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:src|href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}
