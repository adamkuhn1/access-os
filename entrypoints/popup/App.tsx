import { browser } from 'wxt/browser';
import { useState } from 'react';
import './App.css';

function App() {
  const [status, setStatus] = useState('Ready');

  
async function handleTest() {
  setStatus('Connecting...');

  try {
    // Find the currently active browser tab
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    // Send a command to our content script
    const response = await browser.tabs.sendMessage(tab.id, {
      type: 'HIGHLIGHT_LINKS',
    });

    if (response.success) {
      setStatus('Links highlighted!');
    }
  } catch (error) {
    console.error(error);
    setStatus('Connection failed');
  }
}


  return (
    <main>
      <h1>Access OS</h1>
      <p>Your AI-powered accessibility assistant.</p>

      <button onClick={handleTest}>
        Test Connection
      </button>

      <p>Status: {status}</p>
    </main>
  );
}

export default App;
