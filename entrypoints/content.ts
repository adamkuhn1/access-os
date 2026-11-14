import { browser } from 'wxt/browser';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],

  main() {
    console.log('Access OS is running!');

    //find interactive elements on the webpage
    const buttons = document.querySelectorAll('button');
    const links = document.querySelectorAll<HTMLAnchorElement>('a[href]');
    const inputs = document.querySelectorAll('input');

    console.log('Buttons found:', buttons.length);
    console.log('Links found:', links.length);
    console.log('Inputs found:', inputs.length);

    links.forEach((link) => {
      console.log('Link text:', link.textContent?.trim());
      console.log('Link URL:', link.href);
      //highlight selected link   
      //link.style.outline = '3px solid #14b8a6';

      });    


browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT_LINKS') {
    links.forEach((link) => {
      link.style.outline = '3px solid #14b8a6';
    });

    sendResponse({ success: true });
  }

if (message.type === 'CLICK_LINK' && typeof message.text === 'string') {
  const target = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href]')
  ).find((link) =>
    link.textContent?.trim().toLowerCase() === message.text.trim().toLowerCase()
  );

  if (target) {
    sendResponse({ success: true });

    //open the link after responding
    setTimeout(() => target.click(), 100);
  } else {
    sendResponse({ success: false });
  }
}

});

  },
});


