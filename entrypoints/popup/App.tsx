
import { browser } from 'wxt/browser';
import { useEffect, useRef, useState } from 'react';
import './App.css';

type PageElement = {
  id: number;
  text: string;
  role: string;
  href?: string;
  inputType?: string;
  options?: {
    text: string;
    value: string;
    disabled?: boolean;
  }[];
};

type SelectedLink = {
  id: number;
  text: string;
  href: string;
  tabId: number;
};

type PendingFormControl = {
  id: number;
  text: string;
  value: string | boolean;
  displayValue: string;
  tabId: number;
};

// limits for one agent run, sized for a flight search
const AGENT_MAX_STEPS = 15;
const AGENT_MAX_NAVIGATIONS = 3;
const AGENT_MAX_SITE_CHANGES = 1;
const AGENT_MAX_ANALYSES = 2;
const AGENT_MAX_WAITS = 8;
const AGENT_MAX_ROUNDS = 40;
const AGENT_MAX_REJECTIONS = 3;

// websites the agent may open by itself (after asking). Claude only picks an
// ID, the URL always comes from here
const KNOWN_SITES: Record<string, { name: string; url: string }> = {
  google_flights: {
    name: 'Google Flights',
    url: 'https://www.google.com/travel/flights',
  },
  skyfinder_demo: {
    name: 'SkyFinder demo site',
    url: 'http://localhost:8123/skyfinder/',
  },
};

const PRESSABLE_ROLES = [
  'button', 'option', 'gridcell', 'tab', 'menuitem', 'menuitemradio',
  'menuitemcheckbox', 'switch', 'radio', 'checkbox', 'combobox',
];

// buttons the agent must never press (checked again in the content script)
const RISKY_PRESS =
  /\b(buy|purchase|book|reserve|checkout|check out|pay|payment|place order|order now|subscribe|sign ?up|create account|register|log ?in|sign ?in|log ?out|sign ?out|delete|remove|send|post|share|donate|transfer|confirm|add to cart|cart)\b|select (this )?(flight|fare)/i;

// spoken goals that sound like a whole task go to Agent Mode, everything
// else stays a single-action command
const AGENT_VOICE_GOAL =
  /^(agent\b|find\b|search\b|look (up|for)\b|compare\b|get me\b|show me the cheapest\b|plan\b)|\bcheapest\b/i;

// plain http is only allowed for other sites when they're local dev servers
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;
const PAGE_LOAD_TIMEOUT = 10000;

// links the agent should never follow on its own
const RISKY_LINK =
  /log ?out|sign ?out|delete|remove|unsubscribe|cancel|purchase|buy|pay|checkout|check ?out|order|submit|confirm|transfer|donate/i;

// same idea as the backend filter, checked again before we touch anything
const SENSITIVE_FIELD =
  /password|passcode|card ?number|credit|debit|cvv|cvc|security code|expir|iban|routing|account number|ssn|social security/i;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

type AgentHistoryStep = {
  action: 'set' | 'click' | 'press' | 'open_site' | 'analyze';
  elementId: number;
  text: string;
  value: string | boolean;
  success: true;
};

const BEST_LABELS: Record<string, string> = {
  airline: 'Airline',
  from: 'From',
  to: 'To',
  date: 'Date',
  time: 'Time',
  price: 'Price',
  tripType: 'Trip type',
  stops: 'Stops',
  limits: 'Fare limits',
};

type AgentPreview = {
  action: string;
  target?: string;
  value?: string;
  message: string;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    [index: number]: { transcript: string };
  }>;
};

type SpeechRecognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function App({ inSidePanel = false }: { inSidePanel?: boolean }) {
  const [status, setStatus] = useState('Ready');
  const [command, setCommand] = useState('');
  const [listening, setListening] = useState(false);

  const [selectedLink, setSelectedLink] =
    useState<SelectedLink | null>(null);

  const [pendingForm, setPendingForm] =
    useState<PendingFormControl | null>(null);

  const voiceActiveRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognizer | null>(null);
  const permissionWatchRef = useRef<PermissionStatus | null>(null);

  const [pageQuestion, setPageQuestion] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [pageText, setPageText] = useState('');
  const [pageAnswer, setPageAnswer] = useState<{
    answer: string;
    evidence: string[];
    truncated: boolean;
  } | null>(null);
  const [pageError, setPageError] = useState('');

  const [agentGoal, setAgentGoal] = useState('');
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentPreview, setAgentPreview] =
    useState<AgentPreview | null>(null);

  const [agentRunning, setAgentRunning] = useState(false);
  const [agentProgress, setAgentProgress] = useState('');
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentResult, setAgentResult] = useState('');
  const agentRunningRef = useRef(false);
  const agentStopRef = useRef(false);

  // analyze step: page text waiting for the user's ok, and the answer after
  const [agentApproval, setAgentApproval] = useState<{
    preview: string;
    length: number;
    truncated: boolean;
  } | null>(null);
  const [agentAnswer, setAgentAnswer] = useState<{
    answer: string;
    evidence: string[];
    truncated: boolean;
    best?: Record<string, string>;
    sourceUrl?: string;
  } | null>(null);
  const [useDemoSite, setUseDemoSite] = useState(false);

  // true while we're speaking, so the mic doesn't take our own voice as a command
  const speakingRef = useRef(false);
  const lastSpokenRef = useRef('');
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(
    null
  );
  const agentAbortRef = useRef<AbortController | null>(null);

  // a link to another website, waiting for the user's ok. shares
  // approvalResolveRef with the page-sharing prompt (only one is ever open)
  const [navApproval, setNavApproval] = useState<{
    label: string;
    url: string;
    origin: string;
  } | null>(null);

  // recognition callbacks would otherwise see stale state
  const latestActionsRef = useRef({
    pendingForm,
    selectedLink,
    confirmForm: handleConfirmForm,
    confirmNavigation: handleConfirmNavigation,
    runAgent: handleRunAgent,
    stopAgent,
  });

  useEffect(() => {
    latestActionsRef.current = {
      pendingForm,
      selectedLink,
      confirmForm: handleConfirmForm,
      confirmNavigation: handleConfirmNavigation,
      runAgent: handleRunAgent,
      stopAgent,
    };
  });

  // make sure the mic gets released when the UI closes
  useEffect(() => {
    return () => {
      voiceActiveRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;

      if (permissionWatchRef.current) {
        permissionWatchRef.current.onchange = null;
      }
    };
  }, []);

  async function handleAskClaude(inputCommand = command) {
    setSelectedLink(null);
    setPendingForm(null);

    if (!inputCommand.trim()) {
      setStatus('Please enter a command.');
      return;
    }

    setStatus('Scanning webpage...');

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        throw new Error('No active tab found');
      }

      const pageData = await browser.tabs.sendMessage(
        tab.id,
        { type: 'GET_PAGE_ELEMENTS' }
      );

      const elements = pageData.elements as PageElement[];

      setStatus('Asking Claude...');

      const response = await fetch(
        'http://127.0.0.1:3001/interpret',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            command: inputCommand.trim(),
            elements,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`);
      }

      const result = await response.json();

      if (result.action === 'none') {
        setStatus('Claude could not complete that request.');
        return;
      }

      const selected = elements.find(
        (element) => element.id === result.elementId
      );

      if (!selected) {
        throw new Error('Invalid element selected');
      }

      const highlightResult = await browser.tabs.sendMessage(
        tab.id,
        {
          type: 'HIGHLIGHT_ELEMENT',
          elementId: selected.id,
        }
      );

      if (!highlightResult.success) {
        setStatus('Could not highlight the element.');
        return;
      }

      if (result.action === 'click') {
        if (
          selected.role !== 'link' ||
          typeof selected.href !== 'string'
        ) {
          setStatus('Invalid navigation action.');
          return;
        }

        setSelectedLink({
          id: selected.id,
          text: selected.text,
          href: selected.href,
          tabId: tab.id,
        });

        setStatus('Please confirm navigation.');
        return;
      }

      if (result.action === 'set') {
        if (
          !['input', 'textarea', 'select'].includes(
            selected.role
          ) ||
          !['string', 'boolean'].includes(
            typeof result.value
          )
        ) {
          setStatus('Invalid form action.');
          return;
        }

        let displayValue = String(result.value);

        if (selected.inputType === 'checkbox') {
          displayValue = result.value
            ? 'Check'
            : 'Uncheck';
        } else if (selected.inputType === 'radio') {
          displayValue = 'Select';
        }

        if (selected.role === 'select') {
          const option = selected.options?.find(
            (item) => item.value === result.value
          );

          if (option) {
            displayValue = option.text;
          }
        }

        setPendingForm({
          id: selected.id,
          text: selected.text,
          value: result.value,
          displayValue,
          tabId: tab.id,
        });

        setStatus('Please confirm the form change.');
        return;
      }

      setStatus('Unsupported AI action.');
    } catch (error) {
      console.error(error);
      setStatus('Error connecting to Claude. Check console.');
    }
  }

  async function handleConfirmNavigation() {
    if (!selectedLink) return;

    setStatus('Opening link...');

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id !== selectedLink.tabId) {
        setStatus('Tab changed. Please try again.');
        setSelectedLink(null);
        return;
      }

      const result = await browser.tabs.sendMessage(
        selectedLink.tabId,
        {
          type: 'CLICK_SELECTED_LINK',
          elementId: selectedLink.id,
          expectedHref: selectedLink.href,
          confirmed: true,
        }
      );

      setStatus(
        result.success
          ? 'Link opened!'
          : result.error || 'Navigation failed.'
      );

      setSelectedLink(null);
    } catch (error) {
      console.error(error);
      setStatus('Navigation failed.');
      setSelectedLink(null);
    }
  }

  async function handleConfirmForm() {
    if (!pendingForm) return;

    setStatus('Updating form...');

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id !== pendingForm.tabId) {
        setStatus('Tab changed. Please try again.');
        setPendingForm(null);
        return;
      }

      const result = await browser.tabs.sendMessage(
        pendingForm.tabId,
        {
          type: 'SET_FORM_CONTROL',
          elementId: pendingForm.id,
          value: pendingForm.value,
          confirmed: true,
        }
      );

      setStatus(
        result.success
          ? `Updated: ${pendingForm.text}`
          : result.error || 'Form update failed.'
      );

      setPendingForm(null);
    } catch (error) {
      console.error(error);
      setStatus('Form update failed.');
      setPendingForm(null);
    }
  }

  // spoken feedback with the browser's built-in voice, only in voice mode
  function say(text: string) {
    if (!text || !voiceActiveRef.current || !('speechSynthesis' in window)) {
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text.slice(0, 400));
    speakingRef.current = true;
    lastSpokenRef.current = text.toLowerCase();

    // keep ignoring the mic a moment longer, the echo arrives late
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      setTimeout(() => {
        speakingRef.current = false;
      }, 700);
    };

    utterance.onend = done;
    utterance.onerror = done;
    // in case the browser never reports the end
    setTimeout(done, 2000 + text.length * 80);

    window.speechSynthesis.speak(utterance);
  }

  function stopAgent() {
    agentStopRef.current = true;
    setAgentProgress('Stopping...');
    // also end a pending approval or request right away
    approvalResolveRef.current?.(false);
    agentAbortRef.current?.abort();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  function stopVoice() {
    voiceActiveRef.current = false;

    recognitionRef.current?.stop();
    recognitionRef.current = null;

    setListening(false);
    setStatus('Voice mode off.');
  }

  async function handleVoice() {
    if (voiceActiveRef.current) {
      stopVoice();
      return;
    }

    let permission: PermissionStatus;

    try {
      permission = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
    } catch (error) {
      // no permissions API, just try it
      console.error(error);
      startListening();
      return;
    }

    if (permission.state === 'granted') {
      startListening();
      return;
    }

    if (permission.state === 'denied') {
      setStatus(
        'Microphone is blocked for Access OS. Open the setup tab, click the icon left of the address bar, set Microphone to Allow, then press Start Listening again.'
      );
      return;
    }

    // chrome won't show the mic prompt in a popup/side panel, so it has to
    // happen in a normal tab
    setStatus(
      'Microphone permission is needed. Click "Enable Microphone" in the setup tab that just opened.'
    );

    if (permissionWatchRef.current) {
      permissionWatchRef.current.onchange = null;
    }
    permissionWatchRef.current = permission;

    permission.onchange = () => {
      if (permission.state === 'granted') {
        permission.onchange = null;
        permissionWatchRef.current = null;
        startListening();
      } else if (permission.state === 'denied') {
        permission.onchange = null;
        permissionWatchRef.current = null;
        setStatus(
          'Microphone access was blocked. Voice mode needs it, but typed commands still work.'
        );
      }
    };

    try {
      const setupUrl = browser.runtime.getURL('/mic-permission.html');

      // don't open a second setup tab if one is already open
      const [existing] = await browser.runtime.getContexts({
        contextTypes: [browser.runtime.ContextType.TAB],
        documentUrls: [setupUrl],
      });

      if (existing && existing.tabId !== -1) {
        await browser.tabs.update(existing.tabId, { active: true });
        await browser.windows.update(existing.windowId, {
          focused: true,
        });
      } else {
        await browser.tabs.create({ url: setupUrl });
      }
    } catch (error) {
      console.error(error);
      setStatus('Could not open the microphone setup page.');
    }
  }

  function startListening() {
    const speechWindow = window as Window & {
      SpeechRecognition?: new () => SpeechRecognizer;
      webkitSpeechRecognition?: new () => SpeechRecognizer;
    };

    const Recognition =
      speechWindow.SpeechRecognition ||
      speechWindow.webkitSpeechRecognition;

    if (!Recognition) {
      setStatus('Speech recognition is not supported.');
      return;
    }

    const recognition = new Recognition();

    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        const result = event.results[i];

        if (!result?.isFinal) continue;

        const transcript = result[0]?.transcript?.trim();

        if (!transcript) continue;

        const spoken = transcript
          .toLowerCase()
          .replace(/[.!?]+$/, '');

        const actions = latestActionsRef.current;

        // don't treat our own spoken feedback as a new command
        if (
          speakingRef.current ||
          (spoken.length > 12 && lastSpokenRef.current.includes(spoken))
        ) {
          continue;
        }

        console.log('Voice command:', transcript);

        if (
          [
            'stop listening',
            'turn off voice mode',
            'microphone off',
          ].includes(spoken)
        ) {
          stopVoice();
          return;
        }

        // while the agent runs, voice only answers its prompts or stops it
        if (agentRunningRef.current) {
          if (['stop', 'stop agent', 'stop the agent', 'cancel task'].includes(spoken)) {
            actions.stopAgent();
            setStatus('Agent stopped by voice.');
            continue;
          }

          if (approvalResolveRef.current) {
            if (['yes', 'yes please', 'allow', 'confirm', 'go ahead', 'share', 'ok', 'okay'].includes(spoken)) {
              approvalResolveRef.current(true);
              continue;
            }

            if (['no', 'no thanks', 'cancel', 'deny', "don't share", 'do not share'].includes(spoken)) {
              approvalResolveRef.current(false);
              continue;
            }
          }

          setStatus('The agent is working. Say "stop" to cancel it.');
          continue;
        }

        if (
          ['confirm', 'yes', 'go ahead'].includes(spoken)
        ) {
          if (actions.pendingForm) {
            void actions.confirmForm();
          } else if (actions.selectedLink) {
            void actions.confirmNavigation();
          } else {
            setStatus('Nothing to confirm yet.');
          }

          continue;
        }

        if (
          ['cancel', 'no', 'stop'].includes(spoken)
        ) {
          setPendingForm(null);
          setSelectedLink(null);
          setStatus('Action canceled.');
          continue;
        }

        // a whole task ("find me the cheapest flight...") starts Agent Mode
        if (AGENT_VOICE_GOAL.test(spoken)) {
          const goalText = transcript.replace(/^agent[,:]?\s*/i, '');
          setAgentGoal(goalText);
          setSelectedLink(null);
          setPendingForm(null);
          setStatus('Starting Agent Mode from your voice command.');
          void actions.runAgent(goalText);
          continue;
        }

        setCommand(transcript);
        setSelectedLink(null);
        setPendingForm(null);

        void handleAskClaude(transcript);
      }
    };

    recognition.onerror = (event) => {
      if (!voiceActiveRef.current) return;

      // chrome fires no-speech a lot in continuous mode
      if (event.error === 'no-speech') return;

      voiceActiveRef.current = false;
      recognitionRef.current = null;

      setListening(false);

      if (event.error === 'not-allowed') {
        setStatus(
          'Microphone permission denied. Press Start Listening to set it up.'
        );
      } else if (event.error === 'audio-capture') {
        setStatus('No microphone was found. Check your audio input.');
      } else if (event.error === 'service-not-allowed') {
        setStatus('Chrome speech recognition service is unavailable.');
      } else if (event.error === 'network') {
        setStatus(
          'Speech recognition network error. Check your connection.'
        );
      } else {
        setStatus(`Speech recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      // chrome ends recognition on its own sometimes, so restart it
      if (voiceActiveRef.current) {
        try {
          recognition.start();
        } catch (error) {
          console.error(error);

          voiceActiveRef.current = false;
          recognitionRef.current = null;

          setListening(false);
          setStatus(
            'Listening stopped. Start Voice Mode again.'
          );
        }
      } else {
        setListening(false);
      }
    };

    try {
      recognitionRef.current = recognition;
      voiceActiveRef.current = true;

      recognition.start();

      setListening(true);
      setStatus('Voice mode active. Speak a command.');
    } catch (error) {
      console.error(error);

      voiceActiveRef.current = false;
      recognitionRef.current = null;

      setListening(false);
      setStatus('Could not start microphone.');
    }
  }

  // read-only: reads the page text and asks Claude about it, never acts on the page
  async function handleAnalyzePage() {
    if (analyzing) return;

    if (!pageQuestion.trim()) {
      setPageError('Please enter a question first.');
      return;
    }

    setAnalyzing(true);
    setPageError('');
    setPageAnswer(null);
    setPageText('');

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
        throw new Error('Page analysis only works on normal web pages.');
      }

      const page = await browser.tabs.sendMessage(tab.id, {
        type: 'GET_PAGE_CONTENT',
      });

      setPageText(page.content);

      const response = await fetch(
        'http://127.0.0.1:3001/page/analyze',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: pageQuestion.trim(),
            title: page.title,
            url: page.url,
            content: page.content,
            truncated: page.truncated,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `Backend error: ${response.status}`);
      }

      setPageAnswer({
        answer: result.answer,
        evidence: result.evidence ?? [],
        truncated: page.truncated,
      });
    } catch (error) {
      console.error(error);
      setPageError(
        error instanceof Error ? error.message : 'Could not analyze the page.'
      );
    } finally {
      setAnalyzing(false);
    }
  }

  // preview only for now - shows what the agent would do, never runs it
  async function handlePreviewNextStep() {
    if (agentLoading) return;

    if (!agentGoal.trim()) {
      setAgentPreview({
        action: 'error',
        message: 'Please enter a goal first.',
      });
      return;
    }

    setAgentLoading(true);
    setAgentPreview(null);

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        throw new Error('No active tab found');
      }

      // blank tabs and browser pages have nothing to scan
      let elements: PageElement[] = [];

      if (/^https?:\/\//i.test(tab.url ?? '')) {
        const pageData = await browser.tabs.sendMessage(tab.id, {
          type: 'GET_PAGE_ELEMENTS',
        });
        elements = pageData.elements as PageElement[];
      }

      const response = await fetch(
        'http://127.0.0.1:3001/agent/next',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            goal: agentGoal.trim(),
            url: tab.url ?? '',
            elements,
            history: [],
            sites: useDemoSite ? ['skyfinder_demo'] : ['google_flights'],
            today: new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }),
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `Backend error: ${response.status}`);
      }

      const target = elements.find(
        (element) => element.id === result.elementId
      );

      let value: string | undefined;

      if (typeof result.value === 'boolean') {
        value = result.value ? 'Check / select' : 'Uncheck';
      } else if (typeof result.value === 'string') {
        value = result.value;
      }

      setAgentPreview({
        action: result.action,
        target: result.action === 'open_site' ? result.site : target?.text,
        value,
        message: result.message || '',
      });
    } catch (error) {
      console.error(error);

      setAgentPreview({
        action: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not preview the next step.',
      });
    } finally {
      setAgentLoading(false);
    }
  }

  // the agent loop: scans the page, asks Claude for one next step, checks it,
  // shows it with the cursor, does it, verifies it, and repeats. ends when
  // Claude says done/ask/none, an answer is found, something fails, the user
  // stops it, or a limit is hit
  async function handleRunAgent(goalText = agentGoal) {
    if (agentRunningRef.current || agentLoading) return;

    const goal = goalText.trim();

    if (!goal) {
      setAgentResult('Please enter a goal first.');
      return;
    }

    agentRunningRef.current = true;
    agentStopRef.current = false;
    setAgentRunning(true);
    setAgentPreview(null);
    setAgentSteps([]);
    setAgentAnswer(null);
    setAgentResult('');
    setAgentProgress('Starting...');

    const history: AgentHistoryStep[] = [];
    const enabledSites = useDemoSite ? ['skyfinder_demo'] : ['google_flights'];
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    let finalMessage = '';
    let spokenAnswer = '';

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        throw new Error('No active tab found.');
      }

      const tabId = tab.id;

      // the page we expect to be on. only changes when the agent itself
      // navigates. blank tabs and browser pages have no readable URL ('')
      let expectedUrl = tab.url ?? '';
      let navigations = 0;
      let siteChanges = 0;
      let waits = 0;
      let analyses = 0;
      // Claude's answer can be rejected by the backend's checks (like picking
      // a control that can't be pressed). it gets a few chances to pick again
      let rejections = 0;
      let lastError = '';

      const checkActiveTab = async () => {
        if (agentStopRef.current) throw new Error('Stopped by user.');

        const [current] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });

        if (agentStopRef.current) throw new Error('Stopped by user.');

        if (current?.id !== tabId) {
          throw new Error('You switched tabs, so the agent stopped.');
        }

        return current;
      };

      // throws if the user hit Stop or the tab/page changed under us
      const checkStillOk = async () => {
        const current = await checkActiveTab();

        if ((current.url ?? '') !== expectedUrl) {
          throw new Error('The tab or page changed, so the agent stopped.');
        }
      };

      // wait for a new page and its content script, bounded by a timeout
      const waitForPage = async (previousUrl: string) => {
        setAgentProgress('Waiting for the page to load...');
        const deadline = Date.now() + PAGE_LOAD_TIMEOUT;

        while (Date.now() < deadline) {
          await sleep(250);
          const current = await checkActiveTab();

          if (
            current.status !== 'complete' ||
            !current.url ||
            current.url === previousUrl
          ) {
            continue;
          }

          try {
            await browser.tabs.sendMessage(tabId, { type: 'GET_PAGE_ELEMENTS' });
            return current.url;
          } catch {
            // content script isn't ready yet
          }
        }

        throw new Error('The page took too long to load. Stopped.');
      };

      // asks the user before going to another website. resolves true/false,
      // or throws if they pressed Stop
      const askToOpen = async (label: string, destination: URL) => {
        const allowed = await new Promise<boolean>((resolve) => {
          approvalResolveRef.current = resolve;
          setNavApproval({
            label,
            url: destination.href,
            origin: destination.origin,
          });
          say(`I'd like to open ${label}. Say yes to allow, or no to cancel.`);
        });

        approvalResolveRef.current = null;
        setNavApproval(null);

        if (agentStopRef.current) throw new Error('Stopped by user.');
        return allowed;
      };

      // our own press or typing can change the URL (a search running, or a
      // single-page app updating its address). same site is fine, anything
      // else stops the run
      const adoptUrlChange = async () => {
        await sleep(800);
        const current = await checkActiveTab();
        const nowUrl = current.url ?? '';

        if (nowUrl === expectedUrl && current.status === 'complete') return;

        const loadedUrl =
          current.status === 'complete' && nowUrl
            ? nowUrl
            : await waitForPage(expectedUrl);

        const before = new URL(expectedUrl);
        const after = new URL(loadedUrl);

        if (after.origin !== before.origin) {
          throw new Error(
            `The page unexpectedly went to another website (${after.host}), so the agent stopped.`
          );
        }

        if (after.pathname !== before.pathname) {
          if (navigations >= AGENT_MAX_NAVIGATIONS) {
            throw new Error(
              `Stopped at the ${AGENT_MAX_NAVIGATIONS}-page navigation limit.`
            );
          }
          navigations++;
          setAgentSteps((steps) => [...steps, `Page changed → ${after.pathname}`]);
        }

        expectedUrl = loadedUrl;
      };

      for (let step = 1; ; step++) {
        if (step > AGENT_MAX_ROUNDS) {
          throw new Error('The agent took too many rounds without finishing. Stopped.');
        }

        if (history.length >= AGENT_MAX_STEPS) {
          finalMessage = `Stopped at the ${AGENT_MAX_STEPS}-step safety limit. Check the rest yourself.`;
          break;
        }

        await checkStillOk();

        // blank tabs and browser pages have no content script, so there's
        // nothing to scan. the agent can still open an allowed website
        let elements: PageElement[] = [];

        if (/^https?:\/\//i.test(expectedUrl)) {
          setAgentProgress(`Step ${step}: scanning the page...`);

          const pageData = await browser.tabs.sendMessage(tabId, {
            type: 'GET_PAGE_ELEMENTS',
          });
          await checkStillOk();

          // results still loading? wait instead of asking Claude
          if (pageData.busy && waits < AGENT_MAX_WAITS) {
            waits++;
            setAgentProgress(`Step ${step}: waiting for the page to finish loading...`);
            await sleep(1500);
            continue;
          }

          elements = pageData.elements as PageElement[];
        }

        setAgentProgress(`Step ${step}: asking Claude what to do next...`);

        agentAbortRef.current = new AbortController();

        const response = await fetch(
          'http://127.0.0.1:3001/agent/next',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: agentAbortRef.current.signal,
            body: JSON.stringify({
              goal,
              url: expectedUrl,
              elements,
              history,
              sites: enabledSites,
              today,
              lastError,
            }),
          }
        );

        const result = await response.json();
        agentAbortRef.current = null;
        await checkStillOk();

        // 422: the backend rejected Claude's choice. 502: Claude gave no
        // usable answer. either way, ask again a limited number of times
        if (
          (response.status === 422 || response.status === 502) &&
          rejections < AGENT_MAX_REJECTIONS
        ) {
          rejections++;
          lastError = result.error || 'invalid step';
          setAgentProgress(`Step ${step}: Claude's choice was rejected (${lastError}), asking again...`);
          continue;
        }

        lastError = '';

        if (!response.ok) {
          throw new Error(result.error || `Backend error: ${response.status}`);
        }

        if (result.action === 'done') {
          finalMessage = `Done: ${result.message}`;
          break;
        }

        if (result.action === 'ask') {
          finalMessage = `Claude needs more info: ${result.message}`;
          break;
        }

        if (result.action === 'none') {
          finalMessage = `Stopped: ${result.message}`;
          break;
        }

        if (result.action === 'wait') {
          if (waits >= AGENT_MAX_WAITS) {
            throw new Error('The page kept loading for too long. Stopped.');
          }

          waits++;
          setAgentProgress(`Step ${step}: waiting - ${result.message}`);
          await sleep(2000);
          continue;
        }

        // open a website from the allowlist. Claude only picks the ID; the
        // URL comes from KNOWN_SITES here
        if (result.action === 'open_site') {
          const site = KNOWN_SITES[result.site as string];

          if (!site || !enabledSites.includes(result.site)) {
            throw new Error('Claude picked a website that is not allowed. Stopped.');
          }

          if (siteChanges >= AGENT_MAX_SITE_CHANGES) {
            throw new Error('The agent can only change websites once per run. Stopped.');
          }

          if (navigations >= AGENT_MAX_NAVIGATIONS) {
            throw new Error(
              `Stopped at the ${AGENT_MAX_NAVIGATIONS}-page navigation limit.`
            );
          }

          const destination = new URL(site.url);

          setAgentProgress(`Step ${step}: waiting for you to allow opening ${site.name}...`);

          if (!(await askToOpen(site.name, destination))) {
            finalMessage = `Canceled: the agent did not open ${site.name}.`;
            break;
          }

          await checkStillOk();

          const previousUrl = expectedUrl;
          await browser.tabs.update(tabId, { url: destination.href });
          const loadedUrl = await waitForPage(previousUrl);

          if (new URL(loadedUrl).origin !== destination.origin) {
            throw new Error(
              `${site.name} redirected to an unexpected website (${new URL(loadedUrl).host}), so the agent stopped.`
            );
          }

          expectedUrl = loadedUrl;
          navigations++;
          siteChanges++;

          history.push({
            action: 'open_site',
            elementId: 0,
            text: site.name,
            value: loadedUrl,
            success: true,
          });

          setAgentSteps((steps) => [
            ...steps,
            `Opened ${site.name} (approved by you)`,
          ]);

          continue;
        }

        // read-only: get the page text, ask before sharing it, then answer
        if (result.action === 'analyze') {
          if (analyses >= AGENT_MAX_ANALYSES) {
            throw new Error('The agent already read the page twice without an answer. Stopped.');
          }

          setAgentProgress(`Step ${step}: reading the page...`);

          const page = await browser.tabs.sendMessage(tabId, {
            type: 'GET_PAGE_CONTENT',
          });
          await checkStillOk();

          if (!page?.content?.trim()) {
            finalMessage = 'Stopped: there is no readable text on this page.';
            break;
          }

          setAgentProgress(
            `Step ${step}: waiting for you to approve sharing the page text...`
          );

          const approved = await new Promise<boolean>((resolve) => {
            approvalResolveRef.current = resolve;
            setAgentApproval({
              preview: page.content.slice(0, 600),
              length: page.content.length,
              truncated: page.truncated,
            });
            say(
              'I need to read this page to answer. Can I share its text with Claude? Say yes or no.'
            );
          });

          approvalResolveRef.current = null;
          setAgentApproval(null);

          if (agentStopRef.current) throw new Error('Stopped by user.');

          if (!approved) {
            finalMessage =
              'You chose not to share the page text, so nothing was sent. Stopped.';
            break;
          }

          // the page must still be the one the user approved
          await checkStillOk();

          setAgentProgress(`Step ${step}: asking Claude about the page...`);

          agentAbortRef.current = new AbortController();

          const analyzeResponse = await fetch(
            'http://127.0.0.1:3001/page/analyze',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: agentAbortRef.current.signal,
              body: JSON.stringify({
                question: goal,
                title: page.title,
                url: page.url,
                content: page.content,
                truncated: page.truncated,
                mode: 'agent',
                today,
              }),
            }
          );

          const analysis = await analyzeResponse.json();
          agentAbortRef.current = null;
          await checkStillOk();

          if (!analyzeResponse.ok) {
            throw new Error(
              analysis.error || `Backend error: ${analyzeResponse.status}`
            );
          }

          analyses++;

          // no results yet: note it for Claude and keep going
          if (analysis.status === 'not_ready' && analyses < AGENT_MAX_ANALYSES) {
            history.push({
              action: 'analyze',
              elementId: 0,
              text: 'Read the page',
              value: `Results weren't ready: ${analysis.answer}`,
              success: true,
            });
            setAgentSteps((steps) => [
              ...steps,
              'Read the page: no results yet, continuing',
            ]);
            continue;
          }

          setAgentAnswer({
            answer: analysis.answer,
            evidence: analysis.evidence ?? [],
            truncated: page.truncated,
            best: analysis.best,
            sourceUrl: page.url,
          });

          setAgentSteps((steps) => [...steps, 'Read the page and answered']);
          spokenAnswer = analysis.answer;

          if (analysis.status === 'needs_user') {
            finalMessage = 'Claude needs your input to continue (see the answer above).';
          } else if (analysis.status === 'not_ready') {
            finalMessage = 'Stopped: the page still had no usable results.';
          } else {
            finalMessage = page.truncated
              ? 'Done, but the page was long and only part of it was read, so the answer may be incomplete.'
              : 'Done: answered from this page.';
          }
          break;
        }

        if (!['set', 'click', 'press'].includes(result.action)) {
          throw new Error('Claude returned an unsupported action. Stopped.');
        }

        const target = elements.find(
          (element) => element.id === result.elementId
        );

        if (!target) {
          throw new Error('Claude picked an element that is not on the page.');
        }

        // buttons, options, tabs and date cells. checked here, again in the
        // content script right before the click
        if (result.action === 'press') {
          // clicking a plain text or date field is fine too (it often opens a picker)
          const clickableField =
            target.role === 'input' &&
            ['text', 'search', 'date'].includes(target.inputType ?? '');

          if (!PRESSABLE_ROLES.includes(target.role) && !clickableField) {
            throw new Error(`"${target.text}" isn't something the agent can press. Stopped.`);
          }

          if (RISKY_PRESS.test(target.text) || SENSITIVE_FIELD.test(target.text)) {
            throw new Error(
              `"${target.text}" looks like it could buy, book, sign in or send something, so the agent won't press it.`
            );
          }

          setAgentProgress(`Step ${step}: pressing "${target.text}"`);

          const highlight = await browser.tabs.sendMessage(tabId, {
            type: 'HIGHLIGHT_ELEMENT',
            elementId: target.id,
            expectedText: target.text,
          });
          await checkStillOk();

          if (!highlight?.success) {
            throw new Error(`"${target.text}" changed or disappeared. Stopped.`);
          }

          await sleep(700);
          await checkStillOk();

          const pressed = await browser.tabs.sendMessage(tabId, {
            type: 'PRESS_ELEMENT',
            elementId: target.id,
            expectedText: target.text,
          });

          if (!pressed?.success) {
            throw new Error(
              `Could not press "${target.text}": ${pressed?.error ?? 'unknown error'}. Stopped.`
            );
          }

          history.push({
            action: 'press',
            elementId: target.id,
            text: target.text,
            value: '',
            success: true,
          });

          setAgentSteps((steps) => [...steps, `Pressed "${target.text}"`]);

          await adoptUrlChange();
          continue;
        }

        if (result.action === 'click') {
          if (navigations >= AGENT_MAX_NAVIGATIONS) {
            throw new Error(
              `Stopped at the ${AGENT_MAX_NAVIGATIONS}-page navigation limit.`
            );
          }

          // check the link ourselves, don't just trust that Claude picked a safe one
          if (target.role !== 'link' || !target.href) {
            throw new Error(`"${target.text}" is not a normal link. Stopped.`);
          }

          let destination: URL;

          try {
            destination = new URL(target.href);
          } catch {
            throw new Error(`"${target.text}" has an invalid address. Stopped.`);
          }

          if (!['http:', 'https:'].includes(destination.protocol)) {
            throw new Error(`"${target.text}" is not a web link. Stopped.`);
          }

          // links on the current site are followed automatically, anything
          // else needs the user's ok first
          const currentOrigin = new URL(expectedUrl).origin;
          const leavingSite = destination.origin !== currentOrigin;

          if (leavingSite) {
            if (siteChanges >= AGENT_MAX_SITE_CHANGES) {
              throw new Error(
                `"${target.text}" leads to another website, but the agent can only change websites once per run. Stopped.`
              );
            }

            if (
              destination.protocol !== 'https:' &&
              !LOCAL_HOST.test(destination.hostname)
            ) {
              throw new Error(
                `"${target.text}" leads to another website without HTTPS (${destination.host}), so the agent won't follow it.`
              );
            }
          }

          if (
            RISKY_LINK.test(target.text) ||
            RISKY_LINK.test(destination.pathname + destination.search)
          ) {
            throw new Error(
              `"${target.text}" looks like it could log out, buy, delete or submit something, so the agent won't follow it.`
            );
          }

          const fromUrl = new URL(expectedUrl);
          fromUrl.hash = '';
          const toUrl = new URL(destination);
          toUrl.hash = '';

          if (fromUrl.href === toUrl.href) {
            throw new Error(`"${target.text}" points to this same page. Stopped.`);
          }

          if (leavingSite) {
            setAgentProgress(
              `Step ${step}: waiting for you to allow leaving this website...`
            );

            if (!(await askToOpen(target.text, destination))) {
              finalMessage = `Canceled: the agent did not open ${destination.host} and stayed on this page.`;
              break;
            }

            // still the same tab and page the user was looking at?
            await checkStillOk();

            // and the link still points exactly where the user approved
            const recheck = await browser.tabs.sendMessage(tabId, {
              type: 'GET_PAGE_ELEMENTS',
            });
            await checkStillOk();

            const sameLink = (recheck.elements as PageElement[]).find(
              (element) =>
                element.id === target.id &&
                element.role === 'link' &&
                element.href === destination.href
            );

            if (!sameLink) {
              throw new Error(
                'The link changed after you approved it, so the agent stopped.'
              );
            }
          }

          setAgentProgress(`Step ${step}: opening "${target.text}"`);

          const highlight = await browser.tabs.sendMessage(tabId, {
            type: 'HIGHLIGHT_ELEMENT',
            elementId: target.id,
          });
          await checkStillOk();

          if (!highlight?.success) {
            throw new Error(`Could not find "${target.text}" on the page.`);
          }

          await sleep(700);
          await checkStillOk();

          // navigate via the tabs API so the page's own click handlers never run
          const previousUrl = expectedUrl;
          await browser.tabs.update(tabId, { url: destination.href });
          const loadedUrl = await waitForPage(previousUrl);

          // redirects are fine as long as we end up on the site we expected
          // (the approved one, if we just left the old site)
          if (new URL(loadedUrl).origin !== destination.origin) {
            throw new Error(
              `The link redirected to an unexpected website (${new URL(loadedUrl).host}), so the agent stopped.`
            );
          }

          expectedUrl = loadedUrl;
          navigations++;
          if (leavingSite) siteChanges++;

          history.push({
            action: 'click',
            elementId: target.id,
            text: target.text,
            value: loadedUrl,
            success: true,
          });

          setAgentSteps((steps) => [
            ...steps,
            leavingSite
              ? `Opened "${target.text}" → ${new URL(loadedUrl).host}${new URL(loadedUrl).pathname} (new website, approved by you)`
              : `Opened "${target.text}" → ${new URL(loadedUrl).pathname}`,
          ]);

          continue;
        }

        if (
          SENSITIVE_FIELD.test(target.text) ||
          target.inputType === 'password'
        ) {
          throw new Error(`Refused to edit a sensitive field ("${target.text}").`);
        }

        const value = result.value as string | boolean;
        const shownValue =
          typeof value === 'boolean'
            ? value
              ? 'checked / selected'
              : 'unchecked'
            : `"${value}"`;

        // text and search boxes are typed out so the user can follow along
        const typeOut =
          typeof value === 'string' &&
          (target.role === 'textarea' ||
            ['text', 'search', ''].includes(target.inputType ?? ''));

        setAgentProgress(
          `Step ${step}: ${typeOut ? 'typing' : 'setting'} "${target.text}" ${typeOut ? '' : 'to '}${shownValue}`
        );

        const highlight = await browser.tabs.sendMessage(tabId, {
          type: 'HIGHLIGHT_ELEMENT',
          elementId: target.id,
          expectedText: target.text,
        });
        await checkStillOk();

        if (!highlight?.success) {
          throw new Error(`Could not find "${target.text}" on the page.`);
        }

        // let the cursor get there before acting
        await sleep(700);
        await checkStillOk();

        // the user authorized form edits by starting the agent
        const applied = await browser.tabs.sendMessage(tabId, {
          type: 'SET_FORM_CONTROL',
          elementId: target.id,
          expectedText: target.text,
          value,
          typeOut,
          confirmed: true,
        });

        if (!applied?.success) {
          throw new Error(
            `Could not update "${target.text}": ${applied?.error ?? 'unknown error'}`
          );
        }

        // give page scripts a moment, then read the control back
        await sleep(300);

        const state = await browser.tabs.sendMessage(tabId, {
          type: 'GET_CONTROL_STATE',
          elementId: target.id,
        });

        let verified = false;

        if (typeOut && applied.movedTo) {
          // the site moved our typing into a popup field; the content script
          // already read that field back
          verified = String(applied.value)
            .toLowerCase()
            .startsWith(value.toString().toLowerCase());
        } else if (state?.success) {
          if (typeof value === 'boolean') {
            verified = state.checked === value;
          } else if (target.role === 'select') {
            verified =
              state.value === value ||
              state.text?.toLowerCase() === value.toLowerCase();
          } else if (typeOut) {
            // search boxes may fill in the rest themselves ("Detroit" ->
            // "Detroit (DTW)"), so what we typed just has to be there
            verified = String(state.value)
              .toLowerCase()
              .startsWith(value.toLowerCase());
          } else {
            verified = state.value === value;
          }
        }

        if (!verified) {
          throw new Error(
            `Verification failed: "${target.text}" doesn't show the expected value, so the agent stopped.`
          );
        }

        history.push({
          action: 'set',
          elementId: target.id,
          text: target.text,
          value,
          success: true,
        });

        setAgentSteps((steps) => [
          ...steps,
          applied.movedTo
            ? `${target.text} → ${shownValue} (typed into "${applied.movedTo}")`
            : `${target.text} → ${shownValue}`,
        ]);

        await adoptUrlChange();
      }
    } catch (error) {
      console.error(error);

      if (agentStopRef.current) {
        // covers an aborted request too
        finalMessage = 'Stopped by user.';
      } else {
        finalMessage =
          error instanceof Error ? error.message : 'The agent run failed.';
      }
    } finally {
      approvalResolveRef.current = null;
      agentAbortRef.current = null;
      setAgentApproval(null);
      setNavApproval(null);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentProgress('');
      setAgentResult(finalMessage);
      say(spokenAnswer ? `${spokenAnswer} ${finalMessage}` : finalMessage);
    }
  }

  async function handleOpenSidePanel() {
    try {
      const currentWindow = await browser.windows.getCurrent();

      if (currentWindow.id === undefined) {
        setStatus('Could not find the current window.');
        return;
      }

      await browser.sidePanel.open({ windowId: currentWindow.id });
      setStatus('Side panel opened.');
    } catch (error) {
      console.error(error);
      setStatus('Could not open side panel.');
    }
  }

  return (
    <main>
      <h1>Access OS</h1>
      <p>Your AI-powered accessibility assistant.</p>

      <input
        type="text"
        value={command}
        placeholder="What would you like to do?"
        aria-label="Command"
        onChange={(e) => {
          setCommand(e.target.value);
          setSelectedLink(null);
          setPendingForm(null);
        }}
      />

      <button
        type="button"
        onClick={() => void handleVoice()}
        aria-pressed={listening}
      >
        {listening
          ? '🔴 Stop Listening'
          : '🎤 Start Listening'}
      </button>

      <button
        type="button"
        onClick={() => void handleAskClaude()}
      >
        Ask Claude
      </button>

      {!inSidePanel && (
        <button
          type="button"
          onClick={() => void handleOpenSidePanel()}
        >
          Open Side Panel
        </button>
      )}

      <p role="status">Status: {status}</p>

      {selectedLink && (
        <div>
          <h3>Proposed Navigation</h3>

          <p>
            <strong>Link:</strong> {selectedLink.text}
          </p>

          <p style={{ overflowWrap: 'anywhere' }}>
            <strong>Destination:</strong> {selectedLink.href}
          </p>

          <button
            type="button"
            onClick={handleConfirmNavigation}
          >
            Confirm & Open
          </button>

          <button
            type="button"
            onClick={() => {
              setSelectedLink(null);
              setStatus('Navigation canceled.');
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {pendingForm && (
        <div>
          <h3>Proposed Form Change</h3>

          <p>
            <strong>Field:</strong> {pendingForm.text}
          </p>

          <p>
            <strong>Action / Value:</strong>{' '}
            {pendingForm.displayValue}
          </p>

          <button
            type="button"
            onClick={handleConfirmForm}
          >
            Confirm & Apply
          </button>

          <button
            type="button"
            onClick={() => {
              setPendingForm(null);
              setStatus('Form change canceled.');
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <section aria-labelledby="analyze-page-heading">
        <h2 id="analyze-page-heading">Analyze Page</h2>

        <input
          type="text"
          value={pageQuestion}
          placeholder="Ask about this page"
          aria-label="Question about this page"
          onChange={(e) => setPageQuestion(e.target.value)}
        />

        <button
          type="button"
          onClick={() => void handleAnalyzePage()}
          disabled={analyzing}
          aria-describedby="analyze-page-help"
        >
          {analyzing ? 'Analyzing...' : 'Analyze Current Page'}
        </button>

        <p id="analyze-page-help">
          This sends the page's visible text (not form values or passwords) to
          Claude. It only reads the page, it never clicks or changes anything.
        </p>

        <div aria-live="polite">
          {pageError && <p>Error: {pageError}</p>}

          {pageAnswer && (
            <div>
              <p>{pageAnswer.answer}</p>

              {pageAnswer.truncated && (
                <p>Note: the page was long, so only part of it was read.</p>
              )}

              {pageAnswer.evidence.length > 0 && (
                <>
                  <h3>From the page</h3>
                  <ul>
                    {pageAnswer.evidence.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {pageText && (
          <details>
            <summary>Text that was read from the page</summary>
            <pre style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>
              {pageText}
            </pre>
          </details>
        )}
      </section>

      <section aria-labelledby="agent-mode-heading">
        <h2 id="agent-mode-heading">Agent Mode</h2>

        <input
          type="text"
          value={agentGoal}
          placeholder="Describe your overall goal"
          aria-label="Agent goal"
          onChange={(e) => setAgentGoal(e.target.value)}
        />

        <button
          type="button"
          onClick={() => void handlePreviewNextStep()}
          disabled={agentLoading || agentRunning}
        >
          {agentLoading ? 'Thinking...' : 'Preview Next Step'}
        </button>

        <button
          type="button"
          onClick={() => void handleRunAgent()}
          disabled={agentLoading || agentRunning}
          aria-describedby="run-form-task-help"
        >
          Run Agent
        </button>

        <label>
          <input
            type="checkbox"
            checked={useDemoSite}
            onChange={(e) => setUseDemoSite(e.target.checked)}
            disabled={agentRunning}
          />{' '}
          Use the local SkyFinder demo site for flight searches (fictional
          prices) instead of Google Flights
        </label>

        <p id="run-form-task-help">
          Run Agent works toward this goal in the current tab, even a blank
          one. It can open a flight search site, fill in and run searches, and
          read the results. It asks you before opening another website and
          before sharing page text. It never books, buys, signs in, or sends
          anything. In voice mode, just say your goal ("find me the cheapest
          flight...") and answer its questions with "yes", "no" or "stop".
        </p>

        {agentRunning && (
          <>
            <button
              type="button"
              onClick={stopAgent}
            >
              Stop Agent
            </button>
            <p>No new steps will start. A change already underway may finish.</p>
          </>
        )}

        <div aria-live="polite">
          {agentProgress && <p>{agentProgress}</p>}

          {agentSteps.length > 0 && (
            <>
              <h3>Completed steps</h3>
              <ol>
                {agentSteps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </>
          )}

          {navApproval && (
            <div role="group" aria-labelledby="leave-site-heading">
              <h3 id="leave-site-heading">Leave this website?</h3>
              <p>
                The agent wants to go to a different website. This only allows
                this one page, not other websites.
              </p>

              <p>
                <strong>Opening:</strong> {navApproval.label}
              </p>

              <p style={{ overflowWrap: 'anywhere' }}>
                <strong>Destination:</strong> {navApproval.url}
              </p>

              <p style={{ overflowWrap: 'anywhere' }}>
                <strong>Website:</strong> {navApproval.origin}
              </p>

              <button
                type="button"
                onClick={() => approvalResolveRef.current?.(true)}
              >
                Allow Navigation
              </button>

              <button
                type="button"
                onClick={() => approvalResolveRef.current?.(false)}
              >
                Cancel
              </button>
            </div>
          )}

          {agentApproval && (
            <div role="group" aria-labelledby="share-page-heading">
              <h3 id="share-page-heading">Share this page with Claude?</h3>
              <p>
                To answer, Access OS will send this page's visible text (
                {agentApproval.length.toLocaleString()} characters) to Claude.
                Form values and passwords are never included.
                {agentApproval.truncated &&
                  ' The page is long, so only the first part was read.'}
              </p>

              <details>
                <summary>Preview the page text</summary>
                <pre style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>
                  {agentApproval.preview}
                  {agentApproval.length > agentApproval.preview.length &&
                    '\n...'}
                </pre>
              </details>

              <button
                type="button"
                onClick={() => approvalResolveRef.current?.(true)}
              >
                Share and Analyze
              </button>

              <button
                type="button"
                onClick={() => approvalResolveRef.current?.(false)}
              >
                Don't Share
              </button>
            </div>
          )}

          {agentAnswer && (
            <div>
              <h3>Answer</h3>
              <p>{agentAnswer.answer}</p>

              {agentAnswer.best && (
                <>
                  <h4>Best match</h4>
                  <dl>
                    {Object.entries(agentAnswer.best).map(([key, value]) => (
                      <div key={key}>
                        <dt>{BEST_LABELS[key] ?? key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}

              {agentAnswer.sourceUrl && (
                <p style={{ overflowWrap: 'anywhere' }}>
                  <strong>Source:</strong> {agentAnswer.sourceUrl}
                </p>
              )}

              {agentAnswer.truncated && (
                <p>
                  Note: only part of the page was read, so this may not cover
                  everything on it.
                </p>
              )}

              {agentAnswer.evidence.length > 0 && (
                <>
                  <h4>From the page</h4>
                  <ul>
                    {agentAnswer.evidence.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {agentResult && <p>{agentResult}</p>}
        </div>

        <div aria-live="polite">
          {agentPreview?.action === 'error' && (
            <p>Error: {agentPreview.message}</p>
          )}

          {agentPreview && agentPreview.action !== 'error' && (
            <div>
              <h3>
                {agentPreview.action === 'done' && 'All done'}
                {agentPreview.action === 'ask' && 'Claude needs more info'}
                {agentPreview.action === 'none' && 'Nothing to do here'}
                {agentPreview.action === 'analyze' &&
                  'Next step: read this page to answer'}
                {agentPreview.action === 'open_site' &&
                  `Next step: open ${KNOWN_SITES[agentPreview.target ?? '']?.name ?? 'a website'} (would ask you first)`}
                {agentPreview.action === 'wait' && 'Next step: wait for the page'}
                {['set', 'click', 'press'].includes(agentPreview.action) &&
                  'Proposed next step (preview only)'}
              </h3>

              {['set', 'click', 'press'].includes(agentPreview.action) && (
                <>
                  <p>
                    <strong>Action:</strong>{' '}
                    {agentPreview.action === 'set' && 'Change form field'}
                    {agentPreview.action === 'click' && 'Open link'}
                    {agentPreview.action === 'press' && 'Press button or option'}
                  </p>

                  <p>
                    <strong>Target:</strong>{' '}
                    {agentPreview.target ?? 'Unknown element'}
                  </p>

                  {agentPreview.value !== undefined && (
                    <p style={{ overflowWrap: 'anywhere' }}>
                      <strong>Value:</strong> {agentPreview.value}
                    </p>
                  )}
                </>
              )}

              {agentPreview.message && <p>{agentPreview.message}</p>}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export default App;
