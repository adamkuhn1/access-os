
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

        // Find links
        const links = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href]')
        ).map((link) => ({
          text: link.getAttribute('aria-label') || link.textContent?.trim(),
          role: 'link',
        }));

        // Find buttons
        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>('button')
        ).map((button) => ({
          text: button.getAttribute('aria-label') || button.textContent?.trim(),
          role: 'button',
        }));

        // Find input fields (excluding passwords and hidden fields)
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input:not([type="hidden"]):not([type="password"])'
          )
        ).map((input) => ({
          text:
            input.getAttribute('aria-label') ||
            input.labels?.[0]?.textContent?.trim() ||
            input.placeholder ||
            input.name ||
            input.id,
          role: 'input',
        }));

        // Combine everything and assign temporary IDs
        const elements = [...links, ...buttons, ...inputs]
          .filter((element) => element.text)
          .map((element, index) => ({
            id: index + 1,
            ...element,
          }));

        // Send the elements back to the popup
        sendResponse({ elements });
      }
    });
  },
});
