
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

const AGENT_MAX_STEPS = 5;
const AGENT_MAX_NAVIGATIONS = 2;
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
  action: 'set' | 'click';
  elementId: number;
  text: string;
  value: string | boolean;
  success: true;
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

  // recognition callbacks would otherwise see stale state
  const latestActionsRef = useRef({
    pendingForm,
    selectedLink,
    confirmForm: handleConfirmForm,
    confirmNavigation: handleConfirmNavigation,
  });

  useEffect(() => {
    latestActionsRef.current = {
      pendingForm,
      selectedLink,
      confirmForm: handleConfirmForm,
      confirmNavigation: handleConfirmNavigation,
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

      const pageData = await browser.tabs.sendMessage(tab.id, {
        type: 'GET_PAGE_ELEMENTS',
      });

      const elements = pageData.elements as PageElement[];

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
        target: target?.text,
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

  // runs set actions and same-site link navigation in one tab, until Claude
  // says done/ask/none, something fails, the user stops it, or we hit the limit
  async function handleRunAgent() {
    if (agentRunningRef.current || agentLoading) return;

    const goal = agentGoal.trim();

    if (!goal) {
      setAgentResult('Please enter a goal first.');
      return;
    }

    agentRunningRef.current = true;
    agentStopRef.current = false;
    setAgentRunning(true);
    setAgentPreview(null);
    setAgentSteps([]);
    setAgentResult('');
    setAgentProgress('Starting...');

    const history: AgentHistoryStep[] = [];
    let finalMessage = '';

    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id || !tab.url) {
        throw new Error('No active tab found.');
      }

      const tabId = tab.id;
      const startOrigin = new URL(tab.url).origin;

      // the page we expect to be on. only changes when the agent itself navigates
      let expectedUrl = tab.url;
      let navigations = 0;

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

        if (current.url !== expectedUrl) {
          throw new Error('The tab or page changed, so the agent stopped.');
        }
      };

      for (let step = 1; ; step++) {
        if (history.length >= AGENT_MAX_STEPS) {
          finalMessage = `Stopped at the ${AGENT_MAX_STEPS}-step safety limit. Check the rest yourself.`;
          break;
        }

        await checkStillOk();
        setAgentProgress(`Step ${step}: scanning the page...`);

        const pageData = await browser.tabs.sendMessage(tabId, {
          type: 'GET_PAGE_ELEMENTS',
        });
        await checkStillOk();

        const elements = pageData.elements as PageElement[];

        setAgentProgress(`Step ${step}: asking Claude what to do next...`);

        const response = await fetch(
          'http://127.0.0.1:3001/agent/next',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              goal,
              url: expectedUrl,
              elements,
              history,
            }),
          }
        );

        const result = await response.json();
        await checkStillOk();

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

        if (result.action !== 'set' && result.action !== 'click') {
          throw new Error('Claude returned an unsupported action. Stopped.');
        }

        const target = elements.find(
          (element) => element.id === result.elementId
        );

        if (!target) {
          throw new Error('Claude picked an element that is not on the page.');
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

          if (destination.origin !== startOrigin) {
            throw new Error(
              `"${target.text}" leads to another website (${destination.host}). The agent only follows links on the same site for now.`
            );
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

          setAgentProgress(`Step ${step}: waiting for the page to load...`);

          // wait for the new page and its content script, bounded by a timeout
          const deadline = Date.now() + PAGE_LOAD_TIMEOUT;
          let loadedUrl = '';

          while (!loadedUrl) {
            if (Date.now() > deadline) {
              throw new Error('The next page took too long to load. Stopped.');
            }

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
              await browser.tabs.sendMessage(tabId, {
                type: 'GET_PAGE_ELEMENTS',
              });
              loadedUrl = current.url;
            } catch {
              // content script isn't ready yet
            }
          }

          // redirects are fine as long as we stay on the same site
          if (new URL(loadedUrl).origin !== startOrigin) {
            throw new Error(
              'The link redirected to another website, so the agent stopped.'
            );
          }

          expectedUrl = loadedUrl;
          navigations++;

          history.push({
            action: 'click',
            elementId: target.id,
            text: target.text,
            value: loadedUrl,
            success: true,
          });

          setAgentSteps((steps) => [
            ...steps,
            `Opened "${target.text}" → ${new URL(loadedUrl).pathname}`,
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

        setAgentProgress(
          `Step ${step}: setting "${target.text}" to ${shownValue}`
        );

        const highlight = await browser.tabs.sendMessage(tabId, {
          type: 'HIGHLIGHT_ELEMENT',
          elementId: target.id,
        });
        await checkStillOk();

        if (!highlight?.success) {
          throw new Error(`Could not find "${target.text}" on the page.`);
        }

        // let the cursor get there before acting
        await sleep(700);
        await checkStillOk();

        // the user authorized form edits by pressing Run Form Task
        const applied = await browser.tabs.sendMessage(tabId, {
          type: 'SET_FORM_CONTROL',
          elementId: target.id,
          value,
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

        if (state?.success) {
          if (typeof value === 'boolean') {
            verified = state.checked === value;
          } else if (target.role === 'select') {
            verified =
              state.value === value ||
              state.text?.toLowerCase() === value.toLowerCase();
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
          `${target.text} → ${shownValue}`,
        ]);

        await sleep(300);
      }
    } catch (error) {
      console.error(error);
      finalMessage =
        error instanceof Error ? error.message : 'The agent run failed.';
    } finally {
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentProgress('');
      setAgentResult(finalMessage);
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

        <p id="run-form-task-help">
          Run Agent works toward this goal in the current tab. It can fill in
          form fields and follow links within the same website (up to 2
          pages). It never clicks buttons, submits forms, or leaves the site.
        </p>

        {agentRunning && (
          <>
            <button
              type="button"
              onClick={() => {
                agentStopRef.current = true;
                setAgentProgress('Stopping...');
              }}
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
                {['set', 'click'].includes(agentPreview.action) &&
                  'Proposed next step (preview only)'}
              </h3>

              {['set', 'click'].includes(agentPreview.action) && (
                <>
                  <p>
                    <strong>Action:</strong>{' '}
                    {agentPreview.action === 'set'
                      ? 'Change form field'
                      : 'Open link'}
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
