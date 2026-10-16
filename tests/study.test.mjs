import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = { window: {} };
runInNewContext(readFileSync(new URL('../src/ui/study.js', import.meta.url), 'utf8'), context);
const { normalizeAnswer, shuffle, availableTypes, questionFor, buildQuestions, isCorrect, answered, advanceLearn } = context.window.SammenStudy.logic;
const cards = [
  { id: 'one', question: 'Hva er fotosyntese?', answer: 'Planter lager sukker med lys.' },
  { id: 'two', question: 'Hva er celleånding?', answer: 'Cellen frigjør energi fra sukker.' },
  { id: 'three', question: 'Hva er klorofyll?', answer: 'Det grønne pigmentet i planter.' },
  { id: 'duplicate', question: 'Hva skjer under fotosyntese?', answer: '  PLANTER lager sukker med lys. ' },
];
const plain = value => JSON.parse(JSON.stringify(value));

test('written answers ignore case and repeated whitespace, without guessing meaning', () => {
  assert.equal(normalizeAnswer('  ØV\n  videre  '), 'øv videre');
  const question = { type: 'written', answer: 'Fotosyntese lager sukker', response: ' FOTOSYNTESE   lager sukker ' };
  assert.equal(isCorrect(question), true);
  question.response = 'Fotosyntese produserer glukose';
  assert.equal(isCorrect(question), false);
  question.accepted = true;
  assert.equal(isCorrect(question), true);
});

test('unanswered written and true/false questions are wrong', () => {
  for (const response of [null, '', '  \n ']) {
    const question = { type: 'written', answer: 'Svar', response };
    assert.equal(answered(question), false);
    assert.equal(isCorrect(question), false);
  }
  assert.equal(isCorrect({ type: 'truefalse', truth: false, response: null }), false);
  assert.equal(isCorrect({ type: 'truefalse', truth: false, response: false }), true);
  assert.equal(isCorrect({ type: 'truefalse', truth: true, response: 'true' }), false);
});

test('multiple choice alternatives are actual distinct answers with exactly one correct option', () => {
  for (const card of cards) {
    const question = questionFor(card, cards, 'choice', false, () => .2);
    const options = plain(question.options);
    assert.equal(new Set(options.map(normalizeAnswer)).size, options.length);
    assert.equal(options.filter(value => normalizeAnswer(value) === normalizeAnswer(card.answer)).length, 1);
    assert.ok(options.every(value => cards.some(source => source.answer === value)));
    for (const value of options) {
      question.response = value;
      assert.equal(isCorrect(question), normalizeAnswer(value) === normalizeAnswer(card.answer));
    }
  }
});

test('one unique answer never produces fabricated distractors', () => {
  const source = [cards[0], cards[3]];
  assert.deepEqual(plain(availableTypes(source)), ['written']);
  assert.equal(questionFor(source[0], source, 'choice').type, 'written');
  assert.equal(questionFor(source[0], source, 'truefalse').type, 'written');
  assert.deepEqual(plain(buildQuestions(source, { types: ['choice', 'truefalse'] })), []);
});

test('true/false statements draw false alternatives from different normalized answers', () => {
  const falseQuestion = questionFor(cards[0], cards, 'truefalse', false, () => .1);
  assert.equal(falseQuestion.truth, false);
  assert.notEqual(normalizeAnswer(falseQuestion.statement), normalizeAnswer(falseQuestion.answer));
  assert.ok(cards.some(card => card.answer === falseQuestion.statement));
  falseQuestion.response = false;
  assert.equal(isCorrect(falseQuestion), true);
  const trueQuestion = questionFor(cards[0], cards, 'truefalse', false, () => .9);
  assert.equal(trueQuestion.truth, true);
  assert.equal(trueQuestion.statement, trueQuestion.answer);
});

