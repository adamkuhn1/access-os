import { browser } from 'wxt/browser';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type Answer, runAgent } from './agent';

const STOP = ['stop', 'stop agent', 'stop the agent', 'cancel task'];

// phrases made only of these words are handled here as scroll/back commands
const SCROLL_WORDS = new Set('scroll go move page keep going more again further down up a little bit lil tiny slightly back the to top bottom of all way please no ok okay now yeah and just for me can you could would it this'.split(' '));
const SMALL = ['little', 'bit', 'lil', 'tiny', 'slightly'];

const MIC_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone permission denied. Tap the mic to set it up.',
  'audio-capture': 'No microphone was found. Check your audio input.',
  'service-not-allowed': 'Chrome speech recognition is unavailable.',
  network: 'Speech recognition needs a network connection.',
};

type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export default function App() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('Tap the mic and say what you want to do, or type below.');
  const [listening, setListening] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);

  const recognitionRef = useRef<Recognizer | null>(null);
  const listeningRef = useRef(false);
  const runningRef = useRef(false);
  const stopRef = useRef<AbortController | null>(null);
  // last thing we said, so we can ignore our own echo
  const speakingRef = useRef(false);
  const lastSpokenRef = useRef('');
  // queued request, and the last exchange for follow-ups
  const pendingRef = useRef('');
  const contextRef = useRef('');
  const scrollDirectionRef = useRef(1); // so "more" keeps going the same way
  // speech callbacks are made once, so they get the latest functions through this
  const latest = useRef({ runTask, stopTask });
  useEffect(() => {
    latest.current = { runTask, stopTask };
  });

  // start listening right away if the mic is already allowed
  useEffect(() => {
    void navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((permission) => permission.state === 'granted' && startListening())
      .catch(() => {});
    return () => stopListening();
  }, []);

  // only speaks in voice mode
  function say(words: string) {
    if (!words || !listeningRef.current || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    speakingRef.current = true;
    lastSpokenRef.current = words.toLowerCase();
    const utterance = new SpeechSynthesisUtterance(words.slice(0, 400));
    // our echo can come in a bit after we stop talking
    utterance.onend = utterance.onerror = () => setTimeout(() => (speakingRef.current = false), 1000);
    speechSynthesis.speak(utterance);
  }

  // true if most of the words were in what we just said
  function isEcho(spoken: string) {
    const said = new Set(lastSpokenRef.current.split(/\W+/));
    const words = spoken.split(/\W+/).filter(Boolean);
    return words.filter((word) => said.has(word)).length > words.length * 0.7;
  }

  // a new request replaces the one that's running
  async function runTask(goal: string) {
    if (!goal.trim()) return;
    if (runningRef.current) {
      pendingRef.current = goal;
      setStatus(`Switching to: ${goal}`);
      return stopTask();
    }

    runningRef.current = true;
    stopRef.current = new AbortController();
    setRunning(true);
    setSteps([]);
    setAnswer(null);
    setStatus(`Working on: ${goal}`);

    let message = '';
    let spokenAnswer = '';
    try {
      message = await runAgent(goal.trim(), {
        progress: setProgress,
        step: (step) => setSteps((list) => [...list, step]),
        answer: (found) => {
          setAnswer(found);
          spokenAnswer = found.answer;
        },
      }, stopRef.current.signal, contextRef.current);
    } catch (error) {
      console.error(error);
      message = stopRef.current.signal.aborted ? 'Stopped.' : error instanceof Error ? error.message : 'Something went wrong.';
    } finally {
      runningRef.current = false;
      setRunning(false);
      setProgress('');
      contextRef.current = `The user asked: "${goal}". Result: ${spokenAnswer || message}`.slice(0, 600);

      const next = pendingRef.current;
      pendingRef.current = '';
      if (next) {
        void latest.current.runTask(next);
      } else {
        // screen readers announce the status line, so the answer goes there
        setStatus(spokenAnswer || message);
        say(spokenAnswer || message);
      }
    }
  }

  // stops the run and any speech
  function stopTask() {
    stopRef.current?.abort();
    setProgress('Stopping...');
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  // scroll and back run here without stopping a task. returns false for anything else
  async function quickCommand(phrase: string) {
    const words: string[] = phrase.toLowerCase().match(/[a-z']+/g) ?? [];
    if (!words.length || !words.every((word) => SCROLL_WORDS.has(word))) return false;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const has = (...list: string[]) => list.some((word) => words.includes(word));

    let value: number | string | undefined;
    if (has('top', 'bottom')) value = has('top') ? 'top' : 'bottom';
    else if (has('up', 'down')) scrollDirectionRef.current = has('up') ? -1 : 1;
    else if (has('back')) {
      if (tab?.id) await browser.tabs.goBack(tab.id).catch(() => {});
      setStatus('Went back.');
      return true;
    } else if (!has('scroll', 'more', 'again', 'further', 'keep', 'going', ...SMALL)) return true; // filler like "okay"

    value ??= scrollDirectionRef.current * (has(...SMALL) ? 0.3 : 0.75);
    if (!tab?.id) return true;
    const scrolled = await browser.tabs.sendMessage(tab.id, { type: 'SCROLL', value }).catch(() => null);
    if (!scrolled) {
      setStatus("Can't scroll this page.");
      return true;
    }
    setStatus(typeof value === 'string' ? `Went to the ${value}.` : `Scrolled ${value < 0 ? 'up' : 'down'}${has(...SMALL) ? ' a little' : ''}.`);
    return true;
  }

  // handles one finished phrase
  function handleSpeech(transcript: string) {
    const spoken = transcript.toLowerCase().replace(/[.!?]+$/, '');
    if (speakingRef.current) {
      if (isEcho(spoken)) return;
      speechSynthesis.cancel(); // user is talking, so stop talking
    }

    if (['stop listening', 'microphone off'].includes(spoken)) return stopListening();
    if (STOP.includes(spoken)) return runningRef.current ? latest.current.stopTask() : setStatus('Nothing to stop right now.');
    void quickCommand(spoken).then((handled) => {
      if (handled) return;
      setText(transcript);
      void latest.current.runTask(transcript);
    });
  }

  function stopListening() {
    listeningRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }

  function startListening() {
    const speech = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
    const Recognition = speech.SpeechRecognition || speech.webkitSpeechRecognition;
    if (!Recognition) return setStatus('Speech recognition is not supported in this browser.');

    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal && result[0].transcript.trim()) handleSpeech(result[0].transcript.trim());
      }
    };
    recognition.onerror = (event) => {
      if (!listeningRef.current || event.error === 'no-speech') return; // Chrome fires no-speech a lot
      stopListening();
      setStatus(MIC_ERRORS[event.error] ?? `Speech recognition error: ${event.error}`);
    };
    // Chrome ends recognition on its own sometimes, so restart it
    recognition.onend = () => {
      if (!listeningRef.current) return;
      try {
        recognition.start();
      } catch {
        stopListening();
      }
    };

    recognitionRef.current = recognition;
    listeningRef.current = true;
    recognition.start();
    setListening(true);
    setStatus('Listening. Say what you want to do.');
  }

  // the side panel can't show the mic prompt, so open a setup tab the first time
  async function toggleListening() {
    if (listeningRef.current) {
      stopListening();
      return setStatus('Stopped listening.');
    }

    const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null);
    if (!permission || permission.state === 'granted') return startListening();
    if (permission.state === 'denied') {
      return setStatus('The microphone is blocked for Access OS. Allow it in Chrome\'s site settings, then press Speak again.');
    }

    setStatus('Please allow the microphone in the tab that just opened.');
    permission.onchange = () => {
      if (permission.state === 'granted') startListening();
      if (permission.state !== 'prompt') permission.onchange = null;
    };

    // reuse an open setup tab instead of opening another
    const setupUrl = browser.runtime.getURL('/mic-permission.html');
    const [open] = await browser.runtime.getContexts({ contextTypes: [browser.runtime.ContextType.TAB], documentUrls: [setupUrl] });
    if (open?.tabId && open.tabId !== -1) await browser.tabs.update(open.tabId, { active: true });
    else await browser.tabs.create({ url: setupUrl });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void quickCommand(text).then((handled) => {
      if (!handled) void runTask(text);
    });
  }

  return (
    <main>
      <header>
        <h1>Access OS</h1>
        <span className={listening ? 'dot on' : 'dot'} aria-hidden="true" />
      </header>

      <button type="button" className="mic" onClick={() => void toggleListening()} aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Start listening'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0m6 6v3m-3 0h6" /></svg>
      </button>
      <p className="hint">{listening ? 'Listening, just talk' : 'Tap to talk'}</p>

      <p role="status" className="status">{status}</p>
      {progress && <p className="progress">{progress}</p>}
      {running && <button type="button" className="stop" onClick={stopTask}>Stop</button>}

      <section aria-label="Activity">
        {answer && (answer.best || answer.evidence.length > 0) && (
          <div className="card">
            {answer.best && (
              <dl>
                {Object.entries(answer.best).map(([key, value]) => (
                  <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{value}</dd></div>
                ))}
              </dl>
            )}
            {answer.evidence.length > 0 && <ul>{answer.evidence.map((line) => <li key={line}>{line}</li>)}</ul>}
            <p className="source">{answer.sourceUrl}</p>
          </div>
        )}

        {steps.length > 0 && (
          <details>
            <summary>{steps.length} steps</summary>
            <ol>{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </details>
        )}
      </section>

      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type instead…" aria-label="Request" />
        <button type="submit" aria-label="Send">↑</button>
      </form>
    </main>
  );
}
