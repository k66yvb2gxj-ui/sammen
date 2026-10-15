import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchService, fetchSource, isPublicAddress, validatePublicUrl } from '../src/research.mjs';

test('blocks HTTPS credentials, private IPs, localhost and reserved address ranges', async () => {
  for (const url of ['http://example.com', 'file:///notes.txt', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:password@example.com', 'https://example.com:8443', 'https://pc.local']) {
    await assert.rejects(fetchSource(url));
  }
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '198.18.1.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fe80::1', 'fd00::1', '2001:db8::1', '2002:0808:0808::1', '3fff::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.74.14', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(validatePublicUrl('https://www.wikipedia.org/#section').href, 'https://www.wikipedia.org/');
});

test('Wikipedia search uses the Norwegian API, keeps ranking and limits results', async () => {
  let requested;
  const service = createResearchService({ requestText: async url => {
    requested = new URL(url);
    return { body: JSON.stringify({ query: { pages: Array.from({ length: 8 }, (_, index) => ({ pageid: index + 1, index: 8 - index, title: `Tema ${index}`, extract: `Faktisk innledning ${index}` })) } }) };
  } });
  const results = await service.searchSources('celler og læring');
  assert.equal(requested.hostname, 'no.wikipedia.org');
  assert.equal(requested.searchParams.get('gsrsearch'), 'celler og læring');
  assert.equal(requested.searchParams.get('gsrlimit'), '6');
  assert.equal(requested.searchParams.get('explaintext'), '1');
  assert.equal(results.length, 6);
  assert.equal(results[0].title, 'Tema 7');
  assert.equal(results[0].content, 'Faktisk innledning 7');
  assert.match(results[0].url, /^https:\/\/no.wikipedia.org\/wiki\//);
  assert.equal(results[0].metadataOnly, false);
  assert.ok(!Number.isNaN(Date.parse(results[0].retrievedAt)));
});

test('Crossref returns bibliographic records and never fabricates full text', async () => {
  const service = createResearchService({ requestText: async url => {
    const request = new URL(url);
    assert.equal(request.hostname, 'api.crossref.org');
    assert.equal(request.searchParams.get('query.bibliographic'), 'spaced repetition');
    return { body: JSON.stringify({ status: 'ok', message: { items: [{ DOI: '10.1234/study', title: ['Learning &amp; memory'], author: [{ given: 'Ada', family: 'Example' }], issued: { 'date-parts': [[2020, 1]] }, 'container-title': ['Example Journal'], abstract: 'This field must not become fabricated full text.' }] } }) };
  } });
  const [source] = await service.searchSources('spaced repetition', { kind: 'crossref' });
  assert.equal(source.title, 'Learning & memory');
  assert.deepEqual(source.authors, ['Ada Example']);
  assert.equal(source.year, '2020');
  assert.equal(source.metadataOnly, true);
  assert.match(source.content, /fulltekst er ikke hentet/);
  assert.ok(!source.content.includes('This field'));
  assert.equal(source.url, 'https://doi.org/10.1234/study');
});

test('PubMed retrieves abstracts including structured headings and missing abstracts', async () => {
  let calls = 0;
  const xml = '<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">123</PMID><Article><ArticleTitle>Learning <i>and</i> memory</ArticleTitle><Abstract><AbstractText Label="METHODS">Students practised.</AbstractText><AbstractText Label="RESULTS">Recall &amp; confidence improved.</AbstractText></Abstract><AuthorList><Author><LastName>Example</LastName><ForeName>Ada</ForeName></Author></AuthorList><Journal><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle><PubmedArticle><MedlineCitation><PMID>456</PMID><Article><ArticleTitle>Only a citation</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>';
  const service = createResearchService({ requestText: async url => {
    const request = new URL(url);
    assert.equal(request.hostname, 'eutils.ncbi.nlm.nih.gov');
    calls++;
    if (request.pathname.endsWith('/esearch.fcgi')) return { body: JSON.stringify({ esearchresult: { idlist: ['123', '456'] } }) };
    assert.equal(request.searchParams.get('id'), '123,456');
    return { body: xml };
  } });
  const results = await service.searchSources('learning', { kind: 'pubmed' });
  assert.equal(calls, 2);
  assert.equal(results[0].title, 'Learning and memory');
  assert.match(results[0].content, /METHODS: Students practised/);
  assert.match(results[0].content, /RESULTS: Recall & confidence improved/);
  assert.match(results[0].content, /fulltekst er ikke hentet/);
  assert.deepEqual(results[0].authors, ['Ada Example']);
  assert.equal(results[0].year, '2024');
  assert.equal(results[1].metadataOnly, true);
  assert.match(results[1].content, /Ingen abstract/);
});

test('fetchSource returns sanitized text and rejects binary formats', async () => {
  const service = createResearchService({ requestText: async url => ({
    body: '<head><title>Kilde &amp; fakta</title></head><p>Synlig innhold</p><script>secret</script><style>hidden</style>',
    contentType: 'text/html; charset=utf-8', url,
  }) });
  const source = await service.fetchSource('https://www.wikipedia.org/');
  assert.equal(source.title, 'Kilde & fakta');
  assert.equal(source.content, 'Synlig innhold');
  assert.equal(source.url, 'https://www.wikipedia.org/');
  const binaryService = createResearchService({ requestText: async () => ({ body: '%PDF', contentType: 'application/pdf' }) });
  await assert.rejects(binaryService.fetchSource('https://www.wikipedia.org/file.pdf'), /PDF/);
});

test('invalid queries, provider errors and cancellation are surfaced without invented results', async () => {
  const service = createResearchService({ requestText: async () => ({ body: '{broken' }) });
  await assert.rejects(service.searchSources(''), /1 og 500/);
  await assert.rejects(service.searchSources('a'.repeat(501)), /1 og 500/);
  await assert.rejects(service.searchSources('test', { kind: 'made-up' }), /Velg Wikipedia/);
  await assert.rejects(service.searchSources('test'), /ugyldige data/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.searchSources('test', { signal: controller.signal }), { name: 'AbortError' });
});
