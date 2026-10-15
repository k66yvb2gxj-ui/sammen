import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import tls from 'node:tls';
import { XMLParser } from 'fast-xml-parser';
import { htmlToText } from './imports.mjs';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULTS = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'SammenStudy/0.1 (desktop research client)';
// Match Windows trust for managed school networks while retaining certificate validation.
const trustedCertificates = typeof tls.getCACertificates === 'function'
  ? [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]
  : undefined;
const API_DOCS = Object.freeze({
  wikipedia: 'https://www.mediawiki.org/wiki/API:Search',
  crossref: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',
  pubmed: 'https://www.ncbi.nlm.nih.gov/books/NBK25499/',
});

function ipv4Number(address) {
  return address.split('.').reduce((result, part) => result * 256 + Number(part), 0);
}

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([start, prefix]) => {
      const size = 2 ** (32 - prefix);
      return Math.floor(value / size) === Math.floor(ipv4Number(start) / size);
    });
  }
  if (version === 6) {
    // Only native global-unicast IPv6; reject mapped IPv4, transition and special ranges.
    const head = address.toLowerCase().split(':');
    const first = Number.parseInt(head[0], 16);
    const second = Number.parseInt(head[1] || '0', 16);
    if (!Number.isFinite(first) || !Number.isFinite(second) || first < 0x2000 || first > 0x3fff) return false;
    if (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) return false;
    if (first === 0x2002 || first === 0x3fff && second <= 0xfff) return false;
    return !address.includes('%');
  }
  return false;
}

export function validatePublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Skriv inn en gyldig HTTPS-adresse.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') {
    throw new Error('Kun offentlige HTTPS-adresser uten innlogging på port 443 støttes.');
  }
  if (isIP(host) || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|lan|home|test|example|invalid|onion)$/.test(host)) {
    throw new Error('Lokale adresser, IP-adresser og interne tjenester kan ikke hentes.');
  }
  url.hash = '';
  return url;
}

function abortError() {
  const error = new Error('Hentingen ble avbrutt eller brukte mer enn 20 sekunder.');
  error.name = 'AbortError';
  return error;
}

async function resolvePublicHost(host, signal) {
  if (signal.aborted) throw abortError();
  const records = await new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    lookup(host, { all: true, verbatim: true }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
  if (signal.aborted) throw abortError();
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error('Adressen peker til et privat eller reservert nettverk og er blokkert.');
  }
  return records.find(record => record.family === 4) ?? records[0];
}

async function requestOnce(url, signal) {
  const address = await resolvePublicHost(url.hostname, signal);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET', agent: false, signal, ca: trustedCertificates,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, application/xml, text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity' },
      // Pin the validated DNS result while retaining hostname-based TLS verification.
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location) reject(new Error('Nettstedet sendte en ugyldig videresending.'));
        else resolve({ redirect: location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new Error(status === 429 ? 'Kildetjenesten har nådd forespørselsgrensen. Prøv igjen senere.' : `Kildetjenesten svarte med HTTP ${status}.`));
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy();
        reject(new Error('Komprimert respons støttes ikke av denne sikre teksthentingen.'));
        return;
      }
      if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error('Kilden er større enn grensen på 1 MB.'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Kilden er større enn grensen på 1 MB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        url: url.href,
        contentType: String(response.headers['content-type'] ?? '').toLowerCase(),
      }));
    });
    req.on('error', error => reject(signal.aborted ? abortError() : error));
    req.end();
  });
}

