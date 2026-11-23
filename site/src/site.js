// The landing page demos. Everything here is progressive enhancement: the
// board is still readable without it, and no demo runs until a person asks.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, reduceMotion.matches ? 0 : ms);
  });
}

function showInView(element) {
  element.scrollIntoView({
    block: 'nearest',
    behavior: reduceMotion.matches ? 'auto' : 'smooth',
  });
}

/* Tabs */

const tabButtons = [...document.querySelectorAll('[data-work-tab]')];
const tabPanels = [...document.querySelectorAll('.work-panel')];

function selectTab(button) {
  for (const item of tabButtons) {
    const selected = item === button;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.id !== button.getAttribute('aria-controls');
  }
}

for (const button of tabButtons) {
  button.addEventListener('click', () => selectTab(button));
  button.addEventListener('keydown', event => {
    const current = tabButtons.indexOf(button);
    let next = current;

    if (event.key === 'ArrowRight') next = (current + 1) % tabButtons.length;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabButtons.length) % tabButtons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabButtons.length - 1;
    if (next === current) return;

    event.preventDefault();
    selectTab(tabButtons[next]);
    tabButtons[next].focus();
  });
}

if (tabButtons.length > 0) selectTab(tabButtons[0]);

/* Board */

const board = document.querySelector('[data-board]');

if (board) {
  const ticket = board.querySelector('[data-board-ticket]');
  const columns = new Map(
    [...board.querySelectorAll('[data-board-column]')].map(column => [column.dataset.boardColumn, column]),
  );
  const log = board.querySelector('[data-board-log]');
  const question = board.querySelector('[data-board-question]');
  const runButton = board.querySelector('[data-board-run]');
  const resetButton = board.querySelector('[data-board-reset]');
  const state = board.querySelector('[data-board-state]');
  const tag = board.querySelector('[data-board-tag]');
  const ticketLabel = ticket.querySelector('.ticket-label');
  const initialColumn = ticket.closest('[data-board-column]');

  let runId = 0;
  let playing = false;
  let waiting = false;
  let finished = false;

  function addStep(title, text) {
    const item = document.createElement('li');
    item.className = 'run-step';
    const dot = document.createElement('span');
    dot.className = 'run-dot';
    dot.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const copy = document.createElement('p');
    copy.textContent = text;
    body.append(heading, copy);
    item.append(dot, body);
    log.append(item);
    log.scrollTop = log.scrollHeight;
  }

  function updateCounts() {
    for (const column of columns.values()) {
      const count = column.querySelectorAll('.ticket').length;
      column.querySelector('[data-count]').textContent = String(count);
    }
  }

  function moveTicket(columnName) {
    columns.get(columnName).querySelector('.board-cards').append(ticket);
    ticket.classList.remove('ticket-in');
    ticket.getBoundingClientRect();
    ticket.classList.add('ticket-in');
    updateCounts();
  }

  function setState(text, tagText) {
    state.textContent = text;
    tag.textContent = tagText;
  }

  function reset() {
    runId += 1;
    playing = false;
    waiting = false;
    finished = false;
    initialColumn.querySelector('.board-cards').append(ticket);
    ticket.classList.remove('ticket-in');
    log.replaceChildren();
    const empty = document.createElement('li');
    empty.className = 'run-empty';
    empty.textContent = 'Press Run INF-214 to watch the board.';
    log.append(empty);
    question.hidden = true;
    ticketLabel.textContent = 'bug';
    runButton.disabled = false;
    runButton.textContent = 'Run INF-214';
    setState('Ready when you are.', 'idle');
    updateCounts();
  }

  async function play() {
    if (playing || waiting) return;
    playing = true;
    finished = false;
    const current = ++runId;

    log.replaceChildren();
    question.hidden = true;
    runButton.disabled = true;
    runButton.textContent = 'Running';
    setState('Picked up INF-214.', 'working');
    moveTicket('progress');
    addStep('Picked up', 'Moved to In Progress. Branch inf-214/retry-backoff.');

    await wait(1100);
    if (current !== runId) return;
    addStep('Read the context', 'Checked the retry policy and the last three incidents.');

    await wait(1100);
    if (current !== runId) return;
    addStep('Changed the code', 'Added exponential backoff and 12 tests.');

    await wait(1100);
    if (current !== runId) return;
    addStep('Tests pass', '42 webhook tests pass. PR #419 is open.');

    await wait(1100);
    if (current !== runId) return;
    moveTicket('review');
    addStep('In review', 'Moved to Review. One question for a person.');
    setState('The worker stopped to ask.', 'needs you');
    playing = false;
    waiting = true;
    runButton.textContent = 'Waiting for you';
    question.hidden = false;
    showInView(question);
  }

  async function finish(answer) {
    if (!waiting) return;
    waiting = false;
    const current = ++runId;
    question.hidden = true;
    setState('Answer recorded. Finishing the ticket.', 'done');
    moveTicket('done');
    addStep('Decision', `You chose ${answer}s. The note is in the project memory.`);

    await wait(800);
    if (current !== runId) return;
    addStep('Done', 'Merged. The board is up to date.');
    ticketLabel.textContent = 'merged';
    runButton.disabled = false;
    runButton.textContent = 'Run again';
    finished = true;
    setState('Done. That took one answer.', 'done');
  }

  runButton.addEventListener('click', () => {
    if (finished) reset();
    play();
  });
  resetButton.addEventListener('click', reset);
  for (const button of board.querySelectorAll('[data-board-answer]')) {
    button.addEventListener('click', () => finish(button.dataset.boardAnswer));
  }

  reset();
}

/* Meeting */

const meeting = document.querySelector('[data-meeting]');

