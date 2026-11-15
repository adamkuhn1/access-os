
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

    // labels for buttons/options the agent must never press on its own
    const RISKY_PRESS =
      /\b(buy|purchase|book|reserve|checkout|check out|pay|payment|place order|order now|subscribe|sign ?up|create account|register|log ?in|sign ?in|log ?out|sign ?out|delete|remove|send|post|share|donate|transfer|confirm|add to cart|cart)\b|select (this )?(flight|fare)/i;

    // the only kind of form submit button the agent may press
    const SEARCH_LABEL =
      /\b(search|find|explore|show (flights|results)|update results|go)\b/i;

    // fields whose current value we never report back
    const PERSONAL_FIELD =
      /name|e-?mail|phone|address|street|zip|postal|birth|passport|card|account|ssn|password|security/i;

    const collapse = (text: string | null | undefined, max = 200) =>
      (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

    const isShown = (element: Element) =>
      element.checkVisibility({ checkVisibilityCSS: true });

    const stateOf = (element: HTMLElement) => {
      const states: string[] = [];
      if (element.getAttribute('aria-expanded') === 'true') states.push('expanded');
      if (element.getAttribute('aria-selected') === 'true') states.push('selected');
      if (element.getAttribute('aria-pressed') === 'true') states.push('pressed');
      if (element.getAttribute('aria-checked') === 'true') states.push('checked');
      if (
        element.getAttribute('aria-disabled') === 'true' ||
        (element as HTMLButtonElement).disabled
      ) {
        states.push('disabled');
      }
      return states.length ? states.join(', ') : undefined;
    };

    // is something else (like an open dialog) drawn on top of this element?
    // only checked for elements on screen
    const isCovered = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return false;
      }

      const top = document.elementFromPoint(x, y);
      return !!top && !element.contains(top) && !top.contains(element);
    };

    // how the scanner describes one element. also used to re-check an element
    // right before acting on it, so a stale ID can't hit the wrong thing
    function describeElement(element: HTMLElement) {
      const ariaRole = element.getAttribute('role') ?? undefined;
      const state = stateOf(element);

      if (element instanceof HTMLAnchorElement) {
        return {
          text: collapse(element.getAttribute('aria-label') || element.textContent),
          role: 'link',
          href: element.href,
        };
      }

      if (element instanceof HTMLInputElement) {
        if (['submit', 'button'].includes(element.type)) {
          return {
            text: collapse(element.getAttribute('aria-label') || element.value),
            role: 'button',
            state,
          };
        }

        const isChoice = ['checkbox', 'radio'].includes(element.type);
        const label =
          element.getAttribute('aria-label') ||
          element.labels?.[0]?.textContent?.trim() ||
          (isChoice ? element.nextSibling?.textContent?.trim() : undefined) ||
          element.placeholder ||
          element.name ||
          element.id;

        // share what's typed in search-style fields so the agent can see its
        // own progress, but never personal fields
        const safeValue =
          !isChoice &&
          ['text', 'search', 'date', 'number', ''].includes(element.type) &&
          !PERSONAL_FIELD.test(`${label} ${element.name} ${element.id}`) &&
          !/name|email|tel|address|postal|bday|cc-|username/i.test(
            element.autocomplete
          );

        return {
          text: collapse(isChoice ? `${element.name || element.type}: ${label}` : label),
          role: 'input',
          inputType: element.type,
          ariaRole,
          state,
          value: safeValue ? collapse(element.value, 100) : undefined,
          choiceValue: isChoice ? element.value : undefined,
          checked: isChoice ? element.checked : undefined,
        };
      }

      if (element instanceof HTMLTextAreaElement) {
        return {
          text: collapse(
            element.getAttribute('aria-label') ||
              element.labels?.[0]?.textContent ||
              element.placeholder ||
              element.name ||
              element.id
          ),
          role: 'textarea',
        };
      }

      if (element instanceof HTMLSelectElement) {
        return {
          text: collapse(
            element.getAttribute('aria-label') ||
              element.labels?.[0]?.textContent ||
              element.name ||
              element.id
          ),
          role: 'select',
          options: Array.from(element.options).map((option) => ({
            text: option.text.trim(),
            value: option.value,
            disabled: option.disabled,
          })),
        };
      }

      const labelledBy = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');

      // date pickers often keep the full date in an attribute ("2026-11-20")
      const date = element.dataset.iso || element.dataset.date;

      // calendar day cells often show just "16" and keep the full date
      // ("Monday, November 16, 2026") on an element inside them
      const innerLabel =
        ariaRole === 'gridcell'
          ? element.querySelector('[aria-label]')?.getAttribute('aria-label')
          : undefined;

      return {
        text: collapse(
          element.getAttribute('aria-label') ||
            labelledBy ||
            innerLabel ||
            element.textContent
        ),
        role:
          element instanceof HTMLButtonElement || !ariaRole
            ? 'button'
            : ariaRole,
        state,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      };
    }

    // the element for this ID, only if it still looks exactly like it did in
    // the scan the caller is acting on
    function checkedTarget(elementId: unknown, expectedText: unknown) {
      if (typeof elementId !== 'number') return null;

      const element = elementById.get(elementId);

      if (!element || !element.isConnected || !isShown(element)) return null;

      // same DOM node, so a label that only grew (like a price loading in
      // next to a date, "14????" -> "14$244") is still the same control
      if (
        typeof expectedText === 'string' &&
        !describeElement(element).text.startsWith(
          expectedText.replace(/[\s?…—-]+$/, '')
        )
      ) {
        return null;
      }

      return element;
    }

    // read-only text extraction. walks visible text in DOM order and puts each
    // block (div, p, li, heading...) on its own line, so text inside one
    // result card stays together. table cells in a row are joined with " | "
    function getPageContent() {
      const MAX_CHARS = 10000;
      const MAX_TEXT_NODES = 20000;

      const skipSelector =
        'script, style, noscript, template, svg, canvas, iframe, object, ' +
        'input, textarea, select, option, [contenteditable=""], [contenteditable="true"]';

      const visibleCache = new Map<Element, boolean>();
      const blockCache = new Map<Element, Element>();

      const isVisible = (element: Element) => {
        let visible = visibleCache.get(element);

        if (visible === undefined) {
          visible = element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          });
          visibleCache.set(element, visible);
        }

        return visible;
      };

      // nearest ancestor that isn't inline, table cells count as their own block
      const blockFor = (element: Element) => {
        const cached = blockCache.get(element);
        if (cached) return cached;

        let node: Element = element;

        while (node !== document.body && node.parentElement) {
          if (node.matches('td, th')) break;

          const display = getComputedStyle(node).display;
          const parent: Element = node.parentElement;

          // items in a small flex/grid row (like one result card) share a line
          const parentDisplay = getComputedStyle(parent).display;
          const inSmallRow =
            /flex|grid/.test(parentDisplay) &&
            (parent.textContent?.length ?? 0) <= 300;

          if (
            !display.startsWith('inline') &&
            display !== 'contents' &&
            !inSmallRow
          ) {
            break;
          }

          node = parent;
        }

        blockCache.set(element, node);
        return node;
      };

      const prefixFor = (block: Element) => {
        const heading = block.closest('h1, h2, h3, h4, h5, h6');
        if (heading) return '#'.repeat(Number(heading.tagName[1])) + ' ';
        if (block.closest('li')) return '- ';
        return '';
      };

      const lines: string[] = [];
      let length = 0;
      let truncated = false;
      let currentBlock: Element | null = null;
      let currentLine = '';

      const finishLine = () => {
        const text = currentLine.replace(/\s+/g, ' ').trim();
        currentLine = '';

        if (!text || !currentBlock) return;

        const line = prefixFor(currentBlock) + text;
        if (line === lines[lines.length - 1]) return;

        if (length + line.length > MAX_CHARS) {
          truncated = true;
          return;
        }

        lines.push(line);
        length += line.length + 1;
      };

      // prefer the page's main area over menus and footers when it has one
      const main = document.querySelector('main, [role="main"]');
      const root =
        main && collapse(main.textContent, 300).length >= 200
          ? main
          : document.body;

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

      let visited = 0;

      while (walker.nextNode()) {
        if (truncated) break;

        if (++visited > MAX_TEXT_NODES) {
          truncated = true;
          break;
        }

        const textNode = walker.currentNode as Text;
        const parent = textNode.parentElement;
        const text = textNode.data;

        if (!parent || !text.trim()) continue;
        if (cursor.contains(parent)) continue;
        if (parent.closest(skipSelector)) continue;
        if (!isVisible(parent)) continue;

        const block = blockFor(parent);

        if (block !== currentBlock) {
          const sameRow =
            currentBlock?.matches('td, th') &&
            block.matches('td, th') &&
            currentBlock.parentElement === block.parentElement;

          if (sameRow) {
            currentLine += ' | ';
            currentBlock = block;
          } else {
            finishLine();
            currentBlock = block;
          }
        }

        currentLine += ' ' + text;
      }

      finishLine();

      return {
        title: document.title,
        url: location.href,
        content: lines.join('\n'),
        truncated,
      };
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
          // form controls first, then widgets, buttons and links, so the
          // important ones survive the backend's element limit
          const selectors = [
            'input:not([type="hidden"]):not([type="password"]):not([type="file"]):not([type="reset"]):not([type="image"])',
            'textarea',
            'select',
            '[role="combobox"], [role="option"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], [role="radio"], [role="checkbox"]',
            'button, [role="button"]',
            '[role="gridcell"]',
            'a[href]',
          ];

          // calendars can render hundreds of day cells; only the ones on
          // screen are useful, and the rest would push out other controls
          const onScreen = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth
            );
          };

          const seen = new Set<Element>();
          const found: HTMLElement[] = [];

          for (const selector of selectors) {
            document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
              if (seen.has(element) || cursor.contains(element)) return;
              seen.add(element);
              if (!isShown(element)) return;
              if (element.getAttribute('role') === 'gridcell' && !onScreen(element)) return;
              found.push(element);
            });
          }

          elementById.clear();

          // busy sites (like Google Flights) have hundreds of off-screen
          // controls, so list what's on screen first
          const ordered = [
            ...found.filter(onScreen),
            ...found.filter((element) => !onScreen(element)),
          ];

          const elements = ordered
            .map((element) => {
              const info = describeElement(element);
              const state = isCovered(element)
                ? [info.state, 'covered'].filter(Boolean).join(', ')
                : info.state;
              return { element, ...info, state };
            })
            .filter((item) => item.text)
            .slice(0, 350)
            .map(({ element, ...data }, index) => {
              const id = index + 1;
              elementById.set(id, element);

              return { id, ...data };
            });

          // a visible spinner or busy region usually means results are loading
          const busy = Array.from(
            document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')
          ).some(isShown);

          sendResponse({ elements, busy });
          return;
        }

        // press a button, option, tab or date cell. only after re-checking it
        // and refusing anything that looks consequential
        if (message.type === 'PRESS_ELEMENT') {
          const target = checkedTarget(message.elementId, message.expectedText);

          if (!target) {
            sendResponse({
              success: false,
              error: 'The element changed or disappeared',
            });
            return;
          }

          const label = describeElement(target).text;

          if (stateOf(target)?.includes('disabled')) {
            sendResponse({ success: false, error: 'That control is disabled' });
            return;
          }

          if (isCovered(target)) {
            sendResponse({
              success: false,
              error:
                'it is covered by a popup or dialog, close that first (for example with its Done or Close button)',
            });
            return;
          }

          if (RISKY_PRESS.test(label)) {
            sendResponse({
              success: false,
              error: 'That looks like it could buy, book, sign in or send something',
            });
            return;
          }

          const form =
            target instanceof HTMLButtonElement ||
            target instanceof HTMLInputElement
              ? target.form
              : null;

          const submitsForm =
            !!form &&
            ((target instanceof HTMLButtonElement && target.type === 'submit') ||
              (target instanceof HTMLInputElement && target.type === 'submit'));

          // a submit button is only ok for a plain search form
          if (
            submitsForm &&
            (!SEARCH_LABEL.test(label) ||
              form.method.toLowerCase() === 'post' ||
              form.querySelector('input[type="password"]'))
          ) {
            sendResponse({
              success: false,
              error: 'Only search buttons can submit a form',
            });
            return;
          }

          showCursorClick(target);
          target.focus({ preventScroll: true });

          // some sites listen for the pointer events instead of click
          const rect = target.getBoundingClientRect();
          const point = {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          };
          target.dispatchEvent(new PointerEvent('pointerdown', point));
          target.dispatchEvent(new MouseEvent('mousedown', point));
          target.dispatchEvent(new PointerEvent('pointerup', point));
          target.dispatchEvent(new MouseEvent('mouseup', point));
          target.click();

          sendResponse({ success: true });
          return;
        }

        if (
          message.type === 'HIGHLIGHT_ELEMENT' &&
          typeof message.elementId === 'number'
        ) {
          const target =
            message.expectedText === undefined
              ? elementById.get(message.elementId)
              : checkedTarget(message.elementId, message.expectedText);

          if (!target || !target.isConnected) {
            sendResponse({ success: false });
            return;
          }

          // only scroll when needed: many sites close open menus on scroll
          const rect = target.getBoundingClientRect();
          const inView =
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth;

          if (!inView) {
            target.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          }

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

          const target =
            message.expectedText === undefined
              ? elementById.get(elementId)
              : checkedTarget(elementId, message.expectedText);

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

            if (target.readOnly || target.disabled) {
              sendResponse({
                success: false,
                error: target.readOnly
                  ? 'the field is read-only, it is probably filled by a picker or menu instead'
                  : 'the field is disabled',
              });
              return;
            }

            if (
              (isInput &&
                !allowedTypes.includes(target.type)) ||
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

            // agent mode types character by character so the user can see it
            // and so search suggestions react like they would to a person
            if (message.typeOut === true && value.length <= 80) {
              const field = target;
              field.focus({ preventScroll: true });
              setter.call(field, '');
              field.dispatchEvent(new Event('input', { bubbles: true }));

              void (async () => {
                // some search boxes open a popup with their own input as soon
                // as you start typing. keep typing wherever the focus went
                let into: HTMLInputElement | HTMLTextAreaElement = field;

                for (const char of value) {
                  const active = document.activeElement;

                  if (
                    active !== into &&
                    active instanceof HTMLInputElement &&
                    ['text', 'search'].includes(active.type) &&
                    !PERSONAL_FIELD.test(describeElement(active).text)
                  ) {
                    into = active;
                  }

                  if (!into.isConnected) break;

                  const intoSetter = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(into),
                    'value'
                  )?.set;
                  intoSetter?.call(into, into.value + char);
                  into.dispatchEvent(
                    new InputEvent('input', {
                      bubbles: true,
                      inputType: 'insertText',
                      data: char,
                    })
                  );
                  await new Promise((resolve) => setTimeout(resolve, 45));
                }

                into.dispatchEvent(new Event('change', { bubbles: true }));

                // let the site react, then read back whichever field holds
                // the text now (some sites move it into a popup afterwards)
                await new Promise((resolve) => setTimeout(resolve, 300));

                const active = document.activeElement;
                if (
                  !into.value.toLowerCase().startsWith(value.toLowerCase()) &&
                  active instanceof HTMLInputElement &&
                  ['text', 'search'].includes(active.type) &&
                  !PERSONAL_FIELD.test(describeElement(active).text)
                ) {
                  into = active;
                }

                const typed = into.value;
                const success = typed.toLowerCase().startsWith(value.toLowerCase());

                sendResponse({
                  success,
                  error: success ? undefined : 'Invalid field value',
                  value: typed,
                  movedTo: into === field ? undefined : describeElement(into).text,
                });
              })();

              // tells chrome we'll answer after the typing finishes
              return true;
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

        // page text is untrusted data. nothing sends it to the backend yet
        if (message.type === 'GET_PAGE_CONTENT') {
          sendResponse(getPageContent());
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