test('test generation respects count, selected types, orientation and unique card selection', () => {
  const questions = buildQuestions(cards, { count: 3, types: ['written', 'truefalse'], reverse: true }, () => .3);
  assert.equal(questions.length, 3);
  assert.equal(new Set(questions.map(question => question.cardId)).size, 3);
  assert.deepEqual(plain(questions.map(question => question.type)), ['written', 'truefalse', 'written']);
  for (const question of questions) {
    const card = cards.find(value => value.id === question.cardId);
    assert.equal(question.prompt, card.answer);
    assert.equal(question.answer, card.question);
  }
  assert.equal(buildQuestions(cards, { count: 99 }).length, cards.length);
  assert.equal(buildQuestions([], { count: 2 }).length, 0);
  assert.equal(buildQuestions(cards, { types: [] }).length, 0);
});

test('shuffle does not mutate the shared deck or lose cards', () => {
  const before = cards.map(card => card.id);
  const result = shuffle(cards, () => .2);
  assert.deepEqual(cards.map(card => card.id), before);
  assert.deepEqual(Array.from(result, card => card.id).sort(), [...before].sort());
});

test('Learn retries missed questions, then promotes correct multiple choice to written recall', () => {
  const learn = { cards, questions: [questionFor(cards[0], cards, 'choice', false, () => .2)], index: 0, mastered: [], attempts: 0, feedback: {}, reverse: false };
  assert.equal(advanceLearn(learn, false, () => .2), true);
  assert.equal(learn.index, 1);
  assert.equal(learn.questions[1].cardId, cards[0].id);
  assert.equal(learn.questions[1].type, 'choice');
  assert.equal(learn.mastered.length, 0);
  assert.equal(advanceLearn(learn, true, () => .2), true);
  assert.equal(learn.questions[2].type, 'written');
  assert.equal(learn.mastered.length, 0);
  assert.equal(advanceLearn(learn, true, () => .2), true);
  assert.deepEqual(plain(learn.mastered), [cards[0].id]);
  assert.equal(learn.attempts, 3);
  assert.equal(learn.questions[learn.index], undefined);
  assert.equal(advanceLearn(learn, true), false);
});

test('written mistakes remain in the retry queue until recalled correctly', () => {
  const learn = { cards: [cards[0]], questions: [questionFor(cards[0], [cards[0]], 'written')], index: 0, mastered: [], attempts: 0, feedback: {}, reverse: false };
  advanceLearn(learn, false);
  assert.equal(learn.questions.length, 2);
  assert.equal(learn.questions[1].type, 'written');
  assert.equal(learn.questions[1].response, null);
  advanceLearn(learn, true);
  assert.deepEqual(plain(learn.mastered), [cards[0].id]);
});

// ───── NFKC / sammensatt–dekomponert Unicode ─────

test('NFKC-compatible characters match across composed and decomposed forms in written answers', () => {
  // Å (U+00C5) vs A + combining ring (U+0041 U+030A) — like etter NFKC
  assert.equal(normalizeAnswer('blåbær'), normalizeAnswer('bla\u030A\u0062\u00E6\u0072'));
  // Full-width bokstaver normaliseres til smale (NFKC)
  assert.equal(normalizeAnswer('\uFF2D\uFF45\uFF52'), 'mer');
  // isCorrect skal matche uavhengig av Unicode-form
  const q = { type: 'written', answer: 'Å være eller ikke være', response: 'A\u030A \u0076\u00E6\u0072\u0065 \u0065\u006C\u006C\u0065\u0072 \u0069\u006B\u006B\u0065 \u0076\u00E6\u0072\u0065' };
  assert.equal(isCorrect(q), true);
  // Motsatt retning: dekomponert fasit, sammensatt svar
  const q2 = { type: 'written', answer: 'A\u030A \u0076\u00E6\u0072\u0065', response: 'Å være' };
  assert.equal(isCorrect(q2), true);
});

