
import { browser } from 'wxt/browser';
import { useState } from 'react';
import './App.css';

type PageElement = {
  id: number;
  text: string;
  role: string;
  href?: string;
};

type SelectedLink = {
  id: number;
  text: string;
  href: string;
  tabId: number;

};

function App() {
  const [status, setStatus] = useState('Ready');
  const [linkText, setLinkText] = useState('Learn more');
  const [selectedLink, setSelectedLink] =
    useState<SelectedLink | null>(null);

  async function handleTest() {
    setStatus('Scanning webpage...');
    setSelectedLink(null);

    try {
      const command = linkText.trim();

      if (!command) {
        setStatus('Please enter a command.');
        return;
      }

      // Find the active browser tab
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        throw new Error('No active tab found');
      }

      // Get real webpage elements
      const pageData = await browser.tabs.sendMessage(tab.id, {
        type: 'GET_PAGE_ELEMENTS',
      });

      const elements = pageData.elements as PageElement[];

      setStatus('Asking Claude...');

      // Send command and elements to our AI backend
      const response = await fetch(
        'http://127.0.0.1:3001/interpret',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            command,
            elements,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`);
      }

      const result = await response.json();

      // Handle no matching element
      if (result.action === 'none') {
        setStatus('Claude could not find a matching element.');
        return;
      }

      // Find Claude's selected element
      const selected = elements.find(
        (element) => element.id === result.elementId
      );
      console.log('Claude selected element:', selected);
      if (!selected) {
        throw new Error('Claude selected an invalid element');
      }

      // Highlight the selected element on the webpage
      const highlightResult = await browser.tabs.sendMessage(
        tab.id,
        {
          type: 'HIGHLIGHT_ELEMENT',
          elementId: result.elementId,
        }
      );

      if (!highlightResult.success) {
        setStatus('Could not highlight the selected element.');
        return;
      }

      setStatus(`Highlighted: ${selected.text}`);

      // Save link information for user confirmation
      if (
        selected.role === 'link' &&
        typeof selected.href === 'string'
      ) {
        setSelectedLink({
          id: selected.id,
          text: selected.text,
          href: selected.href,
          tabId: tab.id,

        });
      }

    } catch (error) {
      console.error(error);
      setStatus('Error connecting to Claude. Check console.');
    }
  }


async function handleConfirm() {
  if (!selectedLink) return;

  setStatus('Opening link...');

  try {
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (activeTab?.id !== selectedLink.tabId) {
      setStatus('Tab changed. Please ask Claude again.');
      setSelectedLink(null);
      return;
    }

    const response = await browser.tabs.sendMessage(
      selectedLink.tabId,
      {
        type: 'CLICK_SELECTED_LINK',
        elementId: selectedLink.id,
        expectedHref: selectedLink.href,
        confirmed: true,
      }
    );

    if (response.success) {
      setStatus('Link opened!');
      setSelectedLink(null);
    } else {
      setStatus(response.error || 'Could not open link.');
      setSelectedLink(null);
    }
  } catch (error) {
    console.error(error);
    setStatus('Navigation failed.');
    setSelectedLink(null);
  }
}


  return (
    <main>
      <h1>Access OS</h1>
      <p>Your AI-powered accessibility assistant.</p>

      <input
        type="text"
        value={linkText}
        onChange={(e) => {
          setLinkText(e.target.value);
          setSelectedLink(null);
        }}
        placeholder="What would you like to do?"
        aria-label="Command"
      />

      <button onClick={handleTest}>
        Ask Claude
      </button>

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


<div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
  <button type="button" onClick={handleConfirm}>
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


        </div>
      )}
    </main>
  );
}

export default App;
