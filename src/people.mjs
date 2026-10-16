export const AVATAR_STYLES = Object.freeze(['cat', 'fox', 'bear', 'rabbit', 'owl', 'frog', 'panda', 'robot']);
export const AVATAR_COLORS = Object.freeze(['lilac', 'peach', 'mint', 'sky', 'rose', 'butter']);
export const DEFAULT_AVATAR = Object.freeze({ style: 'cat', color: 'lilac' });

export function avatarForId(id) {
  if (typeof id !== 'string' || !id) return { ...DEFAULT_AVATAR };
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return { style: AVATAR_STYLES[hash % AVATAR_STYLES.length], color: AVATAR_COLORS[Math.floor(hash / AVATAR_STYLES.length) % AVATAR_COLORS.length] };
}

export function normalizeAvatar(value, fallbackId) {
  if (value === undefined) return avatarForId(fallbackId);
  if (!value || typeof value !== 'object' || !AVATAR_STYLES.includes(value.style) || !AVATAR_COLORS.includes(value.color)) throw new Error('Velg et gyldig profilikon og en pastellfarge.');
  return { style: value.style, color: value.color };
}

export function normalizePerson(value, { fallback } = {}) {
  try {
    const id = value?.userId ?? value?.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 100 || typeof value?.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('Ugyldig brukerprofil.');
    const stableId = id.trim();
    return { id: stableId, name: value.name.trim(), avatar: normalizeAvatar(value.avatar, stableId) };
  } catch (error) {
    if (fallback !== undefined) return normalizePerson(fallback);
    throw error;
  }
}

export function contributionTime(value) {
  const parts = typeof value === 'string' && value.length <= 40 ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.exec(value) : null;
  if (!parts || +parts[1] < 1 || +parts[2] < 1 || +parts[2] > 12 || +parts[3] < 1 || +parts[3] > new Date(Date.UTC(+parts[1], +parts[2], 0)).getUTCDate() || +parts[4] > 23 || +parts[5] > 59 || +parts[6] > 59 || !Number.isFinite(Date.parse(value))) throw new Error('Ugyldig dato i bidragshistorikken.');
  return new Date(value).toISOString();
}

export function validateContributors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error('Ugyldig bidragshistorikk.');
  const people = new Map();
  for (const entry of value) {
    const person = normalizePerson(entry);
    const firstContributedAt = contributionTime(entry.firstContributedAt);
    const lastContributedAt = contributionTime(entry.lastContributedAt);
    if (firstContributedAt > lastContributedAt) throw new Error('Ugyldig rekkefølge i bidragshistorikken.');
    const previous = people.get(person.id);
    const latest = !previous || lastContributedAt >= previous.lastContributedAt ? person : previous;
    people.set(person.id, { id: person.id, name: latest.name, avatar: latest.avatar,
      firstContributedAt: previous && previous.firstContributedAt < firstContributedAt ? previous.firstContributedAt : firstContributedAt,
      lastContributedAt: previous && previous.lastContributedAt > lastContributedAt ? previous.lastContributedAt : lastContributedAt
    });
  }
  return [...people.values()];
}

export function recordContribution(previous, actor, at) {
  const contributors = validateContributors(previous);
  const person = normalizePerson(actor);
  const now = contributionTime(at);
  const existing = contributors.find(entry => entry.id === person.id);
  if (existing) Object.assign(existing, person, { lastContributedAt: now < existing.lastContributedAt ? existing.lastContributedAt : now });
  else {
    if (contributors.length >= 500) throw new Error('Filen har nådd grensen for bidragsytere.');
    contributors.push({ ...person, firstContributedAt: now, lastContributedAt: now });
  }
  return contributors;
}