export async function requestPublicText(input, { signal } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    let url = validatePublicUrl(input);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const result = await requestOnce(url, controller.signal);
      if (!result.redirect) return result;
      if (redirects === 3) throw new Error('Kilden videresender for mange ganger.');
      url = validatePublicUrl(new URL(result.redirect, url));
    }
    throw new Error('Kilden kunne ikke hentes.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const clean = value => htmlToText(typeof value === 'object' && value !== null ? value['#text'] ?? '' : value).slice(0, 6000);

function readJson(body) {
  try { return JSON.parse(body); } catch { throw new Error('Kildetjenesten returnerte ugyldige data.'); }
}

let nextPubmedSlot = 0;
async function waitPubmedTurn(signal) {
  const now = Date.now();
  const scheduled = Math.max(now, nextPubmedSlot);
  nextPubmedSlot = scheduled + 350;
  if (signal?.aborted) throw abortError();
  if (scheduled === now) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, scheduled - now);
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// Dependency injection permits deterministic provider tests without real requests.
export function createResearchService({ requestText = requestPublicText } = {}) {
  async function searchSources(query, { kind = 'wikipedia', signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) {
      throw new Error('Skriv et søk på mellom 1 og 500 tegn.');
    }
    if (!Object.hasOwn(API_DOCS, kind)) throw new Error('Velg Wikipedia, Crossref eller PubMed.');
    if (signal?.aborted) throw abortError();
    const retrievedAt = new Date().toISOString();
    const term = query.trim();
    if (kind === 'wikipedia') {
      const url = new URL('https://no.wikipedia.org/w/api.php');
      url.search = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', generator: 'search',
        gsrsearch: term, gsrlimit: String(MAX_RESULTS), gsrnamespace: '0',
        prop: 'extracts', exintro: '1', explaintext: '1', exlimit: String(MAX_RESULTS),
      }).toString();
      const data = readJson((await requestText(url.href, { signal })).body);
      if (data.error) throw new Error(`Wikipedia-søket feilet: ${clean(data.error.info)}`);
      return asArray(data.query?.pages).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .filter(page => page.pageid && page.title && page.extract).slice(0, MAX_RESULTS).map(page => ({
          id: `wikipedia:${page.pageid}`, title: String(page.title).slice(0, 300),
          content: String(page.extract).slice(0, 6000),
          url: `https://no.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`,
          provider: 'Wikipedia (bokmål)', retrievedAt, metadataOnly: false,
        }));
    }
    if (kind === 'crossref') {
      const url = new URL('https://api.crossref.org/works');
      url.search = new URLSearchParams({ 'query.bibliographic': term, rows: String(MAX_RESULTS), select: 'DOI,title,author,issued,container-title,type' }).toString();
      const data = readJson((await requestText(url.href, { signal })).body);
      if (data.status !== 'ok') throw new Error('Crossref-søket kunne ikke gjennomføres.');
      return asArray(data.message?.items).filter(work => work.DOI && work.title?.[0]).slice(0, MAX_RESULTS).map(work => {
        const title = clean(work.title[0]).slice(0, 300);
        const authors = asArray(work.author).map(author => clean([author.given, author.family].filter(Boolean).join(' ') || author.name)).filter(Boolean).slice(0, 30);
        const year = work.issued?.['date-parts']?.[0]?.[0];
        const venue = clean(work['container-title']?.[0]);
        return {
          id: `crossref:${work.DOI}`, title, authors, ...(year ? { year: String(year) } : {}),
          content: ['Bibliografiske metadata fra Crossref. Artikkelens fulltekst er ikke hentet.', `Tittel: ${title}`,
            authors.length ? `Forfattere: ${authors.join(', ')}` : '', year ? `År: ${year}` : '',
            venue ? `Publikasjon: ${venue}` : '', `DOI: ${work.DOI}`].filter(Boolean).join('\n'),
          url: `https://doi.org/${String(work.DOI).split('/').map(encodeURIComponent).join('/')}`,
          provider: 'Crossref', retrievedAt, metadataOnly: true,
        };
      });
    }
    const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    searchUrl.search = new URLSearchParams({ db: 'pubmed', term, retmode: 'json', retmax: String(MAX_RESULTS), sort: 'relevance', tool: 'SammenStudy' }).toString();
    await waitPubmedTurn(signal);
    const search = readJson((await requestText(searchUrl.href, { signal })).body);
    if (search.error || search.esearchresult?.ERROR) throw new Error('PubMed-søket kunne ikke gjennomføres.');
    const ids = asArray(search.esearchresult?.idlist).filter(id => /^\d+$/.test(id)).slice(0, MAX_RESULTS);
    if (!ids.length) return [];
    const fetchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
    fetchUrl.search = new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'xml', tool: 'SammenStudy' }).toString();
    await waitPubmedTurn(signal);
    const xml = (await requestText(fetchUrl.href, { signal })).body;
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, processEntities: false, stopNodes: ['*.ArticleTitle', '*.AbstractText'] });
    let data;
    try { data = parser.parse(xml); } catch { throw new Error('PubMed returnerte ugyldig XML.'); }
    if (data.ERROR || data.eFetchResult?.ERROR) throw new Error('PubMed kunne ikke hente sammendragene.');
    return asArray(data.PubmedArticleSet?.PubmedArticle).slice(0, MAX_RESULTS).flatMap(record => {
      const citation = record.MedlineCitation;
      const article = citation?.Article;
      const id = clean(citation?.PMID);
      const title = clean(article?.ArticleTitle).slice(0, 300);
      if (!/^\d+$/.test(id) || !title) return [];
      const abstract = asArray(article.Abstract?.AbstractText).map(section => {
        const text = clean(section);
        const label = typeof section === 'object' ? clean(section['@Label']) : '';
        return label ? `${label}: ${text}` : text;
      }).filter(Boolean).join('\n\n').slice(0, 12_000);
      const authors = asArray(article.AuthorList?.Author).map(author => clean(author.CollectiveName || [author.ForeName || author.Initials, author.LastName].filter(Boolean).join(' '))).filter(Boolean).slice(0, 30);
      const year = clean(article.Journal?.JournalIssue?.PubDate?.Year) || clean(article.Journal?.JournalIssue?.PubDate?.MedlineDate).match(/\b\d{4}\b/)?.[0];
      return [{ id: `pubmed:${id}`, title, authors, ...(year ? { year } : {}),
        content: abstract ? `Sammendrag fra PubMed (abstract; fulltekst er ikke hentet):\n\n${abstract}` : `Kun bibliografiske metadata fra PubMed. Ingen abstract er tilgjengelig.\nTittel: ${title}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, provider: 'PubMed', retrievedAt, metadataOnly: !abstract,
      }];
    });
  }

  async function fetchSource(input, { signal } = {}) {
    validatePublicUrl(input);
    const response = await requestText(input, { signal });
    const type = response.contentType ?? '';
    if (!/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/.test(type)) {
      throw new Error('Denne kilden er ikke en tekst- eller HTML-side. PDF og andre binærfiler støttes ikke her.');
    }
    const isHtml = !type.startsWith('text/plain');
    const content = (isHtml ? htmlToText(response.body) : response.body.trim()).slice(0, 50_000);
    if (!content) throw new Error('Kilden inneholder ingen lesbar tekst.');
    const titleHtml = isHtml ? response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] : null;
    const sourceUrl = response.url || String(input);
    return {
      id: `web:${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`,
      title: titleHtml ? htmlToText(titleHtml).slice(0, 300) : new URL(sourceUrl).hostname,
      content, url: sourceUrl, provider: 'Nettside', retrievedAt: new Date().toISOString(), metadataOnly: false,
    };
  }
  return { searchSources, fetchSource };
}

const defaultService = createResearchService();
export const searchSources = defaultService.searchSources;
export const fetchSource = defaultService.fetchSource;
export const researchApiDocumentation = API_DOCS;
