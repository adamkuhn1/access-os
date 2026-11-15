import { browser } from 'wxt/browser';

// The Access OS agent loop:
//   observe the page -> ask Claude for ONE next step -> check it is safe and
//   allowed -> show it with the cursor and do it -> verify it -> repeat.
// The side panel UI is told about progress through the AgentUI callbacks, and
// Stop is an AbortSignal checked after every await.

const BACKEND = 'http://127.0.0.1:3001';

// limits for one run, sized for a flight search
const MAX_STEPS = 15;
const MAX_NAVIGATIONS = 6;
const MAX_ANALYSES = 3;
const MAX_WAITS = 8;
const MAX_ROUNDS = 40;
const MAX_RETRIES = 3;
const PAGE_LOAD_TIMEOUT = 10000;

type PageElement = { id: number; text: string; role: string; inputType?: string; value?: string; state?: string; checked?: boolean };
type Step = { action: string; message?: string; url?: string; elementId?: number; value?: string | boolean | number; checks?: { field: string; shows: string }[] };

export type Answer = { answer: string; evidence: string[]; truncated: boolean; best?: Record<string, string>; sourceUrl: string };
type AgentUI = {
  progress: (text: string) => void;
  step: (text: string) => void;
  answer: (answer: Answer) => void;
};

// everything one run keeps track of
type Run = {
  goal: string;
  context: string;
  ui: AgentUI;
  stop: AbortSignal;
  tabId: number;
  url: string; // the page we expect to be on ('' for a blank tab)
  today: string;
  history: { action: string; text: string; value: string | boolean | number }[];
  navigations: number;
  waits: number;
  analyses: number;
  retries: number;
  lastError: string; // why the last step failed, told to Claude next round
  noEffect: Record<string, number>; // presses that changed nothing, by label
  newTabId: number; // a tab our own click just opened (like "Visit site")
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sendToTab = (tabId: number, message: object) => browser.tabs.sendMessage(tabId, message);

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function post(path: string, body: object, signal: AbortSignal) {
  const response = await fetch(BACKEND + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return { status: response.status, data: await response.json() };
}

// runs a goal to the end and returns the final message for the user. throws
// (with a readable message) when it has to stop early
// context is the previous request and its result, for follow-up requests
export async function runAgent(goal: string, ui: AgentUI, stop: AbortSignal, context = '') {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab found.');

  const run: Run = {
    goal, ui, stop, context,
    tabId: tab.id,
    url: tab.url ?? '',
    today: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    history: [], navigations: 0, waits: 0, analyses: 0, retries: 0, lastError: '', noEffect: {}, newTabId: 0,
  };

  // buttons like "Visit site" open a new tab (often without saying which tab
  // opened it): follow any tab that opens in this window during the task
  const watchNewTabs = (opened: { id?: number; windowId?: number }) => {
    if (opened.windowId === tab.windowId && opened.id) run.newTabId = opened.id;
  };
  browser.tabs.onCreated.addListener(watchNewTabs);

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (run.history.length >= MAX_STEPS) return `Stopped at the ${MAX_STEPS}-step safety limit. Check the rest yourself.`;

      await checkPage(run);
      const elements = await observe(run, round);
      if (!elements) continue; // the page was still loading

      const step = await decide(run, round, elements);
      if (!step) continue; // Claude's choice was rejected, ask again

      const finished = await act(run, round, step, elements);
      if (finished) return finished;
    }
    throw new Error('The agent took too many rounds without finishing. Stopped.');
  } finally {
    browser.tabs.onCreated.removeListener(watchNewTabs);
  }
}

// throws if the user hit Stop or switched tabs
async function checkTab(run: Run) {
  if (run.stop.aborted) throw new Error('Stopped by user.');
  const tab = await getActiveTab();
  if (run.stop.aborted) throw new Error('Stopped by user.');
  if (tab?.id !== run.tabId) throw new Error('You switched tabs, so the agent stopped.');
  return tab;
}

// ...and keeps up with the page's address (sites often change it on their own)
async function checkPage(run: Run) {
  run.url = (await checkTab(run)).url ?? '';
}

