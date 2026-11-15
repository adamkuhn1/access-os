import { browser } from 'wxt/browser';

// Access OS content script: everything that touches the web page. It scans the
// page's controls, reads its text, and moves the animated cursor to type and
// click. Every action re-checks its target and refuses anything risky.

// the one thing the agent never does: spend money or delete things
const RISKY = /\b(buy|purchase|pay|payment|place order|checkout|check out|delete)\b/i;
// fields whose typed value is never reported (only whether they're filled in)
const PERSONAL = /name|e-?mail|phone|address|street|zip|postal|birth|passport|card|account|ssn|password|security/i;
const TEXT_TYPES = ['text', 'email', 'password', 'tel', 'url', 'search', 'number', 'date', 'time', 'datetime-local', 'month', 'week'];

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Message = { type?: string; elementId?: unknown; expectedText?: unknown; value?: unknown; typeOut?: boolean };

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],

  main() {
    const elementById = new Map<number, HTMLElement>();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const fail = (error: string) => ({ success: false, error });
    const collapse = (text: string | null | undefined, max = 200) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const isShown = (element: Element) => element.checkVisibility({ checkVisibilityCSS: true });
    const center = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const onScreen = (element: Element) => {
      const r = element.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };

    // ---------- the animated cursor (visual only, it never clicks) ----------

    const cursor = document.createElement('div');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" style="display:block;transform-origin:2px 2px">
      <path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.8 20.6 L9.8 13.8 L16 13.8 Z" fill="#14b8a6" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', margin: '-2px 0 0 -2px', zIndex: '2147483647',
      pointerEvents: 'none', opacity: '0', transition: 'opacity 200ms',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
    });

    const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    let cursorAt = { x: innerWidth / 2, y: innerHeight / 2 };
    let cursorRun = 0;
    let hideTimer: number | undefined;

    function showCursor() {
      if (!cursor.isConnected) document.documentElement.append(cursor);
      window.clearTimeout(hideTimer);
      cursor.style.opacity = '1';
      hideTimer = window.setTimeout(() => (cursor.style.opacity = '0'), 3000);
    }

    const placeCursor = (point: { x: number; y: number }) => {
      cursorAt = point;
      cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    };

    // glide to an element over 600ms (no glide with reduced motion), and keep
    // following it for a moment in case the page is still scrolling
    function moveCursorTo(target: HTMLElement) {
      const run = ++cursorRun;
      const start = cursorAt;
      const startTime = performance.now();
      const duration = reduceMotion() ? 0 : 600;
      showCursor();

      const frame = (now: number) => {
        if (run !== cursorRun) return;
        const end = center(target);
        const t = duration ? Math.min((now - startTime) / duration, 1) : 1;
        const eased = 1 - Math.pow(1 - t, 3);
        placeCursor({ x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased });
        if (now - startTime < 1500) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    // a quick click animation: the pointer dips and a teal ring expands
    function showCursorClick(target: HTMLElement) {
      cursorRun++;
      showCursor();
      placeCursor(center(target));

      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position: 'fixed', left: `${cursorAt.x - 20}px`, top: `${cursorAt.y - 20}px`, width: '40px', height: '40px',
        boxSizing: 'border-box', border: '3px solid #14b8a6', borderRadius: '50%', boxShadow: '0 0 0 1px #fff',
        opacity: '0', zIndex: '2147483646', pointerEvents: 'none',
      });
      document.documentElement.append(ring);

      const grow = reduceMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'scale(0.3)', opacity: 1 }, { transform: 'scale(1)', opacity: 0 }];
      ring.animate(grow, { duration: 300, easing: 'ease-out' }).onfinish = () => ring.remove();
      if (!reduceMotion()) {
        cursor.firstElementChild?.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.8)' }, { transform: 'scale(1)' }], { duration: 200 });
      }
    }

    // ---------- describing the page's controls ----------

    const stateOf = (element: HTMLElement) => {
      const states = ['expanded', 'selected', 'pressed', 'checked'].filter((s) => element.getAttribute(`aria-${s}`) === 'true');
      if (element.getAttribute('aria-disabled') === 'true' || (element as HTMLButtonElement).disabled) states.push('disabled');
      return states.join(', ') || undefined;
    };

    // is an open dialog (like a date picker) drawn on top of this element?
    // (only dialogs count: many sites lay invisible link overlays over cards)
    const isCovered = (element: HTMLElement) => {
      if (!onScreen(element)) return false;
      const { x, y } = center(element);
      const dialog = document.elementFromPoint(x, y)?.closest('dialog, [role=dialog], [aria-modal=true]');
      return !!dialog && !dialog.contains(element);
    };

    // identical buttons ("Select flight", "Visit site") are told apart by the
    // row or card they sit in
    const near = (element: HTMLElement, label: string) =>
      label.length < 30 ? collapse(element.parentElement?.closest('li, tr, article, [role=row], [role=listitem]')?.textContent, 90) || undefined : undefined;

    // how the scanner describes one element. also used to re-check an element
    // right before acting on it
    function describeElement(element: HTMLElement) {
      const ariaRole = element.getAttribute('role') ?? undefined;
      const state = stateOf(element);
      const label = (element as HTMLInputElement).labels?.[0]?.textContent;

      if (element instanceof HTMLAnchorElement) {
        const text = collapse(element.getAttribute('aria-label') || element.textContent);
        return { text, role: 'link', near: near(element, text) };
      }

      if (element instanceof HTMLInputElement && !['submit', 'button'].includes(element.type)) {
        const isChoice = ['checkbox', 'radio'].includes(element.type);
        const name = element.getAttribute('aria-label') || label?.trim() ||
          (isChoice ? element.nextSibling?.textContent?.trim() : '') || element.placeholder || element.name || element.id;
        // share what's typed in search-style fields so the agent can see its
        // own progress. personal fields only say whether they're filled in
        const safeValue = !isChoice && ['text', 'search', 'date', 'number', ''].includes(element.type) &&
          !PERSONAL.test(`${name} ${element.name} ${element.id} ${element.autocomplete}`);
        return {
          text: collapse(isChoice ? `${element.name || element.type}: ${name}` : name),
          role: 'input', inputType: element.type, state,
          value: isChoice ? undefined : safeValue ? collapse(element.value, 100) : element.value ? '(filled in)' : '',
          checked: isChoice ? element.checked : undefined,
        };
      }

      if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        return {
          text: collapse(element.getAttribute('aria-label') || label || element.name || element.id),
          role: element instanceof HTMLSelectElement ? 'select' : 'textarea',
          options: element instanceof HTMLSelectElement ? Array.from(element.options, (o) => ({ text: o.text.trim() })) : undefined,
        };
      }

      // buttons and ARIA widgets. calendar cells often show just "16" and keep
      // the full date on an element inside them or in a data attribute
      const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      const innerLabel = ariaRole === 'gridcell' ? element.querySelector('[aria-label]')?.getAttribute('aria-label') : undefined;
      const date = element.dataset.iso || element.dataset.date;
      const text = collapse(element.getAttribute('aria-label') || labelledBy || innerLabel || (element as HTMLInputElement).value || element.textContent);
      return {
        text,
        near: near(element, text),
        role: element instanceof HTMLButtonElement || element instanceof HTMLInputElement || !ariaRole ? 'button' : ariaRole,
        state,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      };
    }

    // all the controls on the page, numbered for this scan
    function scanPage() {
      // form controls first, then widgets, buttons, day cells and links, so the
      // important ones survive the backend's element limit
      const selectors = [
        'input:not([type=hidden]):not([type=file]):not([type=reset]):not([type=image]), textarea, select',
        '[role=combobox], [role=option], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=switch], [role=radio], [role=checkbox]',
        'button, [role=button]',
        '[role=gridcell]',
        'a[href]',
      ];
      const found = new Set<HTMLElement>();
      for (const selector of selectors) {
        document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
          // calendars render hundreds of day cells; only the visible ones matter
          if (isShown(element) && !(element.getAttribute('role') === 'gridcell' && !onScreen(element))) found.add(element);
        });
      }

      // busy sites (like Google Flights) have hundreds of off-screen controls,
      // so list what's on screen first
      const ordered = [...found].sort((a, b) => Number(onScreen(b)) - Number(onScreen(a)));

      elementById.clear();
      const elements = ordered
        .map((element) => {
          const info = describeElement(element);
          return { element, ...info, state: isCovered(element) ? [info.state, 'covered'].filter(Boolean).join(', ') : info.state };
        })
        .filter((item) => item.text)
        .slice(0, 350)
        .map(({ element, ...info }, index) => {
          elementById.set(index + 1, element);
          return { id: index + 1, ...info };
        });

      // a visible spinner or busy region usually means results are loading
      // (thin progress bars are often part of the layout, so only count real spinners)
      const busy = [...document.querySelectorAll('[aria-busy=true], [role=progressbar]')]
        .some((el) => isShown(el) && el.getBoundingClientRect().height > 16);
      return { elements, busy };
    }

    // the element a message is about, only if it's still on the page and still
    // looks like it did in the scan (so a stale ID can't hit the wrong thing).
    // a label that only grew ("14????" -> "14$244" as a price loads) still counts
    function targetFor(message: Message) {
      const element = typeof message.elementId === 'number' ? elementById.get(message.elementId) : undefined;
      if (!element?.isConnected || !isShown(element) || typeof message.expectedText !== 'string') return null;
      const expected = message.expectedText.replace(/[\s?…—-]+$/, '');
      return describeElement(element).text.startsWith(expected) ? element : null;
    }

    // ---------- reading the page's text (only sent after the user approves) ----------

    // walks visible text in DOM order and puts each block on its own line, so
    // text inside one result card stays together. never reads form fields
    function getPageContent() {
      const MAX_CHARS = 10000;
      const skip = 'script, style, noscript, template, svg, canvas, iframe, input, textarea, select, option, [contenteditable=""], [contenteditable="true"]';
      const blocks = new Map<Element, Element>();

      // nearest non-inline ancestor. small flex/grid rows (like one result
      // card) count as one block; table cells are their own block
      const blockFor = (element: Element): Element => {
        let node = element;
        while (node !== document.body && node.parentElement && !node.matches('td, th')) {
          const parent: Element = node.parentElement;
          const inSmallRow = /flex|grid/.test(getComputedStyle(parent).display) && (parent.textContent?.length ?? 0) <= 300;
          const display = getComputedStyle(node).display;
          if (!display.startsWith('inline') && display !== 'contents' && !inSmallRow) break;
          node = parent;
        }
        return node;
      };

      // prefer the page's main area over menus and footers
      const main = document.querySelector('main, [role=main]');
      const root = main && collapse(main.textContent, 300).length >= 200 ? main : document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const lines: string[] = [];
      let block: Element | null = null;
      let line = '';
      let length = 0;
      let truncated = false;

      const finishLine = () => {
        const textLine = collapse(line, 2000);
        line = '';
        if (!textLine || !block) return;
        const heading = block.closest('h1, h2, h3, h4, h5, h6');
        const full = (heading ? '#'.repeat(Number(heading.tagName[1])) + ' ' : block.closest('li') ? '- ' : '') + textLine;
        if (full === lines.at(-1)) return;
        if (length + full.length > MAX_CHARS) {
          truncated = true;
        } else {
          lines.push(full);
          length += full.length + 1;
        }
      };

      for (let visited = 0; walker.nextNode() && !truncated; visited++) {
        if (visited > 20000) truncated = true;
        const parent = walker.currentNode.parentElement;
        if (!parent || !walker.currentNode.textContent?.trim() || parent.closest(skip)) continue;
        if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;

        if (!blocks.has(parent)) blocks.set(parent, blockFor(parent));
        const next = blocks.get(parent)!;
        if (next !== block) {
          // table cells in the same row are joined with " | "
          if (block?.matches('td, th') && next.matches('td, th') && block.parentElement === next.parentElement) line += ' | ';
          else finishLine();
          block = next;
        }
        line += ' ' + walker.currentNode.textContent;
      }
      finishLine();

      return { title: document.title, url: location.href, content: lines.join('\n'), truncated };
    }

    // ---------- actions ----------

    // outline an element and glide the cursor there. only scrolls when needed,
    // because many sites close open menus on scroll
    function highlight(message: Message) {
      const target = targetFor(message);
      if (!target) return { success: false };
      const r = target.getBoundingClientRect();
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      target.style.outline = '4px solid #14b8a6';
      target.style.outlineOffset = '3px';
      moveCursorTo(target);
      return { success: true };
    }

    // press a button, link, option, tab or date cell, after re-checking it and
    // refusing anything consequential
    function press(message: Message) {
      const target = targetFor(message);
      if (!target) return fail('the element changed or disappeared');

      const label = describeElement(target).text;
      if (stateOf(target)?.includes('disabled')) return fail('that control is disabled');
      if (isCovered(target)) return fail('it is covered by a popup or dialog, close that first (for example with its Done button)');
      if (RISKY.test(label) || (target instanceof HTMLAnchorElement && RISKY.test(target.href))) {
        return fail('that would buy, pay for or delete something, which Access OS never does');
      }

      // open links in this tab, so the agent (and the user) can follow along
      target.closest('a')?.removeAttribute('target');
      showCursorClick(target);
      target.focus({ preventScroll: true });
      // a full mouse click, the way a real one looks: some sites (like Google's
      // hotel cards) ignore element.click(), which has no click count
      const { x, y } = center(target);
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent('pointerdown', { ...mouse, buttons: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }));
      target.dispatchEvent(new PointerEvent('pointerup', { ...mouse, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', mouse));
      target.dispatchEvent(new MouseEvent('click', mouse));
      return { success: true };
    }

    // set a value the way the browser would, so frameworks like React notice
    const setNativeValue = (element: Field, value: string) =>
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value);

    // the text box that has focus right now, if it's a safe one to type into
    const focusedTextField = () => {
      const active = document.activeElement;
      return active instanceof HTMLInputElement && ['text', 'search'].includes(active.type) && !PERSONAL.test(describeElement(active).text) ? active : null;
    };

    // fill in a text field, checkbox, radio button or dropdown. answers with
    // success (the change was made) and verified (300ms later, after the
    // page's own scripts reacted, the control still shows it)
    async function setField(message: Message) {
      const target = targetFor(message);
      const value = message.value;
      if (!target) return fail('the element changed or disappeared');

      if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
        if (target.disabled || typeof value !== 'boolean' || (target.type === 'radio' && !value)) return fail('invalid selection');
        showCursorClick(target);
        if (target.checked !== value) target.click();
        if (target.checked !== value) return fail('the selection did not change');
        await sleep(300);
        return { success: true, verified: target.checked === value };
      }

      const field = target as Field;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
        return fail('that is not a form field');
      }
      if ((field as HTMLInputElement).readOnly) return fail('the field is read-only, it is probably filled by a picker or menu instead');
      if (field.disabled || typeof value !== 'string' || value.length > 1000) return fail('the field is disabled or the value is invalid');
      if (field instanceof HTMLInputElement && !TEXT_TYPES.includes(field.type)) return fail('unsupported field type');

      // dropdowns: pick the enabled option matching the value or its label
      let wanted = value;
      if (field instanceof HTMLSelectElement) {
        const option = [...field.options].find((o) => !o.disabled && (o.value === value || o.text.trim().toLowerCase() === value.toLowerCase()));
        if (!option) return fail('no such option');
        wanted = option.value;
      }

      showCursorClick(field);
      if (message.typeOut && !(field instanceof HTMLSelectElement) && value.length <= 80) return typeOut(field, value);

      setNativeValue(field, wanted);
      if (field.value !== wanted) return fail('the field did not accept the value');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      return { success: true, verified: field.value === wanted };
    }

    // type character by character, so the user can follow along and search
    // suggestions react like they would to a person
    async function typeOut(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const matches = (text: string) => text.toLowerCase().startsWith(value.toLowerCase());
      field.focus({ preventScroll: true });
      setNativeValue(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));

      // some search boxes (Google Flights) open a popup with their own input as
      // soon as you start typing: keep typing wherever the focus went
      let into: HTMLInputElement | HTMLTextAreaElement = field;
      for (const char of value) {
        into = focusedTextField() ?? into;
        if (!into.isConnected) break;
        setNativeValue(into, into.value + char);
        into.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
        await sleep(45);
      }
      into.dispatchEvent(new Event('change', { bubbles: true }));

      // let the site react, then read back whichever field holds the text now
      // (some sites move it into a popup afterwards), and once more to be sure
      await sleep(300);
      if (!matches(into.value)) into = focusedTextField() ?? into;
      if (!matches(into.value)) return fail('the field did not keep what was typed');
      await sleep(300);
      return {
        success: true,
        verified: matches(into.value),
        movedTo: into === field ? undefined : describeElement(into).text,
      };
    }

    // scroll whatever scrolls under the middle of the screen (many sites scroll
    // an inner panel, not the page). value: screens to move, or 'top'/'bottom'
    function scroll(message: Message) {
      const scrolls = (el: Element) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY);
      let box = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      // stop at <body>: its scrolling belongs to the page itself
      while (box && box !== document.body && !scrolls(box)) box = box.parentElement;
      if (box === document.body) box = null;
      // nothing scrollable in the middle: the page itself, or else its biggest scrolling panel
      const page = document.scrollingElement ?? document.documentElement;
      const biggest = () => [...document.querySelectorAll('*')].filter((el) => scrolls(el) && isShown(el))
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      const scroller = box ?? (page.scrollHeight > page.clientHeight + 20 ? page : biggest() ?? page);
      const behavior = reduceMotion() ? 'auto' : 'smooth';
      if (message.value === 'top' || message.value === 'bottom') {
        scroller.scrollTo({ top: message.value === 'top' ? 0 : scroller.scrollHeight, behavior });
      } else {
        scroller.scrollBy({ top: Number(message.value) * scroller.clientHeight, behavior });
      }
      return { success: true };
    }

    const handlers: Record<string, (message: Message) => unknown> = {
      SCROLL: scroll,
      GET_PAGE_ELEMENTS: scanPage,
      GET_PAGE_CONTENT: getPageContent,
      HIGHLIGHT_ELEMENT: highlight,
      PRESS_ELEMENT: press,
      SET_FORM_CONTROL: setField,
    };

    // returning true keeps the channel open for answers that take a moment
    browser.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
      const handler = Object.hasOwn(handlers, message.type ?? '') ? handlers[message.type!] : undefined;
      void Promise.resolve(handler?.(message)).then(sendResponse);
      return true;
    });
  },
});
