
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

    // Store actual HTML elements by their assigned IDs
    const elementById = new Map<number, HTMLElement>();

    // Listen for commands from the Access OS popup
    browser.runtime.onMessage.addListener(
      (message, _sender, sendResponse) => {

        // 1. Highlight all links (original test feature)
        if (message.type === 'HIGHLIGHT_LINKS') {
          links.forEach((link) => {
            link.style.outline = '3px solid #14b8a6';
          });

          sendResponse({ success: true });
          return;
        }

        // 2. Scan the webpage for interactive elements
        if (message.type === 'GET_PAGE_ELEMENTS') {

          // Find links
          const links = Array.from(
            document.querySelectorAll<HTMLAnchorElement>('a[href]')
          ).map((link) => ({
            element: link,
            text:
              link.getAttribute('aria-label') ||
              link.textContent?.trim(),
            role: 'link',
            href: link.href,
          }));

          // Find buttons
          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('button')
          ).map((button) => ({
            element: button,
            text:
              button.getAttribute('aria-label') ||
              button.textContent?.trim(),
            role: 'button',
          }));

          // Find input fields (excluding passwords and hidden inputs)
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
            inputType: input.type,
          }));

          // Reset stored elements before a new scan
          elementById.clear();

          // Combine elements and assign unique IDs
          const elements = [...links, ...buttons, ...inputs]
            .filter((item) => item.text)
            .map(({ element, text, role, ...details }, index) => {
              const id = index + 1;

              // Store the real HTML element
              elementById.set(id, element);

              // Send only descriptions to Claude
              return { id, text, role, ...details };
            });

          console.log('Scanned elements:', elements);

          sendResponse({ elements });
          return;
        }

        // 3. Highlight an element selected by Claude
        if (
          message.type === 'HIGHLIGHT_ELEMENT' &&
          typeof message.elementId === 'number'
        ) {
          const target = elementById.get(message.elementId);

          if (!target || !target.isConnected) {
            sendResponse({ success: false });
            return;
          }

          // Scroll the selected element into view
          target.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });

          // Add a teal outline
          target.style.outline = '4px solid #14b8a6';
          target.style.outlineOffset = '3px';

          sendResponse({ success: true });
          return;
        }

        // 4. Click an AI-selected link after confirmation
        if (
          message.type === 'CLICK_SELECTED_LINK' &&
          typeof message.elementId === 'number'
        ) {
          const target = elementById.get(message.elementId);

          // Only allow valid links
          if (
            !(target instanceof HTMLAnchorElement) ||
            !target.isConnected
          ) {
            sendResponse({
              success: false,
              error: 'Invalid link',
            });
            return;
          }

          // Only allow HTTP or HTTPS destinations
          if (!['http:', 'https:'].includes(target.protocol)) {
            sendResponse({
              success: false,
              error: 'Unsupported URL',
            });
            return;
          }

          // Require confirmation from the popup
          if (message.confirmed !== true) {
            sendResponse({
              success: false,
              error: 'Confirmation required',
            });
            return;
          }

          // Verify that the destination hasn't changed
          if (
            typeof message.expectedHref !== 'string' ||
            target.href !== message.expectedHref
          ) {
            sendResponse({
              success: false,
              error: 'Link destination changed',
            });
            return;
          }

          // Respond before the page navigates
          sendResponse({ success: true });

          setTimeout(() => {
            if (
              target.isConnected &&
              target.href === message.expectedHref
            ) {
              target.click();
            }
          }, 100);

          return;
        }

        // 5. Fill a text field
        if (
          message.type === 'FILL_TEXT_INPUT' &&
          typeof message.elementId === 'number' &&
          typeof message.value === 'string'
        ) {
          const target = elementById.get(message.elementId);

          // Only allow editable text inputs
          if (
            !(target instanceof HTMLInputElement) ||
            target.type !== 'text' ||
            target.disabled ||
            target.readOnly ||
            !target.isConnected ||
            message.value.length > 200
          ) {
            sendResponse({
              success: false,
              error: 'Invalid text field',
            });
            return;
          }
if (message.confirmed !== true) {
  sendResponse({
    success: false,
    error: 'Confirmation required',
  });
  return;
}
          // Get the browser's native value setter
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
          )?.set;

          if (!setter) {
            sendResponse({
              success: false,
              error: 'Cannot update field',
            });
            return;
          }

          // Insert the text into the field
          setter.call(target, message.value);

          // Notify the webpage of the change
          target.dispatchEvent(
            new Event('input', { bubbles: true })
          );

          target.dispatchEvent(
            new Event('change', { bubbles: true })
          );

          sendResponse({ success: true });
          return;
        }
      }
    );
  },
});