// the page's controls, or null if we waited for a loading page instead. blank
// tabs and browser pages have no content script, so nothing to scan
async function observe(run: Run, round: number) {
  if (!/^https?:\/\//.test(run.url)) return [];

  run.ui.progress(`Step ${round}: looking at the page...`);
  const page = await sendToTab(run.tabId, { type: 'GET_PAGE_ELEMENTS' });
  await checkPage(run);

  if (page.busy && run.waits < MAX_WAITS) {
    run.waits++;
    run.ui.progress(`Step ${round}: waiting for the page to finish loading...`);
    await sleep(1500);
    return null;
  }
  return page.elements as PageElement[];
}

// the next step from Claude, or null if it was rejected and we should ask again
async function decide(run: Run, round: number, elements: PageElement[]) {
  run.ui.progress(`Step ${round}: deciding what to do next...`);
  const { status, data } = await post('/agent/next', {
    goal: run.goal, context: run.context, url: run.url, elements, history: run.history, today: run.today, lastError: run.lastError,
  }, run.stop);
  await checkPage(run);

  // 422: the backend rejected Claude's choice. 502: Claude gave no usable answer
  if ((status === 422 || status === 502) && run.retries < MAX_RETRIES) {
    run.retries++;
    run.lastError = data.error || 'invalid step';
    return null;
  }
  if (status !== 200) {
    console.error('Agent step failed:', data.error);
    throw new Error("I got stuck on this page and stopped. Try asking in a different way.");
  }

  run.lastError = '';
  return data as Step;
}

// does the step. returns a message when the run is finished
async function act(run: Run, round: number, step: Step, elements: PageElement[]): Promise<string | void> {
  if (step.action === 'done') return `Done: ${step.message}`;
  if (step.action === 'ask') return `I need more information: ${step.message}`;
  if (step.action === 'none') return `Stopped: ${step.message}`;
  if (step.action === 'open_site') return openSite(run, round, String(step.url));
  if (step.action === 'analyze') return analyzePage(run, round, elements);
  if (step.action === 'scroll') {
    await sendToTab(run.tabId, { type: 'SCROLL', value: step.value });
    run.history.push({ action: 'scroll', text: 'Scrolled the page', value: String(step.value) });
    return void (await sleep(600));
  }
  if (step.action === 'back') {
    await browser.tabs.goBack(run.tabId);
    run.history.push({ action: 'back', text: 'Went back', value: run.url });
    return void (await adoptUrlChange(run));
  }

  const target = elements.find((element) => element.id === step.elementId);
  if (!target || !['set', 'press'].includes(step.action)) throw new Error('Claude chose a step that does not fit this page. Stopped.');
  return interact(run, round, step, target, elements);
}

// a step failed (target moved, got covered, vanished, or refused the value).
// let Claude pick again a few times, then give up
function retry(run: Run, target: PageElement, problem: string) {
  if (run.retries >= MAX_RETRIES) {
    throw new Error(`Couldn't complete "${target.text}" (${problem}). The agent stopped without searching; check the form yourself.`);
  }
  run.retries++;
  run.lastError = `the step on "${target.text}" failed: ${problem}. Pick again from the current controls`;
}

// press a control or fill in a field: point the cursor at it, do it, verify it
async function interact(run: Run, round: number, step: Step, target: PageElement, elements: PageElement[]) {
  const isPress = step.action === 'press';

  // text and search boxes are typed out so the user can follow along
  const value = step.value;
  const typeOut = typeof value === 'string' && (target.role === 'textarea' || ['text', 'search', ''].includes(target.inputType ?? ''));
  const shownValue = typeof value === 'boolean' ? (value ? 'checked / selected' : 'unchecked') : `"${value}"`;
  run.ui.progress(`Step ${round}: ${isPress ? `pressing "${target.text}"` : `${typeOut ? 'typing' : 'setting'} "${target.text}" ${shownValue}`}`);

  // the cursor glides to the target first
  const targetRef = { elementId: target.id, expectedText: target.text };
  const highlighted = await sendToTab(run.tabId, { type: 'HIGHLIGHT_ELEMENT', ...targetRef });
  await checkPage(run);
  if (!highlighted?.success) return retry(run, target, 'it changed or disappeared');
  await sleep(700);
  await checkPage(run);

  const result = await sendToTab(run.tabId, isPress
    ? { type: 'PRESS_ELEMENT', ...targetRef }
    : { type: 'SET_FORM_CONTROL', ...targetRef, value, typeOut });
  if (!result?.success) return retry(run, target, result?.error ?? 'unknown error');

  // fields: the content script read the field back after the page reacted
  if (!isPress && result.verified !== true) {
    throw new Error(`Verification failed: "${target.text}" doesn't show the expected value, so the agent stopped.`);
  }

  if (step.checks?.length) {
    run.ui.step(`Checked the form before searching: ${step.checks.map((c) => `${c.field} = ${c.shows}`).join(', ')}`);
  }

  const urlBefore = run.url;
  await adoptUrlChange(run);

  if (!isPress) {
    run.history.push({ action: 'set', text: target.text, value: value ?? '' });
    run.ui.step(`${target.text} → ${shownValue}${result.movedTo ? ` (typed into "${result.movedTo}")` : ''}`);
    return;
  }

  // what did the press actually do? compare the form before and after
  let effect = run.url !== urlBefore ? `the page changed to ${new URL(run.url).pathname}` : '';
  if (!effect) {
    const after = (await sendToTab(run.tabId, { type: 'GET_PAGE_ELEMENTS' })).elements as PageElement[];
    effect = describeChange(elements, after);
  }

  run.history.push({ action: 'press', text: target.text, value: effect || 'no visible change' });
  run.ui.step(`Pressed "${target.text}" → ${effect || 'no visible change'}`);

  // don't keep pressing things that do nothing
  if (!effect) {
    const times = (run.noEffect[target.text] ?? 0) + 1;
    run.noEffect[target.text] = times;
    const total = Object.values(run.noEffect).reduce((sum, n) => sum + n, 0);
    if (times >= 2 || total >= 4) {
      throw new Error(`Pressing "${target.text}" didn't visibly change anything, so the agent stopped instead of repeating it. Check the form yourself.`);
    }
  }
}

// what each form control shows, like 'Departure: "Mon, Nov 16"', plus
// selected/expanded/pressed widgets. compared before and after a press
function formSnapshot(elements: PageElement[]) {
  return elements
    .filter((e) => ['input', 'textarea', 'select', 'combobox'].includes(e.role) || /selected|checked|pressed|expanded/.test(e.state ?? ''))
    .map((e) => {
      if (['radio', 'checkbox'].includes(e.inputType ?? '')) return `${e.text}: ${e.checked ? 'selected' : 'not selected'}`;
      if (['input', 'textarea', 'select'].includes(e.role)) return `${e.text}: "${e.value ?? ''}"`;
      return `${e.text}${e.state ? ` [${e.state}]` : ''}`;
    });
}

// a short note on what changed, or '' if nothing visibly did
function describeChange(before: PageElement[], after: PageElement[]) {
  const remaining = formSnapshot(before);
  const added = formSnapshot(after).filter((line) => {
    const index = remaining.indexOf(line);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
  const pickers = (list: PageElement[]) => list.filter((e) => ['option', 'gridcell'].includes(e.role)).length;
  // new controls showing up means something opened (a details panel, a dialog...)
  const known = new Set(before.map((e) => e.text));
  const appeared = after.filter((e) => !known.has(e.text)).length;

  if (added.length) return `now ${added.slice(0, 4).join('; ')}`;
  if (remaining.length || pickers(before) !== pickers(after)) return 'a menu, picker or list opened or closed';
  if (appeared >= 3) return `new content appeared (${appeared} new controls)`;
  return '';
}

// wait for a new page and its content script, bounded by a timeout
async function waitForPage(run: Run, previousUrl: string) {
  run.ui.progress('Waiting for the page to load...');
  for (const deadline = Date.now() + PAGE_LOAD_TIMEOUT; Date.now() < deadline; ) {
    await sleep(250);
    const tab = await checkTab(run);
    if (tab.status !== 'complete' || !tab.url || tab.url === previousUrl) continue;
    try {
      await sendToTab(run.tabId, { type: 'GET_PAGE_ELEMENTS' });
      return tab.url;
    } catch {
      // content script isn't ready yet
    }
  }
  throw new Error('The page took too long to load. Stopped.');
}

// our own press or typing can change the URL (a search running, a link
// opening, or a page updating its address). follow along, up to a limit
async function adoptUrlChange(run: Run) {
  await sleep(800);
  if (run.newTabId) {
    await browser.tabs.update(run.newTabId, { active: true });
    [run.tabId, run.newTabId, run.url] = [run.newTabId, 0, ''];
  }
  const tab = await checkTab(run);
  if (tab.url === run.url && tab.status === 'complete') return;

  const loadedUrl = tab.status === 'complete' && tab.url ? tab.url : await waitForPage(run, run.url);
  const after = new URL(loadedUrl);

  // a new page, not just the same page updating its search parameters
  if (after.origin + after.pathname !== run.url.split(/[?#]/)[0]) {
    if (++run.navigations > MAX_NAVIGATIONS) throw new Error(`Stopped at the ${MAX_NAVIGATIONS}-page navigation limit.`);
    run.ui.step(`Page changed → ${after.host}${after.pathname}`);
  }
  run.url = loadedUrl;
}

// open any web page by its address
async function openSite(run: Run, round: number, address: string) {
  const destination = URL.canParse(address) ? new URL(address) : null;
  if (!destination || !['http:', 'https:'].includes(destination.protocol)) {
    throw new Error(`"${address}" isn't a web address the agent can open. Stopped.`);
  }
  if (run.navigations++ >= MAX_NAVIGATIONS) throw new Error(`Stopped at the ${MAX_NAVIGATIONS}-page navigation limit.`);

  run.ui.progress(`Step ${round}: opening ${destination.host}...`);
  // (re-opening the same address is a reload, so don't wait for it to change)
  const previous = destination.href === run.url ? '' : run.url;
  await browser.tabs.update(run.tabId, { url: destination.href });
  await sleep(300);
  run.url = await waitForPage(run, previous);
  run.history.push({ action: 'open_site', text: destination.host, value: run.url });
  run.ui.step(`Opened ${new URL(run.url).host}`);
}

// read-only: read the page's visible text (never form values) and answer from it
async function analyzePage(run: Run, round: number, elements: PageElement[]) {
  if (run.analyses >= MAX_ANALYSES) throw new Error('The agent already read the page twice without an answer. Stopped.');

  const page = await sendToTab(run.tabId, { type: 'GET_PAGE_CONTENT' });
  await checkPage(run);
  // nothing readable yet (still loading): wait and look again
  if (!page?.content?.trim()) {
    if (run.waits++ >= MAX_WAITS) return 'Stopped: there is no readable text on this page.';
    run.ui.progress(`Step ${round}: waiting for the page to finish loading...`);
    return void (await sleep(1500));
  }

  run.ui.progress(`Step ${round}: reading the results...`);
  const { status, data } = await post('/page/analyze', {
    goal: run.context ? `${run.goal}\n(Earlier in this conversation: ${run.context})` : run.goal,
    url: page.url,
    content: page.content,
    truncated: page.truncated,
    today: run.today,
    // the search form's values, so the answer can confirm the results match
    // what was searched (personal fields are never included)
    searchFields: formSnapshot(elements).filter((line) => !line.includes('covered')).slice(0, 12),
  }, run.stop);
  await checkPage(run);
  if (status !== 200) throw new Error(data.error || `Backend error: ${status}`);
  run.analyses++;

  // no results yet, or the wrong page for this question: tell Claude and keep going
  if (['not_ready', 'wrong_page'].includes(data.status) && run.analyses < MAX_ANALYSES) {
    run.history.push({ action: 'analyze', text: 'Read the page', value: `${data.status === 'wrong_page' ? 'Wrong page' : 'Not ready'}: ${data.answer}` });
    run.ui.step(data.status === 'wrong_page' ? 'This page didn\'t answer it, looking elsewhere' : 'Read the page: no results yet, continuing');
    return;
  }

  run.ui.answer({ answer: data.answer, evidence: data.evidence ?? [], truncated: page.truncated, best: data.best, sourceUrl: page.url });
  run.ui.step('Read the page and answered');

  if (data.status === 'needs_user') return 'I need your input to continue (see the answer).';
  if (data.status === 'not_ready') return 'Stopped: the page still had no usable results.';
  return page.truncated ? 'Done, but only part of the page was read, so the answer may be incomplete.' : 'Done.';
}
