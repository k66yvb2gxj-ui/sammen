'use strict';

(() => {
  const typeLabels = { choice: 'Flervalg', written: 'Skriv', truefalse: 'Sant eller usant' };

  function normalizeAnswer(value) {
    return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('nb-NO').replace(/\s+/g, ' ');
  }
  function shuffle(values, random = Math.random) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function sides(card, reverse = false) {
    return { prompt: reverse ? card.answer : card.question, answer: reverse ? card.question : card.answer };
  }
  function alternatives(card, cards, reverse) {
    const answer = normalizeAnswer(sides(card, reverse).answer);
    const seen = new Set([answer]);
    return cards.flatMap(other => {
      const value = sides(other, reverse).answer;
      const normalized = normalizeAnswer(value);
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [value];
    });
  }
  function availableTypes(cards, reverse = false) {
    const answers = new Set(cards.map(card => normalizeAnswer(sides(card, reverse).answer)).filter(Boolean));
    return answers.size > 1 ? ['choice', 'written', 'truefalse'] : ['written'];
  }
  function questionFor(card, cards, type, reverse = false, random = Math.random) {
    const { prompt, answer } = sides(card, reverse);
    const wrong = shuffle(alternatives(card, cards, reverse), random);
    if ((type === 'choice' || type === 'truefalse') && !wrong.length) type = 'written';
    const question = { cardId: card.id, prompt, answer, type, origin: card.origin, response: null, accepted: false };
    if (type === 'choice') question.options = shuffle([answer, ...wrong.slice(0, 3)], random);
    if (type === 'truefalse') {
      question.truth = random() >= .5;
      question.statement = question.truth ? answer : wrong[0];
    }
    return question;
  }
  function buildQuestions(cards, options = {}, random = Math.random) {
    const allowed = availableTypes(cards, Boolean(options.reverse));
    const types = (options.types || allowed).filter(type => allowed.includes(type));
    if (!cards.length || !types.length) return [];
    const count = Math.min(cards.length, Math.max(1, Math.floor(Number(options.count) || cards.length)));
    return shuffle(cards, random).slice(0, count).map((card, index) => questionFor(card, cards, types[index % types.length], Boolean(options.reverse), random));
  }
  function isCorrect(question) {
    if (question.accepted) return true;
    if (question.type === 'truefalse') return typeof question.response === 'boolean' && question.response === question.truth;
    return normalizeAnswer(question.response) !== '' && normalizeAnswer(question.response) === normalizeAnswer(question.answer);
  }
  function answered(question) { return question.type === 'truefalse' ? typeof question.response === 'boolean' : normalizeAnswer(question.response) !== ''; }
  function advanceLearn(learn, correct, random = Math.random) {
    const question = learn.questions[learn.index];
    const card = learn.cards.find(value => value.id === question?.cardId);
    if (!question || !card) return false;
    learn.attempts++;
    if (!correct) learn.questions.push(questionFor(card, learn.cards, question.type, learn.reverse, random));
    else if (question.type === 'choice') learn.questions.push(questionFor(card, learn.cards, 'written', learn.reverse, random));
    else if (!learn.mastered.includes(question.cardId)) learn.mastered.push(question.cardId);
    learn.index++;
    learn.feedback = null;
    return true;
  }

  function session() {
    const key = ui.projectId || '*';
    if (!ui.study || ui.study.projectId !== key) {
      ui.study = { projectId: key, mode: 'cards', filter: 'all', selected: null, flipped: false, reverse: false, order: [], marked: {}, busy: false, listOpen: false, quiz: null, quizCount: 10, quizTypes: ['choice', 'written', 'truefalse'], learn: null, learnType: 'mixed', learnOnlyLearning: false, lastGlobalCardId: null };
    }
    return ui.study;
  }
  function redraw(focusId) {
    renderMain();
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  function isKnown(card, s) { return (s.marked[card.id] || (card.reviewCount > 0 && card.interval >= 4 ? 'known' : 'learning')) === 'known'; }
  function orderedCards(cards, s) {
    const ids = new Set(cards.map(card => card.id));
    s.order = [...s.order.filter(id => ids.has(id)), ...cards.filter(card => !s.order.includes(card.id)).map(card => card.id)];
    const byId = new Map(cards.map(card => [card.id, card]));
    return s.order.map(id => byId.get(id));
  }
  function queueFor(cards, s) {
    return orderedCards(cards, s).filter(card => s.filter === 'all' || (s.filter === 'known' ? isKnown(card, s) : !isKnown(card, s)));
  }
  function selectCard(card, s) {
    s.selected = card?.id || null;
    s.flipped = false;
    ui.cardId = s.selected;
    s.lastGlobalCardId = s.selected;
  }
  function moveCard(delta, cards, s) {
    const queue = queueFor(cards, s);
    const index = queue.findIndex(card => card.id === s.selected);
    const target = queue[index + delta];
    if (!target || s.busy) return;
    selectCard(target, s);
    redraw('ss-flip-card');
  }
  async function persistReview(cardId, rating) {
    if (!state.flashcards.some(card => card.id === cardId)) return null;
    return invoke('reviewCard', { id: cardId, rating });
  }
  async function markCard(card, mark, cards, s) {
    if (s.busy) return;
    const previousQueue = queueFor(cards, s);
    const index = previousQueue.findIndex(value => value.id === card.id);
    s.busy = true;
    redraw();
    try {
      const result = await persistReview(card.id, mark === 'known' ? 'easy' : 'again');
      s.marked[card.id] = mark;
      const nextQueue = queueFor(cards, s);
      const next = nextQueue.find(value => value.id === previousQueue[index + 1]?.id) || nextQueue.find(value => value.id !== card.id) || nextQueue[0];
      selectCard(next, s);
      s.busy = false;
      if (result) applyState(result);
      redraw('ss-flip-card');
    } catch (error) { s.busy = false; showError(error); redraw(); }
  }
  function chip(text, className = '') { return el('span', { class: `ss-chip ${className}` }, text); }
  function progress(value, total, label) {
    return el('div', { class: 'ss-progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': total || 1, 'aria-valuenow': value }, el('span', { style: `width:${total ? Math.round(value / total * 100) : 0}%` }));
  }
  function orientation(s, id) {
    return btn('Bytt side', () => { s.reverse = !s.reverse; s.flipped = false; redraw(id); }, 'button-secondary button-small', 'refresh', { id, 'aria-pressed': s.reverse, title: s.reverse ? 'Svar vises først' : 'Spørsmål vises først' });
  }
  function emptyDeck(title, action = () => cardModal(), label = 'Nytt kort') {
    return el('section', { class: 'ss-empty' }, icon('cards', 36), el('h2', {}, title), btn(label, action, '', 'add'));
  }

  function renderCards(cards, s) {
    const known = cards.filter(card => isKnown(card, s)).length;
    const filters = [['all', 'Alle', cards.length], ['learning', 'Øver', cards.length - known], ['known', 'Kan', known]];
    const toolbar = el('div', { class: 'ss-card-toolbar' }, el('div', { class: 'ss-filters', 'aria-label': 'Velg kort' }, filters.map(([value, label, count]) => el('button', { type: 'button', id: `ss-filter-${value}`, class: s.filter === value ? 'active' : '', 'aria-pressed': s.filter === value, onclick: () => { s.filter = value; selectCard(null, s); redraw(`ss-filter-${value}`); } }, label, el('span', {}, count)))), el('div', { class: 'ss-actions' }, btn('Bland', () => { s.order = shuffle(cards).map(card => card.id); selectCard(null, s); redraw('ss-shuffle'); }, 'button-secondary button-small', 'refresh', { id: 'ss-shuffle', disabled: s.busy }), orientation(s, 'ss-reverse-cards')));
    const wrapper = el('section', { class: 'ss-cards' }, toolbar);
    const queue = queueFor(cards, s);
    if (!queue.some(card => card.id === s.selected)) selectCard(queue[0], s);
    const card = queue.find(value => value.id === s.selected);
    if (!card) {
      wrapper.append(emptyDeck(s.filter === 'known' ? 'Ingen kort her ennå' : 'Ferdig for nå', () => { s.filter = 'all'; redraw(); }, 'Vis alle'));
      return wrapper;
    }
    const index = queue.indexOf(card);
    const pair = sides(card, s.reverse);
    const side = s.flipped ? pair.answer : pair.prompt;
    const sideLabel = s.flipped !== s.reverse ? 'Svar' : 'Spørsmål';
    const face = el('button', { type: 'button', id: 'ss-flip-card', class: `ss-flip-card${s.flipped ? ' back' : ''}`, 'aria-label': `${sideLabel}: ${side}. Trykk for å snu kortet.`, onclick: () => { s.flipped = !s.flipped; redraw('ss-flip-card'); }, disabled: s.busy }, el('span', { class: 'ss-card-side' }, sideLabel), el('span', { class: 'ss-card-text' }, side), el('span', { class: 'ss-flip-hint' }, icon('refresh', 14), 'Snu kortet'));
    const study = el('div', { class: 'ss-card-stage', onkeydown: event => {
      if (event.target.matches('input, textarea, select') || s.busy) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); moveCard(event.key === 'ArrowLeft' ? -1 : 1, cards, s); }
    } }, face, el('div', { class: 'ss-card-navigation' }, btn('', () => moveCard(-1, cards, s), 'button-secondary ss-circle ss-previous', 'arrow', { 'aria-label': 'Forrige kort', disabled: s.busy || index === 0 }), el('span', { class: 'ss-card-counter', 'aria-live': 'polite' }, `${index + 1} / ${queue.length}`), btn('', () => moveCard(1, cards, s), 'button-secondary ss-circle', 'arrow', { 'aria-label': 'Neste kort', disabled: s.busy || index === queue.length - 1 })), el('div', { class: 'ss-sort-actions' }, btn('Øver fortsatt', () => markCard(card, 'learning', cards, s), 'button-secondary ss-learning', 'refresh', { disabled: s.busy }), btn('Kan dette', () => markCard(card, 'known', cards, s), 'button-secondary ss-known', 'check', { disabled: s.busy })), el('div', { class: 'ss-card-bottom' }, el('span', { class: 'ss-meta' }, card.origin === 'ai' ? 'Laget av KI' : projectTitle(card.projectId)), btn('Rediger', () => cardModal(null, card), 'button-text button-small', null, { disabled: s.busy })));
    wrapper.append(study);
    return wrapper;
  }

  function renderQuestion(question, index, options = {}) {
    const prefix = options.prefix || 'ss-q';
    const root = el('fieldset', { class: `ss-question ${question.type}${options.result ? (isCorrect(question) ? ' correct' : ' incorrect') : ''}`, id: `${prefix}-${index}` }, el('legend', {}, el('span', { class: 'ss-question-number' }, index + 1), el('span', { class: 'ss-question-prompt' }, question.prompt)), el('div', { class: 'ss-question-type' }, typeLabels[question.type]));
    const onResponse = response => { question.response = response; if (options.onAnswer) options.onAnswer(response); };
    if (question.type === 'written') {
      const input = el('textarea', { id: `${prefix}-answer-${index}`, rows: 2, maxlength: 12000, 'aria-label': `Svar på ${question.prompt}`, placeholder: 'Skriv svaret …', value: question.response || '', disabled: options.locked, oninput: event => onResponse(event.target.value), onkeydown: event => {
        if (options.onSubmit && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); options.onSubmit(); }
      } });
      root.append(input);
    } else {
      const values = question.type === 'truefalse' ? [true, false] : question.options;
      if (question.type === 'truefalse') root.append(el('p', { class: 'ss-statement' }, question.statement));
      const list = el('div', { class: `ss-choices${question.type === 'truefalse' ? ' binary' : ''}`, role: 'radiogroup', 'aria-label': 'Svaralternativer' });
      values.forEach((value, choiceIndex) => {
        const selected = question.response === value;
        const label = typeof value === 'boolean' ? value ? 'Sant' : 'Usant' : value;
        const input = el('input', { type: 'radio', name: `${prefix}-${index}`, value: String(choiceIndex), checked: selected, disabled: options.locked, onchange: () => onResponse(value) });
        list.append(el('label', { class: `ss-choice${selected ? ' selected' : ''}` }, input, el('span', { class: 'ss-choice-key', 'aria-hidden': 'true' }, question.type === 'truefalse' ? '' : String.fromCharCode(65 + choiceIndex)), el('span', {}, label)));
      });
      root.append(list);
    }
    if (options.result) {
      const correct = isCorrect(question);
      const responseText = question.type === 'truefalse' ? (question.response === true ? 'Sant' : question.response === false ? 'Usant' : 'Ubesvart') : question.response || 'Ubesvart';
      root.append(el('div', { class: 'ss-result-feedback' }, icon(correct ? 'check' : 'close', 15), el('strong', {}, correct ? question.accepted ? 'Godtatt av deg' : 'Riktig' : 'Prøv igjen')));
      if (!correct) {
        root.append(el('div', { class: 'ss-answer-review' }, el('span', {}, 'Ditt svar'), el('p', {}, responseText), el('span', {}, 'Fasit'), el('p', {}, question.type === 'truefalse' ? question.truth ? 'Sant' : 'Usant' : question.answer)));
        if (question.type === 'written' && answered(question)) root.append(btn('Godta mitt svar', () => { question.accepted = true; redraw(`${prefix}-${index}`); }, 'button-text button-small'));
      }
    }
    return root;
  }

  function startQuiz(cards, s, missedOnly = null) {
    const source = missedOnly || cards;
    const types = s.quizTypes.filter(type => availableTypes(source, s.reverse).includes(type));
    const questions = buildQuestions(source, { count: missedOnly ? source.length : s.quizCount, types: types.length ? types : ['written'], reverse: s.reverse });
    s.quiz = { questions, submitted: false, reverse: s.reverse };
    redraw('ss-quiz-heading');
  }
  function renderQuiz(cards, s) {
    const panel = el('section', { class: 'ss-quiz' });
    if (!s.quiz) {
      const available = availableTypes(cards, s.reverse);
      const count = Math.min(cards.length, Math.max(1, Number(s.quizCount) || 10));
      const amount = el('input', { type: 'number', id: 'ss-quiz-count', min: 1, max: cards.length, value: count, oninput: event => { s.quizCount = event.target.value; } });
      const types = el('fieldset', { class: 'ss-type-options' }, el('legend', {}, 'Spørsmålstyper'));
      Object.entries(typeLabels).forEach(([value, label]) => {
        const valid = available.includes(value);
        types.append(el('label', { class: `ss-type-option${valid ? '' : ' unavailable'}` }, el('input', { type: 'checkbox', value, checked: valid && s.quizTypes.includes(value), disabled: !valid, onchange: event => { s.quizTypes = event.target.checked ? [...new Set([...s.quizTypes, value])] : s.quizTypes.filter(type => type !== value); redraw(`ss-type-${value}`); }, id: `ss-type-${value}` }), icon(value === 'choice' ? 'cards' : value === 'written' ? 'file' : 'check', 20), el('span', {}, label)));
      });
      const startDisabled = !s.quizTypes.some(type => available.includes(type));
      panel.append(el('div', { class: 'ss-config' }, el('div', { class: 'ss-config-icon' }, icon('book', 31)), el('h2', { id: 'ss-quiz-heading', tabindex: -1 }, 'Lag en quiz'), el('div', { class: 'ss-config-row' }, el('label', { for: 'ss-quiz-count' }, 'Antall spørsmål'), amount), types, available.length === 1 ? el('p', { class: 'ss-small-note' }, 'Flervalg og sant/usant krever minst 2 ulike svar.') : null, el('div', { class: 'ss-config-row' }, el('span', {}, s.reverse ? 'Svar → spørsmål' : 'Spørsmål → svar'), orientation(s, 'ss-reverse-quiz')), el('p', { class: 'ss-small-note' }, 'Skriftlige svar sjekkes uten store bokstaver og ekstra mellomrom.'), btn('Start quiz', () => startQuiz(cards, s), '', 'arrow', { disabled: startDisabled, id: 'ss-start-quiz' })));
      return panel;
    }
    const quiz = s.quiz;
    const total = quiz.questions.length;
    const correct = quiz.questions.filter(isCorrect).length;
    const done = quiz.questions.filter(answered).length;
    if (quiz.submitted) {
      const percentage = total ? Math.round(correct / total * 100) : 0;
      const missed = quiz.questions.filter(question => !isCorrect(question));
      panel.append(el('div', { class: 'ss-score', id: 'ss-quiz-heading', tabindex: -1 }, el('div', { class: 'ss-score-bubble' }, `${percentage}%`), el('div', {}, el('h2', {}, percentage === 100 ? 'Alle riktige!' : 'Quizen er ferdig'), el('p', {}, `${correct} av ${total} riktige`)), el('div', { class: 'ss-actions' }, missed.length ? btn('Øv på feilene', () => {
        const ids = new Set(missed.map(question => question.cardId));
        const missedCards = cards.filter(card => ids.has(card.id));
        s.mode = 'learn'; startLearn(missedCards, s, true);
      }, 'button-secondary', 'refresh') : null, btn('Ny quiz', () => { s.quiz = null; redraw('ss-quiz-heading'); }, '', 'arrow'))));
    } else {
      panel.append(el('div', { class: 'ss-quiz-status' }, el('h2', { id: 'ss-quiz-heading', tabindex: -1 }, 'Quiz'), el('span', { id: 'ss-quiz-answered', 'aria-live': 'polite' }, `${done} / ${total}`), btn('Begynn på nytt', () => { s.quiz = null; redraw('ss-quiz-heading'); }, 'button-text button-small')));
    }
    quiz.questions.forEach((question, index) => panel.append(renderQuestion(question, index, { prefix: 'ss-test', locked: quiz.submitted, result: quiz.submitted, onAnswer: () => {
      const counter = document.getElementById('ss-quiz-answered');
      if (counter) counter.textContent = `${quiz.questions.filter(answered).length} / ${total}`;
      const label = question.type !== 'written' ? document.querySelector(`#ss-test-${index} .ss-choices`) : null;
      if (label) label.querySelectorAll('.ss-choice').forEach(choice => choice.classList.toggle('selected', choice.querySelector('input').checked));
    } })));
    if (!quiz.submitted) panel.append(el('div', { class: 'ss-quiz-submit' }, btn('Lever quiz', () => { quiz.submitted = true; redraw('ss-quiz-heading'); }, '', 'check')));
    return panel;
  }

  function startLearn(cards, s, fromMissed = false) {
    const source = fromMissed ? cards : cards.filter(card => !s.learnOnlyLearning || !isKnown(card, s));
    const firstType = s.learnType === 'written' || availableTypes(source, s.reverse).length === 1 ? 'written' : 'choice';
    s.learn = { cards: source.map(card => ({ ...card })), questions: shuffle(source).map(card => questionFor(card, source, firstType, s.reverse)), index: 0, mastered: [], attempts: 0, feedback: null, reverse: s.reverse, busy: false };
    redraw('ss-learn-heading');
  }
  function answerLearn(s, response, unknown = false) {
    const learn = s.learn;
    if (learn.busy || learn.feedback) return;
    const question = learn.questions[learn.index];
    if (!question) return;
    if (response !== undefined) question.response = response;
    if (!unknown && !answered(question)) { document.getElementById(`ss-learn-answer-${learn.index}`)?.focus(); return; }
    learn.feedback = { correct: !unknown && isCorrect(question) };
    redraw('ss-learn-next');
  }
  async function nextLearn(s) {
    const learn = s.learn;
    if (learn.busy || !learn.feedback) return;
    const question = learn.questions[learn.index];
    const correct = learn.feedback.correct;
    learn.busy = true;
    redraw();
    try {
      const result = await persistReview(question.cardId, correct ? question.type === 'choice' ? 'good' : 'easy' : 'again');
      if (!correct) s.marked[question.cardId] = 'learning';
      else if (question.type !== 'choice') s.marked[question.cardId] = 'known';
      advanceLearn(learn, correct);
      learn.busy = false;
      if (result) applyState(result);
      redraw(learn.questions[learn.index]?.type === 'written' ? `ss-learn-answer-${learn.index}` : 'ss-learn-heading');
    } catch (error) { learn.busy = false; showError(error); redraw('ss-learn-next'); }
  }
  function renderLearn(cards, s) {
    const panel = el('section', { class: 'ss-learn' });
    if (!s.learn) {
      const count = cards.filter(card => !s.learnOnlyLearning || !isKnown(card, s)).length;
      const mode = el('div', { class: 'ss-learn-type', 'aria-label': 'Øvingsform' }, [['mixed', 'Blandet'], ['written', 'Skriv']].map(([value, label]) => el('button', { type: 'button', id: `ss-learn-type-${value}`, 'aria-pressed': s.learnType === value, class: s.learnType === value ? 'active' : '', onclick: () => { s.learnType = value; redraw(`ss-learn-type-${value}`); } }, label)));
      panel.append(el('div', { class: 'ss-config' }, el('div', { class: 'ss-config-icon' }, icon('check', 31)), el('h2', { id: 'ss-learn-heading', tabindex: -1 }, 'Øv til det sitter'), mode, el('label', { class: 'ss-check-row' }, el('input', { type: 'checkbox', checked: s.learnOnlyLearning, onchange: event => { s.learnOnlyLearning = event.target.checked; redraw(); } }), 'Kun kort jeg øver på'), el('p', { class: 'ss-small-note' }, 'Feil svar kommer tilbake. I blandet øving følger et skriftlig svar etter flervalg. Skriftlige svar sjekkes ordrett; du kan godta ditt eget svar.'), btn(`Start øving · ${count} kort`, () => startLearn(cards, s), '', 'arrow', { disabled: !count, id: 'ss-start-learn' })));
      return panel;
    }
    const learn = s.learn;
    const question = learn.questions[learn.index];
    const mastered = new Set(learn.mastered).size;
    panel.append(el('div', { class: 'ss-learn-status' }, el('h2', { id: 'ss-learn-heading', tabindex: -1 }, 'Øv'), el('span', {}, `${mastered} / ${learn.cards.length} kort`), btn('Start på nytt', () => { s.learn = null; redraw('ss-learn-heading'); }, 'button-text button-small', null, { disabled: learn.busy })), progress(mastered, learn.cards.length, 'Lærte kort'));
    if (!question) {
      panel.append(el('div', { class: 'ss-learn-finished' }, el('div', { class: 'ss-score-bubble' }, icon('check', 44)), el('h2', {}, 'Bra jobbet!'), el('p', {}, `${mastered} kort · ${learn.attempts} svar`), btn('Ta en quiz', () => { s.mode = 'quiz'; s.quiz = null; redraw(); }, '', 'arrow')));
      return panel;
    }
    panel.append(renderQuestion(question, learn.index, { prefix: 'ss-learn', locked: Boolean(learn.feedback) || learn.busy, onSubmit: () => answerLearn(s), onAnswer: response => { if (question.type !== 'written') answerLearn(s, response); } }));
    if (learn.feedback) {
      const feedback = el('div', { class: `ss-learn-feedback${learn.feedback.correct ? ' correct' : ' incorrect'}`, role: 'status' }, el('div', { class: 'ss-result-feedback' }, icon(learn.feedback.correct ? 'check' : 'close', 17), el('strong', {}, learn.feedback.correct ? 'Riktig!' : 'Se på fasiten')), !learn.feedback.correct ? el('p', {}, question.answer) : null);
      if (!learn.feedback.correct && question.type === 'written' && answered(question)) feedback.append(btn('Jeg hadde rett', () => { question.accepted = true; learn.feedback.correct = true; redraw('ss-learn-next'); }, 'button-text button-small', null, { disabled: learn.busy }));
      feedback.append(btn('Fortsett', () => nextLearn(s), '', 'arrow', { id: 'ss-learn-next', disabled: learn.busy }));
      panel.append(feedback);
    } else if (question.type === 'written') panel.append(el('div', { class: 'ss-learn-actions' }, btn('Vet ikke', () => answerLearn(s, undefined, true), 'button-text', null, { disabled: learn.busy }), btn('Sjekk svar', () => answerLearn(s), '', 'check', { disabled: learn.busy })));
    else panel.append(el('div', { class: 'ss-learn-actions' }, btn('Vet ikke', () => answerLearn(s, undefined, true), 'button-text', null, { disabled: learn.busy })));
    return panel;
  }

  function renderList(cards, s) {
    const details = el('details', { class: 'ss-card-list', open: s.listOpen, ontoggle: event => { s.listOpen = event.target.open; } }, el('summary', {}, `${cards.length} kort`, icon('chevron', 14)));
    const list = el('div', { class: 'ss-card-list-rows' });
    cards.forEach((card, index) => list.append(el('div', { class: 'ss-card-list-row' }, el('span', { class: 'ss-list-index' }, index + 1), el('div', { class: 'ss-list-question' }, el('p', {}, card.question), card.origin === 'ai' ? chip('KI', 'ai') : null), el('p', { class: 'ss-list-answer' }, card.answer), btn('Rediger', () => cardModal(null, card), 'button-text button-small'))));
    details.append(list);
    return details;
  }
  function render() {
    const s = session();
    const cards = cardsForProject();
    if (ui.cardId && ui.cardId !== s.lastGlobalCardId && cards.some(card => card.id === ui.cardId)) {
      s.mode = 'cards'; s.filter = 'all'; s.selected = ui.cardId; s.lastGlobalCardId = ui.cardId; s.flipped = false;
    }
    const page = el('div', { class: 'page ss-page' }, el('header', { class: 'ss-page-heading' }, el('h1', {}, 'Flashcards'), btn('Nytt kort', () => cardModal(), '', 'add')));
    const modes = [['cards', 'Kort', 'cards'], ['learn', 'Øv', 'check'], ['quiz', 'Quiz', 'book']];
    const modeBar = el('div', { class: 'ss-mode-bar', role: 'tablist', 'aria-label': 'Studieform', onkeydown: event => {
      const index = modes.findIndex(([mode]) => mode === s.mode);
      const next = event.key === 'ArrowRight' ? (index + 1) % modes.length : event.key === 'ArrowLeft' ? (index + modes.length - 1) % modes.length : event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      s.mode = modes[next][0]; redraw(`ss-mode-${s.mode}`);
    } }, modes.map(([mode, label, iconName]) => el('button', { type: 'button', id: `ss-mode-${mode}`, role: 'tab', 'aria-selected': s.mode === mode, 'aria-controls': 'ss-mode-content', tabindex: s.mode === mode ? 0 : -1, class: s.mode === mode ? 'active' : '', onclick: () => { s.mode = mode; redraw(`ss-mode-${mode}`); } }, icon(iconName, 18), label)));
    page.append(modeBar);
    const content = el('div', { id: 'ss-mode-content', role: 'tabpanel', 'aria-labelledby': `ss-mode-${s.mode}`, class: 'ss-mode-content' });
    content.append(cards.length ? s.mode === 'cards' ? renderCards(cards, s) : s.mode === 'learn' ? renderLearn(cards, s) : renderQuiz(cards, s) : emptyDeck('Lag ditt første kort'));
    page.append(content);
    if (cards.length) page.append(renderList(cards, s));
    return page;
  }

  window.SammenStudy = { render, logic: { normalizeAnswer, shuffle, availableTypes, alternatives, questionFor, buildQuestions, isCorrect, answered, advanceLearn } };
})();
