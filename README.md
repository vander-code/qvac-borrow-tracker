# Lendbook: Borrow/Return Tracker (QVAC)

Keep track of who borrowed your stuff and when it is due back. Every loan gets a due-date stamp that turns red when it is overdue, and a summary at the top tells you how many items are out.

Two things are done by an **on-device AI** using [QVAC](https://github.com/tetherto/qvac), Tether's open-source AI SDK:

- **Quick add**: type a sentence like *"Lent my drill to Sam, he'll bring it back on Friday"* and the AI fills in the item, the person and the return date. You check the details and save.
- **Write a reminder**: pick a tone (friendly, playful or firm but polite) and the AI drafts a short message you can copy and send.

The AI runs on your own computer. No API key, no cloud AI service. Your list of loans is saved in a local file (`data/loans.json`) that never leaves your machine.

![screenshot](screenshot.png)

## SDK version

`@qvac/sdk` **SDK_VERSION_HERE** (declared in `package.json`, 0.19.0 or newer)

QVAC functions used: `loadModel`, `completion` and `unloadModel`, with the `LLAMA_3_2_1B_INST_Q4_0` model.

## Install

You need [Node.js](https://nodejs.org) 22.17 or newer.

```bash
git clone https://github.com/YOUR_USERNAME/qvac-borrow-tracker.git
cd qvac-borrow-tracker
npm install
```

## Run

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

The first start downloads the AI model (about 770 MB) and the page shows a progress bar. You can add and manage loans while it loads. After the first run it works offline.

Press `Ctrl+C` in the terminal to stop.

## How it works

- `server.js` is a small web server. It stores loans in `data/loans.json`, loads the model with `loadModel`, and runs `completion` for the two AI jobs.
- `public/index.html` is the whole interface: plain HTML, CSS and JavaScript with no external requests.
- The AI is only used for text. Dates are checked in code, and the AI's guesses go into the form for you to confirm before anything is saved.

## Privacy notes

- The server only listens on `127.0.0.1`, so only your own computer can open it.
- `data/` is in `.gitignore` so your personal list is never pushed to GitHub.
- A 1B-parameter model is small and can make mistakes, so check the details before saving.

## License

MIT, see [LICENSE](LICENSE).
