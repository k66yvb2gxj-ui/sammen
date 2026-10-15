import { open } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { inflateRawSync } from 'node:zlib';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 200_000;

const entities = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å',
});

export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (full, name) => {
    if (name[0] !== '#') return entities[name] ?? full;
    const code = name[1]?.toLowerCase() === 'x'
      ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '';
  });
}

// This conversion returns text only: no DOM, script execution, resources or links are loaded.
export function htmlToText(html) {
  const text = String(html ?? '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|head|iframe|object|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeHtmlEntities(text).replace(/\u0000/g, '')
    .replace(/[\t \f\v]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    if (swapped.length % 2) throw new Error('Ugyldig UTF-16-tekstfil.');
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

// Bound the expanded ZIP before handing a selected DOCX buffer to Mammoth.
function validateDocxArchive(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Filen er ikke et gyldig DOCX-dokument.');
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let cursor = buffer.readUInt32LE(end + 16);
  const centralStart = cursor;
  const centralEnd = cursor + centralSize;
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)
      || count === 0xffff || count > 5000 || centralEnd > end) {
    throw new Error('DOCX-arkivet er for stort eller bruker et format som ikke støttes.');
  }
  let expanded = 0;
  let hasDocument = false;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('DOCX-arkivet er skadet.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd || flags & 1 || size === 0xffffffff || compressedSize === 0xffffffff || ![0, 8].includes(method)) {
      throw new Error('Kryptert eller skadet DOCX støttes ikke.');
    }
    expanded += size;
    if (expanded > 60 * 1024 * 1024) throw new Error('DOCX-arkivet er for stort etter utpakking.');
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Error('DOCX-arkivet har ugyldige filnavn.');
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (localOffset + 30 > centralStart || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('DOCX-arkivet er skadet.');
    }
    const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > centralStart) throw new Error('DOCX-arkivet er skadet.');
    try {
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      const expandedEntry = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }) : compressed;
      if (expandedEntry.length !== size) throw new Error('Size mismatch');
    } catch {
      throw new Error('DOCX-arkivet er skadet eller overskrider grensen for utpakking.');
    }
    if (name === 'word/document.xml') {
      hasDocument = true;
      if (size > 10 * 1024 * 1024) throw new Error('Tekstinnholdet i DOCX-dokumentet er for stort.');
    }
    cursor = next;
  }
  if (!hasDocument || cursor !== centralEnd) throw new Error('Filen mangler gyldig Word-innhold.');
}

export async function importDocument(selectedPath) {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
    throw new Error('Velg en lokal dokumentfil.');
  }
  const filename = path.basename(selectedPath);
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.doc') throw new Error('Det gamle .doc-formatet støttes ikke. Eksporter eller lagre filen som .docx i Word.');
  if (!['.txt', '.md', '.markdown', '.html', '.htm', '.docx'].includes(extension)) {
    throw new Error('Støttede filer er TXT, Markdown, HTML og DOCX.');
  }
  const file = await open(selectedPath, 'r');
  let buffer;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Velg én fil, ikke en mappe.');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error('Dokumentet er større enn grensen på 20 MB.');
    buffer = Buffer.alloc(Math.min(info.size + 1, MAX_DOCUMENT_BYTES + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > info.size || bytes > MAX_DOCUMENT_BYTES) throw new Error('Dokumentet ble endret under import. Prøv igjen.');
    buffer = buffer.subarray(0, bytes);
  } finally {
    await file.close();
  }
  let title = filename.slice(0, -extension.length);
  let content;
  const warnings = [];
  const kind = extension === '.docx' ? 'docx'
    : ['.html', '.htm'].includes(extension) ? 'html'
      : ['.md', '.markdown'].includes(extension) ? 'markdown' : 'text';
  if (kind === 'docx') {
    validateDocxArchive(buffer);
    try {
      const result = await mammoth.extractRawText({ buffer });
      content = result.value;
      warnings.push('Kun tekst importeres fra Word. Bilder, kommentarer og sideoppsett følger ikke med.');
      for (const message of result.messages ?? []) warnings.push(String(message.message).slice(0, 500));
    } catch {
      throw new Error('Word-filen kunne ikke leses. Åpne den i Word og lagre en ny .docx-fil.');
    }
  } else {
    const raw = decodeText(buffer);
    if (raw.includes('\u0000')) throw new Error('Filen inneholder binærdata og kunne ikke leses som tekst.');
    if (kind === 'html') {
      const htmlTitle = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
      if (htmlTitle) title = htmlToText(htmlTitle).slice(0, 300) || title;
      content = htmlToText(raw);
      warnings.push('HTML importeres som tekst. Bilder, håndskrift, vedlegg og sideoppsett følger ikke med.');
    } else {
      content = raw.replace(/\r\n?/g, '\n').trim();
    }
  }
  content = content.trim();
  if (!content) throw new Error('Dokumentet inneholder ingen lesbar tekst.');
  if (content.length > MAX_DOCUMENT_CHARS) {
    content = content.slice(0, MAX_DOCUMENT_CHARS);
    warnings.push('Innholdet er avkortet til 200 000 tegn.');
  }
  return { title: title.slice(0, 300), content, filename, kind, warnings };
}
