import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectDocumentFormat,
  readDocument,
  type OcrAdapter,
} from '../document-format';

const worlds: string[] = [];
afterEach(() => { for (const world of worlds.splice(0)) fs.rmSync(world, { recursive: true, force: true }); });

function tempFile(name: string, content: string | Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-format-'));
  worlds.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('format-aware document intake', () => {
  test('detects by content signature rather than trusting a misleading extension', () => {
    const pdf = Buffer.from('%PDF-1.7\n');
    expect(detectDocumentFormat('notes.txt', pdf).format).toBe('pdf');
    expect(detectDocumentFormat('photo.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).format).toBe('image');
    expect(detectDocumentFormat('page.txt', Buffer.from('<!doctype html><html><body>Hi</body></html>')).format).toBe('html');
  });

  test('extracts text from a native PDF and records page locators', () => {
    const pdf = `%PDF-1.4
1 0 obj << /Type /Page >> endobj
2 0 obj
<< /Length 66 >>
stream
BT
/F1 12 Tf
(Native PDF text) Tj
(Second line) Tj
ET
endstream
endobj
%%EOF
`;
    const result = readDocument(tempFile('scan.pdf', pdf));
    expect(result.format).toBe('pdf');
    expect(result.status).toBe('ready');
    expect(result.text).toContain('Native PDF text');
    expect(result.text).toContain('Second line');
    expect(result.segments.some((segment) => segment.locator === 'page:1')).toBe(true);
    expect(result.pageCount).toBe(1);
  });

  test('uses an injectable OCR adapter for images and scanned PDFs', () => {
    const ocr: OcrAdapter = {
      id: 'mock-ocr', version: '2026.1',
      supports: (format) => format === 'image' || format === 'pdf',
      extract: ({ format }) => ({
        text: format === 'image' ? 'OCR image text' : 'OCR page text',
        segments: [{ text: format === 'image' ? 'OCR image text' : 'OCR page text', locator: format === 'image' ? 'image:1' : 'page:1', confidence: 0.91 }],
        ocrConfidence: 0.91,
        method: 'mock-ocr',
      }),
    };
    const image = readDocument(tempFile('worksheet.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { ocrAdapter: ocr });
    expect(image.status).toBe('ready');
    expect(image.text).toBe('OCR image text');
    expect(image.ocrConfidence).toBe(0.91);
    const scanned = readDocument(tempFile('worksheet.pdf', Buffer.from('%PDF-1.4\n')), { ocrAdapter: ocr });
    expect(scanned.status).toBe('ready');
    expect(scanned.extractionMethod).toBe('mock-ocr');
  });

  test('extracts DOCX and PPTX XML without interpreting arbitrary archive members', () => {
    const docx = Buffer.from('UEsDBBQAAAAIAPo8IV2sbhJangAAANwAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2PsQ7CMBBDf6XKitqrGBhQ24UdGPiBU3JtI5pLlBwF/p4EpA6Mlu1nubu9A6Xq5RZOvZpFwhEg6ZkcpsYH4uyMPjqULOMEAfUdJ4J92x5AexZiqaUw1NBdVorRGqquGOWMjnoFTx8NGK8fLiebTFPV6Vcry73CEBarUaxnWNn8bdZ+HK2mrV9oIXpNKVme3NJsjkPLu4KHoYPvqeEDUEsDBBQAAAAIAPo8IV3uF7P7QQAAAFEAAAARAAAAd29yZC9kb2N1bWVudC54bWyzSclPLs1NzSuxs0nKT6m0symw80jNyclXsCmxc/F3jrDRB8roF4DEg1OT8/NSFAoSixLTixILMsDC+hBd+nBjAFBLAQIeAxQAAAAIAPo8IV2sbhJangAAANwAAAATAAAAAAAAAAEAAACkgQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAh4DFAAAAAgA+jwhXe4Xs/tBAAAAUQAAABEAAAAAAAAAAQAAAKSBzwAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAACAAIAgAAAAD8BAAAAAA==', 'base64');
    const pptx = Buffer.from('UEsDBBQAAAAIAPo8IV060cFEnAAAANYAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2PvQ7CMAyEX6XKihoXBgbUdmEHBl7ASt02Ij9WYip4e9J2YzrZ5/tObp9fplx9vAu5U7MIXwCymclj1pEpFGeMyaOUMU3AaF44EZya5gwmBqEgtawM1bf3hVKyA1UPTHJDT50CZoHsyjLvctSFqKrrHl3bO4XMzhoUGwMsYfjrreM4WkNDNG9fIpoT5aLbuXd6ox5WKPQtbO/0P1BLAwQUAAAACAD6PCFddiAalCcAAAA6AAAAFQAAAHBwdC9zbGlkZXMvc2xpZGUxLnhtbLMpsCrOSbGzSbQqsQvOyUxJVSjJLMlJtdEHCSCJJuWnVEIF9SFaAFBLAQIeAxQAAAAIAPo8IV060cFEnAAAANYAAAATAAAAAAAAAAEAAACkgQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAh4DFAAAAAgA+jwhXXYgGpQnAAAAOgAAABUAAAAAAAAAAQAAAKSBzQAAAHBwdC9zbGlkZXMvc2xpZGUxLnhtbFBLBQYAAAAAAgACAIQAAAAnAQAAAAA=', 'base64');
    const docxResult = readDocument(tempFile('lesson.docx', docx));
    expect(docxResult.format).toBe('docx');
    expect(docxResult.text).toContain('Hello DOCX');
    expect(docxResult.text).toContain('Second paragraph');
    const pptxResult = readDocument(tempFile('lesson.pptx', pptx));
    expect(pptxResult.format).toBe('pptx');
    expect(pptxResult.text).toContain('Slide title');
    expect(pptxResult.segments[0]?.locator).toBe('slide:1');
  });

  test('quarantines unavailable OCR, corrupt PDFs, unsafe archives, and empty extraction', () => {
    const image = readDocument(tempFile('empty.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    expect(image.status).toBe('needs-ocr');
    expect(image.text).toBe('');
    const corrupt = readDocument(tempFile('broken.pdf', Buffer.from('%PDF-not-a-valid-document')));
    expect(corrupt.status).toBe('corrupt');
    const unsafeZip = Buffer.from('UEsDBBQAAAAAAIi3WlsAAAAAAAAAAAAAAAAJAAAALi4vZXZpbC50eHRQSwECFAMUAAAAAACIt1pbAAAAAAAAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAALi4vZXZpbC50eHRQSwUGAAAAAAEAAQA3AAAAJQAAAAAA', 'base64');
    const unsafe = readDocument(tempFile('unsafe.docx', unsafeZip));
    expect(unsafe.status).toBe('corrupt');
    expect(unsafe.warnings.join(' ')).toMatch(/archive|path|unsafe/i);
    const oversized = readDocument(tempFile('large.txt', 'x'.repeat(128)), { maxBytes: 16 });
    expect(oversized.status).toBe('oversized');
  });
});
