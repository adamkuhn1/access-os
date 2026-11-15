// open window.open links in the same tab, chrome blocks popups from our clicks
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