test('multiple choice deduplicates alternatives after Unicode normalization', () => {
  // Verdiene skiller seg i rå Unicode men er identiske etter NFKC-normalisering
  const unicodeCards = [
    { id: 'aa', question: 'Møre og Romsdals største by?', answer: 'Ålesund' },
    { id: 'bb', question: 'Hvor finner du Atlanterhavsparken?', answer: 'A\u030Alesund' },          // dekomponert Å — rå ulik, NFKC lik
    { id: 'cc', question: 'Norges tredje største by?', answer: '\uFF34\u0072\u006F\u006E\u0064\u0068\u0065\u0069\u006D' }, // full-width T
    { id: 'dd', question: 'Nest største by på Vestlandet?', answer: 'Bergen' },
  ];
  // Rå strenger er forskjellige
  assert.notEqual(unicodeCards[0].answer, unicodeCards[1].answer);
  // Normaliserte er identiske
  assert.equal(normalizeAnswer(unicodeCards[0].answer), normalizeAnswer(unicodeCards[1].answer));
  // cc er full-width T + ASCII, normaliseres til 'trondheim'
  assert.equal(normalizeAnswer(unicodeCards[2].answer), 'trondheim');
  // Flervalg for aa: 3 unike alternativer (Ålesund, Trondheim, Bergen) — bb er duplikat
  const q = questionFor(unicodeCards[0], unicodeCards, 'choice', false, () => .3);
  assert.equal(q.type, 'choice');
  const options = plain(q.options);
  assert.equal(options.length, 3);
  assert.equal(new Set(options.map(normalizeAnswer)).size, options.length);
  // Nøyaktig ett korrekt alternativ (Ålesund, uavhengig av form)
  assert.equal(options.filter(value => normalizeAnswer(value) === normalizeAnswer(unicodeCards[0].answer)).length, 1);
});

test('reversed cards with identical normalized questions only allow written, and questionFor falls back to written for choice/truefalse', () => {
  // Tre kort der to spørsmål er identiske etter NFKC (full-width a → a) og ett er ordrett likt
  const reverseCards = [
    { id: 'r1', question: 'Hva er fotosyntese?', answer: 'Planter lager sukker med lys.' },
    { id: 'r2', question: 'Hva er fotosyntese?', answer: 'Klorofyll fanger sollys.' },
    { id: 'r3', question: 'Hv\uFF41 er fotosyntese?', answer: 'CO₂ + H₂O → sukker + O₂' },
  ];
  // r1 og r3: rå ulike, NFKC identiske
  assert.notEqual(reverseCards[0].question, reverseCards[2].question);
  assert.equal(normalizeAnswer(reverseCards[0].question), normalizeAnswer(reverseCards[2].question));
  // Alle tre spørsmål normaliseres til 'hva er fotosyntese?' — kun 1 unikt svar i reversert modus
  const types = availableTypes(reverseCards, true);
  assert.deepEqual(plain(types), ['written'], 'bare written når spørsmålene er like etter normalisering');

  // questionFor for r1 i reversert choice: ingen distraktorer → fallback til written
  const qChoice = questionFor(reverseCards[0], reverseCards, 'choice', true, () => .5);
  assert.equal(qChoice.type, 'written', 'choice skal falle tilbake til written');
  assert.equal(qChoice.prompt, reverseCards[0].answer);
  assert.equal(qChoice.answer, reverseCards[0].question);

  // questionFor for r1 i reversert truefalse: ingen distraktorer → fallback til written
  const qTF = questionFor(reverseCards[0], reverseCards, 'truefalse', true, () => .5);
  assert.equal(qTF.type, 'written', 'truefalse skal falle tilbake til written');

  // buildQuestions skal respektere dette — kun written-spørsmål genereres
  const questions = buildQuestions(reverseCards, { count: 3, types: ['choice', 'truefalse', 'written'], reverse: true }, () => .2);
  assert.equal(questions.length, 3);
  for (const q of questions) {
    assert.equal(q.type, 'written');
  }
});