if (meeting) {
  const transcript = meeting.querySelector('[data-meeting-transcript]');
  const notes = meeting.querySelector('[data-meeting-notes]');
  const answer = meeting.querySelector('[data-meeting-answer]');
  const askButton = meeting.querySelector('[data-meeting-ask]');
  const runButton = meeting.querySelector('[data-meeting-run]');
  const resetButton = meeting.querySelector('[data-meeting-reset]');
  const status = meeting.querySelector('[data-meeting-status]');
  const stateText = meeting.querySelector('[data-meeting-state-text]');
  const meetingState = meeting.querySelector('.meeting-state');
  const tag = meeting.querySelector('[data-meeting-tag]');

  const lines = [
    ['Maya', 'We need one more day for the migration.'],
    ['Jon', 'The rollback path is tested. I can finish Thursday morning.'],
    ['Maya', 'Then Thursday. Support needs the new date today.'],
    ['aivi', 'Noted. I will draft the release note and put the support update on the board.'],
  ];

  let runId = 0;
  let playing = false;
  let finished = false;

  function addLine(who, text) {
    transcript.querySelector('.transcript-empty')?.remove();
    const line = document.createElement('p');
    line.className = 'transcript-line';
    const speaker = document.createElement('strong');
    speaker.textContent = who;
    const copy = document.createElement('span');
    copy.textContent = text;
    line.append(speaker, copy);
    transcript.append(line);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function addNote(label, text) {
    notes.querySelector('.note-empty')?.remove();
    const item = document.createElement('li');
    item.className = 'note-item';
    const heading = document.createElement('span');
    heading.className = 'note-label';
    heading.textContent = label;
    const copy = document.createElement('p');
    copy.textContent = text;
    item.append(heading, copy);
    notes.append(item);
  }

  function reset() {
    runId += 1;
    playing = false;
    finished = false;
    transcript.replaceChildren();
    const emptyLine = document.createElement('p');
    emptyLine.className = 'transcript-empty';
    emptyLine.textContent = 'The call has not started.';
    transcript.append(emptyLine);
    notes.replaceChildren();
    const emptyNote = document.createElement('li');
    emptyNote.className = 'note-empty';
    emptyNote.textContent = 'Decisions and actions appear as people speak.';
    notes.append(emptyNote);
    answer.hidden = true;
    askButton.hidden = true;
    runButton.disabled = false;
    runButton.textContent = 'Join the demo call';
    status.textContent = 'A short stand-up. Press play.';
    stateText.textContent = 'aivi is listening';
    meetingState.classList.remove('is-ended');
    tag.textContent = 'nothing yet';
  }

  async function play() {
    if (playing) return;
    if (finished) reset();
    playing = true;
    finished = false;
    const current = ++runId;

    answer.hidden = true;
    askButton.hidden = true;
    runButton.disabled = true;
    runButton.textContent = 'Listening';
    status.textContent = 'aivi joined the call.';
    tag.textContent = 'listening';
    stateText.textContent = 'aivi is listening';

    addLine(...lines[0]);
    await wait(1100);
    if (current !== runId) return;
    addLine(...lines[1]);
    await wait(1100);
    if (current !== runId) return;
    addNote('Decision', 'The release moves to Thursday.');
    addLine(...lines[2]);
    await wait(1100);
    if (current !== runId) return;
    addLine(...lines[3]);
    await wait(1100);
    if (current !== runId) return;
    addNote('Owner', 'Jon owns the migration.');
    addNote('Action', 'aivi drafts the release note.');
    addNote('Action', 'Maya tells support today.');

    status.textContent = 'The call ended. The transcript is searchable.';
    tag.textContent = 'indexed';
    stateText.textContent = 'call ended';
    meetingState.classList.add('is-ended');
    runButton.disabled = false;
    runButton.textContent = 'Replay';
    askButton.hidden = false;
    showInView(askButton);
    playing = false;
    finished = true;
  }

  runButton.addEventListener('click', play);
  resetButton.addEventListener('click', reset);
  askButton.addEventListener('click', () => {
    answer.hidden = false;
    status.textContent = 'Asked. The answer cites the meeting.';
  });

  reset();
}

/* Schedule */

const schedule = document.querySelector('[data-schedule]');

if (schedule) {
  const reply = schedule.querySelector('[data-schedule-reply]');
  const weekly = schedule.querySelector('[data-schedule-weekly]');
  const reminder = schedule.querySelector('[data-schedule-reminder]');
  const empty = schedule.querySelector('[data-schedule-empty]');
  const weeklyButton = schedule.querySelector('[data-schedule-weekly-button]');
  const reminderButton = schedule.querySelector('[data-schedule-reminder-button]');
  const resetButton = schedule.querySelector('[data-schedule-reset]');
  const status = schedule.querySelector('[data-schedule-status]');

  function reveal(card) {
    card.hidden = false;
    card.classList.remove('card-in');
    card.getBoundingClientRect();
    card.classList.add('card-in');
    empty.hidden = true;
    showInView(card);
  }

  function reset() {
    reply.hidden = true;
    weekly.hidden = true;
    reminder.hidden = true;
    empty.hidden = false;
    weeklyButton.disabled = false;
    weeklyButton.textContent = 'Create the weekly brief';
    reminderButton.disabled = false;
    status.textContent = 'Two examples, one chat.';
  }

  weeklyButton.addEventListener('click', () => {
    reveal(weekly);
    reply.hidden = false;
    weeklyButton.disabled = true;
    weeklyButton.textContent = 'Brief created';
    status.textContent = 'Created. The next run is Monday at 09:00.';
  });

  reminderButton.addEventListener('click', () => {
    reveal(reminder);
    reminderButton.disabled = true;
    status.textContent = 'Added. The reminder lands in your DM on Thursday.';
  });

  resetButton.addEventListener('click', reset);

  reset();
}
