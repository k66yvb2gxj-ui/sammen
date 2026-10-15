import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { importDocument, htmlToText, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS } from '../src/imports.mjs';
import { importOneNoteHtml, getCapabilities } from '../src/onenote.mjs';

async function withFile(name, content, run) {
  const directory = await mkdtemp(path.join(import.meta.dirname, '.import-fixture-'));
  try {
    const filename = path.join(directory, name);
    await writeFile(filename, content);
    await run(filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// A minimal real DOCX fixture, with no fixture-generation package required.
function makeDocx() {
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Første avsnitt</w:t></w:r></w:p><w:p><w:r><w:t>Andre avsnitt med æøå.</w:t></w:r></w:p></w:body></w:document>',
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes);
    centrals.push(central, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

test('imports the selected UTF-8 Markdown document with Norwegian text', async () => {
  await withFile('Biologi.md', '# Celler\r\n\r\nÆrlige notater om æ, ø og å.', async filename => {
    const result = await importDocument(filename);
    assert.equal(result.title, 'Biologi');
    assert.equal(result.filename, 'Biologi.md');
    assert.equal(result.kind, 'markdown');
    assert.equal(result.content, '# Celler\n\nÆrlige notater om æ, ø og å.');
    assert.deepEqual(result.warnings, []);
  });
});

test('imports UTF-16 notes rather than mistaking them for binary data', async () => {
  await withFile('Notat.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Kroppens organer: hjerte og hjerne.', 'utf16le')]), async filename => {
    assert.equal((await importDocument(filename)).content, 'Kroppens organer: hjerte og hjerne.');
  });
});

test('HTML is converted to text without active content or resource requests', async () => {
  const html = '<html><head><title>Fysikk &amp; energi</title><style>HIDDEN_STYLE</style></head><body><h1>Energi</h1><script>HIDDEN_SCRIPT</script><p>æ &oslash; &#229; &lt;3</p><iframe src="https://localhost/">HIDDEN_FRAME</iframe><img src="https://localhost/image"><p>Slutt</p></body></html>';
  await withFile('OneNote.html', html, async filename => {
    const result = await importDocument(filename);
    assert.equal(result.title, 'Fysikk & energi');
    assert.equal(result.content, 'Energi\næ ø å <3\nSlutt');
    assert.equal(result.kind, 'html');
    assert.ok(result.warnings.some(value => value.includes('håndskrift')));
  });
  assert.equal(htmlToText('<p>Visible</p><script>unclosed'), 'Visible');
});

test('extracts text from a real DOCX archive and reports omitted layout', async () => {
  await withFile('Historie.docx', makeDocx(), async filename => {
    const result = await importDocument(filename);
    assert.equal(result.kind, 'docx');
    assert.match(result.content, /Første avsnitt\n\nAndre avsnitt med æøå\./);
    assert.ok(result.warnings.some(value => value.includes('Kun tekst')));
  });
});

test('rejects old Word, binary text, malformed DOCX and relative paths clearly', async () => {
  await assert.rejects(importDocument('relative.txt'), /Velg en lokal/);
  await withFile('legacy.doc', 'ignored', filename => assert.rejects(importDocument(filename), /Eksporter.*\.docx/));
  await withFile('binary.txt', Buffer.from([0, 1, 2]), filename => assert.rejects(importDocument(filename), /binærdata/));
  await withFile('broken.docx', 'not a zip', filename => assert.rejects(importDocument(filename), /gyldig DOCX/));
});

test('bounds document bytes and imported text length', async () => {
  await withFile('long.txt', 'a'.repeat(MAX_DOCUMENT_CHARS + 100), async filename => {
    const result = await importDocument(filename);
    assert.equal(result.content.length, MAX_DOCUMENT_CHARS);
    assert.ok(result.warnings.some(value => value.includes('avkortet')));
  });
  await withFile('oversized.txt', '', async filename => {
    const file = await open(filename, 'r+');
    try { await file.truncate(MAX_DOCUMENT_BYTES + 1); } finally { await file.close(); }
    await assert.rejects(importDocument(filename), /20 MB/);
  });
});

test('does not imply a live OneNote integration after importing an HTML export', async () => {
  assert.equal(getCapabilities().localIntegrationImplemented, true);
  assert.equal(getCapabilities().requiresClientRegistration, false);
  await withFile('Skole.html', '<p>Eksporterte notater</p>', async filename => {
    const result = await importOneNoteHtml(filename);
    assert.equal(result.content, 'Eksporterte notater');
    assert.ok(result.warnings.some(value => value.includes('synkroniseres ikke')));
  });
});
