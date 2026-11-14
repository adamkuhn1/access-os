
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

function App() {
  const [status, setStatus] = useState('Ready');
  const [command, setCommand] = useState('');
  const [listening, setListening] = useState(false);

  const [selectedLink, setSelectedLink] =
    useState<SelectedLink | null>(null);

  const [pendingForm, setPendingForm] =
    useState<PendingFormControl | null>(null);

  // Voice mode references
  const voiceActiveRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognizer | null>(null);

  // Keep the latest proposed actions available to voice mode
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

  // Clean up the microphone if the popup closes
  useEffect(() => {
    return () => {
      voiceActiveRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  // --------------------------------------------------
  // 1. ASK CLAUDE
  // --------------------------------------------------

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

      // Navigation
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

      // Universal Form Engine
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

  // --------------------------------------------------
  // 2. CONFIRM NAVIGATION
  // --------------------------------------------------

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

  // --------------------------------------------------
  // 3. CONFIRM FORM CHANGE
  // --------------------------------------------------

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

  // --------------------------------------------------
  // 4. STOP VOICE MODE
  // --------------------------------------------------

  function stopVoice() {
    voiceActiveRef.current = false;

    recognitionRef.current?.stop();
    recognitionRef.current = null;

    setListening(false);
    setStatus('Voice mode off.');
  }

  // --------------------------------------------------
  // 5. CONTINUOUS VOICE MODE
  // --------------------------------------------------

  function handleVoice() {
    // Toggle voice mode off
    if (voiceActiveRef.current) {
      stopVoice();
      return;
    }

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

    // Process each completed spoken phrase
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

        // Stop listening by voice
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

        // Confirm a proposed action
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

        // Cancel a proposed action
        if (
          ['cancel', 'no', 'stop'].includes(spoken)
        ) {
          setPendingForm(null);
          setSelectedLink(null);
          setStatus('Action canceled.');
          continue;
        }

        // Otherwise, send a new command to Claude
        setCommand(transcript);
        setSelectedLink(null);
        setPendingForm(null);

        void handleAskClaude(transcript);
      }
    };

    recognition.onerror = (event) => {
      if (!voiceActiveRef.current) return;

      // Chrome may report silence in continuous mode.
      if (event.error === 'no-speech') return;

      voiceActiveRef.current = false;
      recognitionRef.current = null;

      setListening(false);
      setStatus(`Microphone error: ${event.error}`);
    };

    recognition.onend = () => {
      // Automatically restart if voice mode is still enabled
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

  // --------------------------------------------------
  // 6. USER INTERFACE
  // --------------------------------------------------

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
        onClick={handleVoice}
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

      <p role="status">Status: {status}</p>

      {/* Navigation confirmation */}
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

      {/* Universal form confirmation */}
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
    </main>
  );
}

export default App;
