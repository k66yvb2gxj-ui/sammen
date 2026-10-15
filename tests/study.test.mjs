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
