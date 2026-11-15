# Access OS

A Chrome extension that lets people who can't use a mouse or keyboard browse and get things done by voice.

## Running it

1. `npm install`
2. Put your Anthropic API key in `server/.env` as `ANTHROPIC_API_KEY=...`
3. Start the backend: `node --env-file=server/.env server/index.mjs`
4. Build the extension: `npm run build`
5. In `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `.output/chrome-mv3`
6. Click the Access OS toolbar icon and tap the mic
