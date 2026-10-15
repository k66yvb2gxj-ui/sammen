import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalOneNoteService } from '../src/onenote.mjs';

const pageId = '{11111111-1111-1111-1111-111111111111}{1}{B0}';
const childId = '{22222222-2222-2222-2222-222222222222}{1}{B0}';
const helperPath = fileURLToPath(new URL('../src/onenote-read.ps1', import.meta.url));

test('passes literal values through an argument array to a hidden STA helper with bounded lifetime', async () => {
  let call;
  const service = createLocalOneNoteService({ scriptPath: helperPath, runHelper: async (...values) => {
    call = values;
    return { stdout: JSON.stringify({ items: [], total: 0, offset: 2, truncated: false }) };
  } });
  const query = '-Mode read; $(unexpected) æøå';
  await service.listPages({ query, offset: 2, limit: 10 });
  const [command, args, options] = call;
  assert.equal(path.basename(command), 'powershell.exe');
  assert.deepEqual(args.slice(0, 8), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Sta', '-File', helperPath, '-Mode']);
  assert.equal(args[8], 'list');
  assert.equal(Buffer.from(args[args.indexOf('-QueryBase64') + 1], 'base64').toString('utf8'), query);
  assert.equal(options.timeout, 25_000);
  assert.equal(options.windowsHide, true);
  assert.equal(options.maxBuffer, 3 * 1024 * 1024);
  assert.ok(!args.includes('-Command'));
  assert.ok(!args.includes('-EncodedCommand'));
});

test('validates selected IDs and metadata and refuses unsafe read results', async () => {
  const service = createLocalOneNoteService({ runHelper: async () => ({ stdout: JSON.stringify({ items: [{ id: pageId, title: 'Test', route: 'Notebook > Test', content: 'Unexpected body' }], total: 1 }) }) });
  await assert.rejects(service.readPage({ pageId: 'abc; Remove-Item' }), /side-ID/);
  await assert.rejects(service.listPages({ query: '\u0000' }), /kontrolltegn/);
  await assert.rejects(service.listPages({ limit: 201 }), /1 og 200/);
  await assert.rejects(service.listPages({ offset: -1 }), /startpunkt/);
  await assert.rejects(service.listPages(), /uventede data/);
  const invalidRead = createLocalOneNoteService({ runHelper: async () => ({ stdout: JSON.stringify({ id: pageId, title: 'Test', route: 'Test', content: 'Test', warnings: [], revision: 'a'.repeat(64), sourceUrl: 'javascript:alert(1)' }) }) });
  await assert.rejects(invalidRead.readPage({ pageId }), /ugyldige data/);
});

test('handles timeout and invalid helper output without terminating the OneNote app', async () => {
  let call;
  const service = createLocalOneNoteService({ runHelper: async (...values) => {
    call = values;
    const error = new Error('timeout');
    error.killed = true;
    throw error;
  } });
  await assert.rejects(service.doctor(), /Bare hjelpeprosessen/);
  assert.equal(path.basename(call[0]), 'powershell.exe');
  const invalid = createLocalOneNoteService({ runHelper: async () => ({ stdout: 'not JSON' }) });
  await assert.rejects(invalid.doctor(), /ugyldige data/);
});

test('bundled PowerShell preserves page routes, tables, OCR and explicit read selection using a fake COM object', async () => {
  const directory = await mkdtemp(path.join(import.meta.dirname, '.onenote-fixture-'));
  const fixturePath = path.join(directory, 'reader-fixture.ps1');
  const escapedHelper = helperPath.replaceAll("'", "''");
  const fixture = `param([string]$Mode,[string]$QueryBase64='',[string]$PageID='',[int]$Offset=0,[int]$Limit=60)
$global:SammenFixtureHierarchy = '<one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote"><one:Notebook ID="notebook" name="Felles bok"><one:Section ID="section" name="Biologi"><one:Page ID="${pageId}" name="Celler" pageLevel="1" lastModifiedTime="2026-10-01T08:00:00Z"/><one:Page ID="${childId}" name="Organeller" pageLevel="2" lastModifiedTime="2026-10-02T08:00:00Z"/></one:Section><one:Section ID="deleted" name="Papirkurv" isRecycleBin="true"><one:Page ID="deleted-page" name="Slettet"/></one:Section></one:Notebook></one:Notebooks>'
$global:SammenFixtureFake = [pscustomobject]@{}
$global:SammenFixtureFake | Add-Member -MemberType ScriptMethod -Name GetHierarchy -Value { param($id,$scope,$output,$schema) $output.Value=$global:SammenFixtureHierarchy }
$global:SammenFixtureFake | Add-Member -MemberType ScriptMethod -Name GetPageContent -Value { param($id,$output,$info,$schema)
  if ($id -ne '${childId}') { throw 'The fixture permits only the explicitly selected child page.' }
  $output.Value='<one:Page xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote"><one:Outline><one:OEChildren><one:OE><one:T><![CDATA[<b>En celle</b> med organeller.]]></one:T></one:OE><one:OE><one:Table><one:Row><one:Cell index="0"><one:OEChildren><one:OE><one:T><![CDATA[Kjerne]]></one:T></one:OE></one:OEChildren></one:Cell><one:Cell index="1"><one:OEChildren><one:OE><one:T><![CDATA[DNA]]></one:T></one:OE></one:OEChildren></one:Cell></one:Row></one:Table></one:OE><one:OE><one:Image><one:OCRData><one:OCRText>Bilde av en celle</one:OCRText></one:OCRData></one:Image></one:OE><one:OE><one:InkDrawing/></one:OE><one:OE><one:InsertedFile preferredName="Vedlegg.docx"/></one:OE></one:OEChildren></one:Outline></one:Page>'
}
$global:SammenFixtureFake | Add-Member -MemberType ScriptMethod -Name GetHyperlinkToObject -Value { param($id,$object,$output) $output.Value='onenote:#Organeller&page-id=fixture' }
$global:SammenFixtureFake | Add-Member -MemberType ScriptMethod -Name NavigateTo -Value { param($id,$object,$newWindow) if($id -ne '${childId}') { throw 'Unexpected navigation selection' } }
function New-Object {
  param([Parameter(Position=0)][string]$TypeName,[Parameter(Position=1)][object[]]$ArgumentList,[string]$ComObject)
  if ($ComObject) { if ($ComObject -ne 'OneNote.Application') { throw 'Unexpected COM class' }; return $global:SammenFixtureFake }
  Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
}
& '${escapedHelper}' -Mode $Mode -QueryBase64 $QueryBase64 -PageID $PageID -Offset $Offset -Limit $Limit
`;
  try {
    await writeFile(fixturePath, '\uFEFF' + fixture);
    const service = createLocalOneNoteService({ scriptPath: fixturePath });
    const pages = await service.listPages({ query: 'Biologi', limit: 1 });
    assert.equal(pages.total, 2);
    assert.equal(pages.items.length, 1);
    assert.equal(pages.truncated, true);
    assert.ok(!Object.hasOwn(pages.items[0], 'content'));
    const next = await service.listPages({ offset: 1, limit: 1 });
    assert.equal(next.items[0].route, 'Felles bok > Biologi > Celler > Organeller');
    const page = await service.readPage({ pageId: childId });
    assert.match(page.content, /En celle med organeller/);
    assert.match(page.content, /Kjerne\tDNA/);
    assert.match(page.content, /OCR fra bilde.*Bilde av en celle/);
    assert.equal(page.sourceUrl, 'onenote:#Organeller&page-id=fixture');
    assert.match(page.revision, /^[a-f\d]{64}$/);
    assert.ok(page.warnings.some(value => value.includes('Håndskrift')));
    assert.ok(page.warnings.some(value => value.includes('Vedlegg')));
    assert.equal((await service.openPage({ pageId: childId })).opened, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
