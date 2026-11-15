// Runs inside the page itself. Buttons like "Visit site" open a new window with
// window.open, which Chrome's pop-up blocker stops when the click comes from
// Access OS. Opening the page in this same tab instead lets the agent (and the
// user) follow along, with no surprise tabs.
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    window.open = (url?: string | URL) => {
      if (url) location.assign(url);
      return window;
    };
  },
});
