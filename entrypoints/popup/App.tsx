
import { browser } from 'wxt/browser';
import { useState } from 'react';
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

function App() {
  const [status, setStatus] = useState('Ready');
  const [command, setCommand] = useState('');

  const [selectedLink, setSelectedLink] =
    useState<SelectedLink | null>(null);

  const [pendingForm, setPendingForm] =
    useState<PendingFormControl | null>(null);

  // Ask Claude to interpret a command
  async function handleAskClaude() {
    setSelectedLink(null);
    setPendingForm(null);

    if (!command.trim()) {
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

      // Scan the current webpage
      const pageData = await browser.tabs.sendMessage(
        tab.id,
        { type: 'GET_PAGE_ELEMENTS' }
      );

      const elements = pageData.elements as PageElement[];

      setStatus('Asking Claude...');

      // Send the instruction to our AI backend
      const response = await fetch(
        'http://127.0.0.1:3001/interpret',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            command: command.trim(),
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

      // Find the element Claude selected
      const selected = elements.find(
        (element) => element.id === result.elementId
      );

      if (!selected) {
        throw new Error('Invalid element selected');
      }

      // Highlight the element on the webpage
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

      // NAVIGATION ACTION
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

      // UNIVERSAL FORM ACTION
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

        // Make checkboxes and radio buttons readable
        if (selected.inputType === 'checkbox') {
          displayValue = result.value
            ? 'Check'
            : 'Uncheck';
        } else if (selected.inputType === 'radio') {
          displayValue = 'Select';
        }

        // Display dropdown option labels instead of IDs
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

  // Confirm and open a link
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

  // Confirm and apply a form change
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

      // Universal Form Engine
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

      <button type="button" onClick={handleAskClaude}>
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
