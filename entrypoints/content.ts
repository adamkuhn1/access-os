
import { browser } from 'wxt/browser';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],

  main() {
    console.log('Access OS is running!');

    const elementById = new Map<number, HTMLElement>();

    // visual-only cursor, it never clicks anything. plain div so the
    // element scanner never picks it up
    const cursor = document.createElement('div');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 24 24"
        style="display: block; transform-origin: 2px 2px">
        <path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.8 20.6 L9.8 13.8 L16 13.8 Z"
          fill="#14b8a6" stroke="#ffffff" stroke-width="1.5"
          stroke-linejoin="round" />
      </svg>`;
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      margin: '-2px 0 0 -2px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 200ms',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))',
    });

    let cursorX = window.innerWidth / 2;
    let cursorY = window.innerHeight / 2;
    let cursorRun = 0;
    let hideTimer: number | undefined;

    function moveCursorTo(target: HTMLElement) {
      if (!cursor.isConnected) {
        document.documentElement.appendChild(cursor);
      }

      // a newer move cancels the old one
      const run = ++cursorRun;
      window.clearTimeout(hideTimer);
      cursor.style.opacity = '1';

      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;
      const duration = reduceMotion ? 0 : 600;
      const startX = cursorX;
      const startY = cursorY;
      const startTime = performance.now();

      function frame(now: number) {
        if (run !== cursorRun) return;

        // re-read every frame since the page may still be smooth scrolling
        const rect = target.getBoundingClientRect();
        const endX = rect.left + rect.width / 2;
        const endY = rect.top + rect.height / 2;

        const t = duration
          ? Math.min((now - startTime) / duration, 1)
          : 1;
        const eased = 1 - Math.pow(1 - t, 3);

        cursorX = startX + (endX - startX) * eased;
        cursorY = startY + (endY - startY) * eased;
        cursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;

        // keep following for a bit so it ends up right after scrolling stops
        if (now - startTime < 1500) {
          requestAnimationFrame(frame);
        } else {
          hideTimer = window.setTimeout(() => {
            cursor.style.opacity = '0';
          }, 1500);
        }
      }

      requestAnimationFrame(frame);
    }

    // just the visual click, the form handler still does the real work.
    // doesn't wait for anything so the form update isn't delayed
    function showCursorClick(target: HTMLElement) {
      if (!cursor.isConnected) {
        document.documentElement.appendChild(cursor);
      }

      // stop any move still running and jump to the target, which also
      // covers the cursor having already faded out
      cursorRun++;
      window.clearTimeout(hideTimer);

      const rect = target.getBoundingClientRect();
      cursorX = rect.left + rect.width / 2;
      cursorY = rect.top + rect.height / 2;
      cursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
      cursor.style.opacity = '1';

      const ring = document.createElement('div');
      ring.setAttribute('aria-hidden', 'true');
      Object.assign(ring.style, {
        position: 'fixed',
        left: `${cursorX - 20}px`,
        top: `${cursorY - 20}px`,
        width: '40px',
        height: '40px',
        boxSizing: 'border-box',
        border: '3px solid #14b8a6',
        borderRadius: '50%',
        boxShadow: '0 0 0 1px #ffffff',
        opacity: '0',
        zIndex: '2147483646',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(ring);

      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      // reduced motion: no shrink or expanding ring, just a quick fade
      const ringAnimation = reduceMotion
        ? ring.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 300,
          })
        : ring.animate(
            [
              { transform: 'scale(0.3)', opacity: 1 },
              { transform: 'scale(1)', opacity: 0 },
            ],
            { duration: 300, easing: 'ease-out' }
          );
      ringAnimation.onfinish = () => ring.remove();

      if (!reduceMotion) {
        cursor.firstElementChild?.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(0.8)' },
            { transform: 'scale(1)' },
          ],
          { duration: 200 }
        );
      }

      hideTimer = window.setTimeout(() => {
        cursor.style.opacity = '0';
      }, 1500);
    }

    browser.runtime.onMessage.addListener(
      (message, _sender, sendResponse) => {

        // old test - highlights every link
        if (message.type === 'HIGHLIGHT_LINKS') {
          document
            .querySelectorAll<HTMLAnchorElement>('a[href]')
            .forEach((link) => {
              link.style.outline = '3px solid #14b8a6';
            });

          sendResponse({ success: true });
          return;
        }

        if (message.type === 'GET_PAGE_ELEMENTS') {

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

          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('button')
          ).map((button) => ({
            element: button,
            text:
              button.getAttribute('aria-label') ||
              button.textContent?.trim(),
            role: 'button',
          }));

          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input:not([type="hidden"]):not([type="password"]):not([type="file"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"])'
            )
          ).map((input) => {
            const isChoice = ['checkbox', 'radio'].includes(
              input.type
            );

            const label =
              input.getAttribute('aria-label') ||
              input.labels?.[0]?.textContent?.trim() ||
              (isChoice
                ? input.nextSibling?.textContent?.trim()
                : undefined) ||
              input.placeholder ||
              input.name ||
              input.id;

            return {
              element: input,
              text: isChoice
                ? `${input.name || input.type}: ${label}`
                : label,
              role: 'input',
              inputType: input.type,
              choiceValue: isChoice ? input.value : undefined,
              checked: isChoice ? input.checked : undefined,
            };
          });

          const textareas = Array.from(
            document.querySelectorAll<HTMLTextAreaElement>(
              'textarea'
            )
          ).map((textarea) => ({
            element: textarea,
            text:
              textarea.getAttribute('aria-label') ||
              textarea.labels?.[0]?.textContent?.trim() ||
              textarea.placeholder ||
              textarea.name ||
              textarea.id,
            role: 'textarea',
          }));

          const selects = Array.from(
            document.querySelectorAll<HTMLSelectElement>(
              'select'
            )
          ).map((select) => ({
            element: select,
            text:
              select.getAttribute('aria-label') ||
              select.labels?.[0]?.textContent?.trim() ||
              select.name ||
              select.id,
            role: 'select',
            options: Array.from(select.options).map(
              (option) => ({
                text: option.text.trim(),
                value: option.value,
                disabled: option.disabled,
              })
            ),
          }));

          elementById.clear();

          const elements = [
            ...links,
            ...buttons,
            ...inputs,
            ...textareas,
            ...selects,
          ]
            .filter((item) => item.text)
            .map(({ element, ...data }, index) => {
              const id = index + 1;
              elementById.set(id, element);

              return { id, ...data };
            });

          console.log('Scanned elements:', elements);
          sendResponse({ elements });
          return;
        }

        if (
          message.type === 'HIGHLIGHT_ELEMENT' &&
          typeof message.elementId === 'number'
        ) {
          const target = elementById.get(
            message.elementId
          );

          if (!target || !target.isConnected) {
            sendResponse({ success: false });
            return;
          }

          target.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });

          target.style.outline = '4px solid #14b8a6';
          target.style.outlineOffset = '3px';

          moveCursorTo(target);

          sendResponse({ success: true });
          return;
        }

        if (
          message.type === 'CLICK_SELECTED_LINK' &&
          typeof message.elementId === 'number'
        ) {
          const target = elementById.get(
            message.elementId
          );

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

          if (
            !['http:', 'https:'].includes(target.protocol)
          ) {
            sendResponse({
              success: false,
              error: 'Unsupported URL',
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

        // old text-only fill, keeping it around for now
        if (
          message.type === 'FILL_TEXT_INPUT' &&
          typeof message.elementId === 'number' &&
          typeof message.value === 'string'
        ) {
          const target = elementById.get(
            message.elementId
          );

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

          const setter =
            Object.getOwnPropertyDescriptor(
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

          setter.call(target, message.value);

          target.dispatchEvent(
            new Event('input', { bubbles: true })
          );

          target.dispatchEvent(
            new Event('change', { bubbles: true })
          );

          sendResponse({ success: true });
          return;
        }

        // handles text fields, checkboxes, radios and selects
        if (message.type === 'SET_FORM_CONTROL') {
          const elementId = message.elementId;
          const value = message.value;

          if (
            message.confirmed !== true ||
            !Number.isInteger(elementId)
          ) {
            sendResponse({
              success: false,
              error: 'Invalid or unconfirmed action',
            });
            return;
          }

          const target = elementById.get(elementId);

          if (!target || !target.isConnected) {
            sendResponse({
              success: false,
              error: 'Element no longer exists',
            });
            return;
          }

          // checkbox / radio
          if (
            target instanceof HTMLInputElement &&
            ['checkbox', 'radio'].includes(target.type)
          ) {
            if (
              target.disabled ||
              typeof value !== 'boolean' ||
              (target.type === 'radio' && value !== true)
            ) {
              sendResponse({
                success: false,
                error: 'Invalid selection',
              });
              return;
            }

            showCursorClick(target);

            if (target.checked !== value) {
              target.click();
            }

            const success = target.checked === value;

            sendResponse({
              success,
              error: success
                ? undefined
                : 'Selection failed',
            });
            return;
          }

          // text inputs + textareas
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement
          ) {
            const isInput =
              target instanceof HTMLInputElement;

            const allowedTypes = [
              'text',
              'email',
              'tel',
              'url',
              'search',
              'number',
              'date',
              'time',
              'datetime-local',
              'month',
              'week',
            ];

            if (
              (isInput &&
                !allowedTypes.includes(target.type)) ||
              target.disabled ||
              target.readOnly ||
              typeof value !== 'string' ||
              value.length > 1000
            ) {
              sendResponse({
                success: false,
                error: 'Invalid text field',
              });
              return;
            }

            const prototype = isInput
              ? HTMLInputElement.prototype
              : HTMLTextAreaElement.prototype;

            const setter =
              Object.getOwnPropertyDescriptor(
                prototype,
                'value'
              )?.set;

            if (!setter) {
              sendResponse({
                success: false,
                error: 'Cannot update field',
              });
              return;
            }

            showCursorClick(target);
            setter.call(target, value);

            if (target.value !== value) {
              sendResponse({
                success: false,
                error: 'Invalid field value',
              });
              return;
            }

            target.dispatchEvent(
              new Event('input', { bubbles: true })
            );

            target.dispatchEvent(
              new Event('change', { bubbles: true })
            );

            sendResponse({ success: true });
            return;
          }

          // selects
          if (target instanceof HTMLSelectElement) {
            if (
              target.disabled ||
              target.multiple ||
              typeof value !== 'string'
            ) {
              sendResponse({
                success: false,
                error: 'Invalid dropdown',
              });
              return;
            }

            const option = Array.from(
              target.options
            ).find(
              (option) =>
                !option.disabled &&
                (
                  option.value === value ||
                  option.text.trim().toLowerCase() ===
                    value.toLowerCase()
                )
            );

            if (!option) {
              sendResponse({
                success: false,
                error: 'Option not found',
              });
              return;
            }

            const setter =
              Object.getOwnPropertyDescriptor(
                HTMLSelectElement.prototype,
                'value'
              )?.set;

            if (!setter) {
              sendResponse({
                success: false,
                error: 'Cannot update dropdown',
              });
              return;
            }

            showCursorClick(target);
            setter.call(target, option.value);

            target.dispatchEvent(
              new Event('input', { bubbles: true })
            );

            target.dispatchEvent(
              new Event('change', { bubbles: true })
            );

            const success =
              target.value === option.value;

            sendResponse({
              success,
              error: success
                ? undefined
                : 'Dropdown update failed',
            });
            return;
          }

          sendResponse({
            success: false,
            error: 'Unsupported control',
          });
          return;
        }

        // read back one control so the agent can verify its own change.
        // stays in the extension, never sent to the backend
        if (
          message.type === 'GET_CONTROL_STATE' &&
          typeof message.elementId === 'number'
        ) {
          const target = elementById.get(message.elementId);

          if (!target || !target.isConnected) {
            sendResponse({ success: false });
            return;
          }

          if (
            target instanceof HTMLInputElement &&
            ['checkbox', 'radio'].includes(target.type)
          ) {
            sendResponse({ success: true, checked: target.checked });
            return;
          }

          if (
            (target instanceof HTMLInputElement &&
              target.type !== 'password') ||
            target instanceof HTMLTextAreaElement
          ) {
            sendResponse({ success: true, value: target.value });
            return;
          }

          if (target instanceof HTMLSelectElement) {
            sendResponse({
              success: true,
              value: target.value,
              text: target.selectedOptions[0]?.text.trim() ?? '',
            });
            return;
          }

          sendResponse({ success: false });
          return;
        }
      }
    );
  },
});
