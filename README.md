# Access OS

Access OS is a Chrome extension for people who can't use a mouse or keyboard. You say what you want done, like "find me a one-way flight from Detroit to Boston next Friday", and Access OS works the browser for you. It opens the right site, fills in forms, presses buttons, reads the results and speaks the answer back.

It runs in Chrome's side panel. A small local server sends each step to Claude.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Safety and privacy](#safety-and-privacy)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Hands-free control.** Speak a goal, or type it. Answers are read aloud.
- **Works on real websites.** Fills fields, picks dropdown options and dates, presses buttons, scrolls, goes back and opens new pages.
- **Answers questions from the page.** Reads results such as flight prices, stock prices or news and sums them up in a sentence or two.
- **Follow-ups.** Remembers the last exchange, so "what about the day after?" works.
- **Voice commands.** Say "scroll down", "a little more", "go back" or "stop" at any time.
- **Built-in limits.** It won't buy, pay for or delete anything. It also checks a search form before it submits it.

## How it works

```
┌──────────────┐   goal + page controls   ┌──────────────────┐   prompt   ┌────────┐
│  Side panel  │ ───────────────────────▶ │  Local server    │ ─────────▶ │ Claude │
│  (React UI,  │ ◀─────────────────────── │  127.0.0.1:3001  │ ◀───────── │  API   │
│ speech, loop)│      next action         └──────────────────┘            └────────┘
└──────┬───────┘
       │ scan / click / type / read
┌──────▼───────┐
│Content script│  runs inside the current web page
└──────────────┘
```

1. The **side panel** listens for speech using Chrome's Web Speech API and runs the agent loop.
2. The **content script** lists the controls on the current page, such as fields, buttons and links. It also carries out actions and reads page text.
3. The **local server** (`server/index.mjs`) asks Claude for the next step. It checks Claude's reply before passing it back to the panel. For example, it confirms the element ID exists and the search form shows the right values.
4. When the answer is on the page, the panel sends the page text to `/page/analyze`. That step returns a short answer, and the panel speaks it.

## Requirements

| Requirement       | Version / notes                                       |
| ----------------- | ----------------------------------------------------- |
| Google Chrome     | 116 or newer (needs the Side Panel API)               |
| Node.js           | 20.6 or newer (needs `--env-file`)                    |
| Anthropic API key | Get one from [console.anthropic.com](https://console.anthropic.com/) |
| Microphone        | Optional. You can type instead.                       |

## Getting started

### 1. Install dependencies

```bash
git clone https://github.com/adamkuhn1/access-os.git
cd access-os
npm install
```

### 2. Add your API key

Create `server/.env`. Git ignores this file.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > server/.env
```

### 3. Start the backend

```bash
node --env-file=server/.env server/index.mjs
```

You should see `Access OS backend running on port 3001`. To check it's running, open `http://127.0.0.1:3001/health`.

### 4. Build and load the extension

```bash
npm run build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `.output/chrome-mv3` folder.

### 5. Use it

Click the Access OS icon in the toolbar to open the side panel, then tap the mic. The first time, a tab opens and asks for microphone access. Allow it, then go back to the panel.

## Usage

Try saying:

- "Find the cheapest one-way flight from Chicago to Denver next Tuesday."
- "How did the S&P 500 do today?"
- "Search Amazon for noise-cancelling headphones."
- "Scroll down a little." / "Go back." / "Stop."

The panel shows each step as it happens and speaks the final answer. If something is missing, like where you're flying from, Access OS will ask.

## Safety and privacy

- **No purchases, payments or deletions.** The content script blocks buttons with words like *buy*, *pay*, *checkout* or *delete*. If a task needs one, Access OS does the rest and tells you what to do yourself.
- **Personal fields stay private.** For fields such as name, email, address, card or password, the content script only reports whether the field is filled in. It never sends what's in it.
- **Web pages can't give it orders.** Page text and controls are treated as data, so instructions hidden in a page are ignored.
- **Answers are checked against the page.** Evidence lines that aren't actually on the page are thrown out.
- **Each run has limits:** 15 steps, 6 page loads and 3 page reads.
- **Everything except Claude stays on your machine.** The server only listens on `127.0.0.1` and doesn't log requests.

## Project structure

```
access-os/
├── entrypoints/
│   ├── background.ts          # Opens the side panel from the toolbar icon
│   ├── content.ts             # Scans the page, clicks, types and reads text
│   ├── same-tab.content.ts    # Opens window.open() links in the same tab
│   ├── mic-permission/        # One-time microphone permission page
│   └── sidepanel/
│       ├── App.tsx            # UI, speech recognition and text-to-speech
│       ├── agent.ts           # Agent loop, limits and retries
│       └── style.css
├── server/
│   └── index.mjs              # Local backend that calls the Claude API
├── public/icon/               # Extension icons
├── wxt.config.ts              # WXT and manifest settings
└── package.json
```

## Development

Built with [WXT](https://wxt.dev/), React 19, TypeScript and the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).

| Command           | What it does                                       |
| ----------------- | -------------------------------------------------- |
| `npm run dev`     | Starts WXT in dev mode with hot reload             |
| `npm run build`   | Builds the extension into `.output/chrome-mv3`     |
| `npm run zip`     | Packages the extension as a `.zip`                 |
| `npm run compile` | Type-checks the project without building           |

Keep the backend running in another terminal while you work. The model is set by `MODEL` in `server/index.mjs` (currently `claude-haiku-5-5`).

## Troubleshooting

| Problem                                  | Fix                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "Microphone permission denied"           | Tap the mic to open the permission page. If it's blocked, click the icon left of the address bar, set Microphone to **Allow**, then reload. |
| Nothing happens after a request          | Check that the backend is running and that `http://127.0.0.1:3001/health` returns `{"status":"ok"}`.   |
| `401` or auth errors in the server logs  | Check `ANTHROPIC_API_KEY` in `server/.env`.                                                           |
| The extension doesn't work on a page     | Content scripts only run on `http(s)` pages, not `chrome://` pages or the Chrome Web Store. Reload the tab after installing. |
| "Speech recognition needs a network connection" | Chrome's speech recognition runs online. Check your connection.                               |
