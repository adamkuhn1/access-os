import { browser } from 'wxt/browser';
import { useState } from 'react';
import './App.css';

function App() {
  const [status, setStatus] = useState('Ready');

  
async function handleTest() {
  setStatus('Connecting...');

  try {
    //find the currently active browser tab
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    //send a command to our content script
    
const response = await browser.tabs.sendMessage(tab.id, {
  type: 'CLICK_LINK',
  text: 'Learn more',
});

if (response.success) {
  setStatus('Opening link...');
} else {
  setStatus('Link not found');
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
        Open "Learn More"
      </button>

      <p>Status: {status}</p>
    </main>
  );
}

export default App;
