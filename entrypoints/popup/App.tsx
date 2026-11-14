import { browser } from 'wxt/browser';
import { useState } from 'react';
import './App.css';

function App() {
  const [status, setStatus] = useState('Ready');
const [linkText, setLinkText] = useState('Learn more');
  

  

async function handleTest() {
  setStatus('Scanning webpage...');

  try {
    // Get the user's command
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

    // Ask the content script to scan the page
    const pageData = await browser.tabs.sendMessage(tab.id, {
      type: 'GET_PAGE_ELEMENTS',
    });

    setStatus('Asking Claude...');

    // Send the real page elements and command to our backend
    const response = await fetch('http://127.0.0.1:3001/interpret', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        command,
        elements: pageData.elements,
      }),
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const result = await response.json();

    // Display Claude's decision
    if (result.action === 'none') {
      setStatus('Claude could not find a matching element.');
      return;
    }

    const selected = pageData.elements.find(
      (element: { id: number; text: string; role: string }) =>
        element.id === result.elementId
    );

    if (!selected) {
      throw new Error('Claude selected an invalid element');
    }

    
const highlightResult = await browser.tabs.sendMessage(tab.id, {
  type: 'HIGHLIGHT_ELEMENT',
  elementId: result.elementId,
});

if (highlightResult.success) {
  setStatus(`Highlighted: ${selected.text}`);
} else {
  setStatus('Could not highlight the selected element.');
}


  } catch (error) {
    console.error(error);
    setStatus('Error connecting to Claude. Check console.');
  }
}



  return (
    <main>
      <h1>Access OS</h1>
      <p>Your AI-powered accessibility assistant.</p>
      
<input
  type="text"
  value={linkText}
  onChange={(e) => setLinkText(e.target.value)}
  placeholder="Enter link text"
/>

      <button onClick={handleTest}>
  Ask Claude
</button>

      <p>Status: {status}</p>
    </main>
  );
}

export default App;
