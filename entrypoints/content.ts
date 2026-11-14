
import { browser } from 'wxt/browser';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],

  main() {
    console.log('Access OS is running!');

    const elementById = new Map<number, HTMLElement>();

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
      }
    );
  },
});
