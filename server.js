// Lendbook: a Borrow/Return Tracker.
// Your list of loans is saved in a plain file on THIS computer (data/loans.json).
// The QVAC AI runs on THIS computer too, and does two jobs:
//   1. turns a sentence like "Lent my drill to Sam until Friday" into a filled-in entry
//   2. writes a polite reminder message for an item that hasn't come back
// Nothing is sent to any cloud AI service.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadModel, completion, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'loans.json');

// ---------- Saving and loading the list of loans ----------
let loans = [];

async function readLoans() {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    loans = Array.isArray(parsed) ? parsed : [];
  } catch {
    loans = []; // no file yet, that's fine
  }
}

let saveQueue = Promise.resolve();
function saveLoans() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(loans, null, 2));
  });
  return saveQueue;
}

// ---------- Small helpers ----------
const clean = (value, max = 80) =>
  String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function daysBetween(fromYmd, toYmd) {
  const [a, b, c] = fromYmd.split('-').map(Number);
  const [x, y, z] = toYmd.split('-').map(Number);
  return Math.round((new Date(x, y - 1, z) - new Date(a, b - 1, c)) / 86400000);
}

// A little calendar the AI can copy dates from (small models are bad at date maths).
function calendarText() {
  const lines = [];
  const now = new Date();
  for (let i = 0; i < 15; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const name = d.toLocaleDateString('en-US', { weekday: 'long' });
    const tag = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    lines.push(`${name} = ${ymd(d)}${tag}`);
  }
  return lines.join('\n');
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Only allow requests that come from our own page (protects against other websites poking at localhost).
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

// ---------- The AI part (QVAC) ----------
let modelId = null;
let busy = false; // the small model does one job at a time
let status = { state: 'loading', percent: 0, message: 'Starting up...' };

// Runs the model on this device. onToken gets each piece of text as it is written.
async function runAI(history, onToken) {
  const run = completion({ modelId, history, stream: true });
  for await (const token of run.tokenStream) {
    if (onToken(token) === false) break;
  }
}

// Job 1: sentence in, structured entry out.
async function parseSentence(sentence) {
  const system =
    'You read one sentence about lending something and pull out the details. ' +
    'Reply with ONLY one JSON object shaped like {"item": "...", "person": "...", "due": "YYYY-MM-DD or null"}. ' +
    '"item" is the thing that was lent, short, without words like "my". ' +
    '"person" is who borrowed it. ' +
    '"due" is the return date, copied from the calendar below, or null if the sentence gives no date.\n\n' +
    'Calendar:\n' + calendarText() + '\n\n' +
    'Example: "Lent my red drill to Sam, he will bring it back on Friday" -> ' +
    '{"item": "red drill", "person": "Sam", "due": "<the date of Friday from the calendar>"}';

  let text = '';
  await runAI(
    [{ role: 'system', content: system }, { role: 'user', content: sentence }],
    (t) => { text += t; if (text.length > 600) return false; }
  );

  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return { ok: false };
  try {
    const obj = JSON.parse(match[0]);
    const due = validDate(obj.due) ? obj.due : '';
    return { ok: true, item: clean(obj.item), person: clean(obj.person), due };
  } catch {
    return { ok: false };
  }
}

const TONES = {
  friendly: 'warm and friendly',
  funny: 'light and playful, with a little humour',
  firm: 'polite but clear and firm',
};

function statusLine(loan) {
  const today = ymd(new Date());
  if (!loan.due) return 'no return date was set';
  const diff = daysBetween(today, loan.due);
  if (diff < 0) return `overdue by ${-diff} day${diff === -1 ? '' : 's'}`;
  if (diff === 0) return 'due today';
  return `due in ${diff} day${diff === 1 ? '' : 's'}`;
}

// ---------- Web server ----------
async function handleReminder(req, res) {
  if (!modelId) return sendJson(res, 503, { error: 'The AI is still loading. Please wait.' });
  if (busy) return sendJson(res, 429, { error: 'The AI is busy with another request. Try again in a moment.' });

  const body = await readJson(req);
  const loan = loans.find((l) => l.id === body.id);
  if (!loan) return sendJson(res, 404, { error: 'Entry not found.' });
  const tone = TONES[body.tone] || TONES.friendly;

  const system =
    'You write short messages asking someone to return something they borrowed. ' +
    'Write 2 to 4 sentences, ' + tone + '. Mention the item. Only use the facts you are given and never invent details. ' +
    'Reply with the message only, with no title and no quotation marks.';
  const facts =
    `Item: ${loan.item}\nBorrower: ${loan.person}\nLent on: ${loan.lent}\n` +
    `Return date: ${loan.due || 'not set'}\nStatus: ${statusLine(loan)}`;

  busy = true;
  let clientLeft = false;
  res.on('close', () => { clientLeft = true; });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  try {
    await runAI(
      [{ role: 'system', content: system }, { role: 'user', content: facts }],
      (t) => { if (clientLeft) return false; res.write(t); }
    );
  } catch (err) {
    console.error('Reminder error:', err);
    if (!clientLeft) res.write('\n\n[Something went wrong while writing. See the terminal for details.]');
  } finally {
    busy = false;
    if (!res.writableEnded) res.end();
  }
}

async function handleParse(req, res) {
  if (!modelId) return sendJson(res, 503, { error: 'The AI is still loading. Please wait.' });
  if (busy) return sendJson(res, 429, { error: 'The AI is busy with another request. Try again in a moment.' });
  const { text } = await readJson(req);
  const sentence = clean(text, 300);
  if (!sentence) return sendJson(res, 400, { error: 'Type a sentence first.' });

  busy = true;
  try {
    const result = await parseSentence(sentence);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('Parse error:', err);
    sendJson(res, 500, { error: 'The AI hit a problem. See the terminal for details.' });
  } finally {
    busy = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','loans','<id>','return']

    if (req.method === 'GET' && url.pathname === '/') {
      const html = await fs.readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (parts[0] !== 'api') return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && !originAllowed(req)) return sendJson(res, 403, { error: 'Forbidden' });

    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, status);
    if (req.method === 'GET' && url.pathname === '/api/loans') return sendJson(res, 200, loans);

    if (req.method === 'POST' && url.pathname === '/api/loans') {
      const body = await readJson(req);
      const item = clean(body.item);
      const person = clean(body.person);
      if (!item || !person) return sendJson(res, 400, { error: 'Please fill in both the item and the person.' });
      const loan = {
        id: randomUUID(),
        item,
        person,
        lent: ymd(new Date()),
        due: validDate(body.due) ? body.due : '',
        note: clean(body.note, 200),
        returned: '',
      };
      loans.unshift(loan);
      await saveLoans();
      return sendJson(res, 201, loan);
    }

    if (req.method === 'POST' && url.pathname === '/api/parse') return await handleParse(req, res);
    if (req.method === 'POST' && url.pathname === '/api/reminder') return await handleReminder(req, res);

    if (parts[1] === 'loans' && parts[2]) {
      const loan = loans.find((l) => l.id === parts[2]);
      if (!loan) return sendJson(res, 404, { error: 'Entry not found.' });

      if (req.method === 'POST' && parts[3] === 'return') {
        loan.returned = loan.returned ? '' : ymd(new Date()); // press again to undo
        await saveLoans();
        return sendJson(res, 200, loan);
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        loans = loans.filter((l) => l.id !== loan.id);
        await saveLoans();
        return sendJson(res, 200, { ok: true });
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.end();
  }
});

await readLoans();
// "127.0.0.1" means only YOUR computer can open this app.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nLendbook is open at http://localhost:${PORT}`);
  console.log('Loading the AI model (the first run downloads it, this can take a few minutes)...\n');
});

// Load the model in the background so the page opens right away and shows progress.
(async () => {
  try {
    modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: 'llm',
      onProgress: (p) => {
        const pct = Math.round(typeof p === 'number' ? p : p?.percentage || 0);
        status = { state: 'loading', percent: pct, message: `Downloading the AI model: ${pct}%` };
      },
    });
    status = { state: 'ready', percent: 100, message: 'AI ready. It runs on this computer.' };
    console.log('AI model ready.');
  } catch (err) {
    console.error('Could not load the model:', err);
    status = { state: 'error', percent: 0, message: 'The AI failed to load. See the terminal for details. Your list still works.' };
  }
})();

async function shutdown() {
  console.log('\nShutting down...');
  try { if (modelId) await unloadModel({ modelId }); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
