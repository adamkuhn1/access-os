
import { browser } from 'wxt/browser';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],

  main() {
    console.log('Access OS is running!');

    // Find interactive elements on the webpage
    const buttons = document.querySelectorAll('button');
    const links = document.querySelectorAll<HTMLAnchorElement>('a[href]');
    const inputs = document.querySelectorAll('input');

    console.log('Buttons found:', buttons.length);
    console.log('Links found:', links.length);
    console.log('Inputs found:', inputs.length);

    // Log information about links
    links.forEach((link) => {
      console.log('Link text:', link.textContent?.trim());
      console.log('Link URL:', link.href);
    });


    const elementById = new Map<number, HTMLElement>();
    // Listen for commands from the Access OS popup
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {

      // Highlight all links on the webpage
      if (message.type === 'HIGHLIGHT_LINKS') {
        links.forEach((link) => {
          link.style.outline = '3px solid #14b8a6';
        });

        sendResponse({ success: true });
      }

      // Find and click a link by its text
      if (message.type === 'CLICK_LINK' && typeof message.text === 'string') {
        const target = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href]')
        ).find((link) =>
          link.textContent?.trim().toLowerCase() ===
          message.text.trim().toLowerCase()
        );

        if (target) {
          sendResponse({ success: true });

          // Open the link after responding
          setTimeout(() => target.click(), 100);
        } else {
          sendResponse({ success: false });
        }
      }

      // Scan the webpage for interactive elements
      
if (message.type === 'GET_PAGE_ELEMENTS') {
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href]')
  ).map((link) => ({
    element: link,
    text: link.getAttribute('aria-label') || link.textContent?.trim(),
    role: 'link',
  }));

  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button')
  ).map((button) => ({
    element: button,
    text: button.getAttribute('aria-label') || button.textContent?.trim(),
    role: 'button',
  }));

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input:not([type="hidden"]):not([type="password"])'
    )
  ).map((input) => ({
    element: input,
    text:
      input.getAttribute('aria-label') ||
      input.labels?.[0]?.textContent?.trim() ||
      input.placeholder ||
      input.name ||
      input.id,
    role: 'input',
  }));

  // Clear IDs from previous scans
  elementById.clear();

  const elements = [...links, ...buttons, ...inputs]
    .filter((item) => item.text)
    .map(({ element, text, role }, index) => {
      const id = index + 1;

      // Remember the actual HTML element
      elementById.set(id, element);

      // Only send descriptions to the AI
      return { id, text, role };
    });

  sendResponse({ elements });
}


if (
  message.type === 'HIGHLIGHT_ELEMENT' &&
  typeof message.elementId === 'number'
) {
  // Find the actual HTML element using its ID
  const target = elementById.get(message.elementId);

  if (!target || !target.isConnected) {
    sendResponse({ success: false });
    return;
  }

  // Bring the element into view
  target.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });

  // Highlight the selected element
  target.style.outline = '4px solid #14b8a6';
  target.style.outlineOffset = '3px';

  sendResponse({ success: true });
}


    });
  },
});
