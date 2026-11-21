'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

// 輕量讀取專案根目錄的 .env，不額外依賴 dotenv 套件。
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  }
}
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'change-me-now';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const DEFAULT_QUESTIONS_FILE = path.join(__dirname, 'data', 'default-questions.json');
const QUESTION_MS = 10_000;
const LEADERBOARD_MS = 6_500;
const TOTAL_QUESTIONS = 8; // 總共 8 題，包含 1 題暖身題
const MAX_PLAYERS = 200;

if (!process.env.HOST_PASSWORD) {
  console.warn('⚠️ 未設定 HOST_PASSWORD，目前主持人密碼為 change-me-now，正式部署前務必設定環境變數。');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 20_000, pingTimeout: 20_000 });
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function initialQuestions() {
  return readJson(DEFAULT_QUESTIONS_FILE, []);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
let store = readJson(STORE_FILE, { questions: initialQuestions(), history: [], activeGame: null });
if (!Array.isArray(store.questions) || store.questions.length !== TOTAL_QUESTIONS) {
  store.questions = initialQuestions();
}
if (!Array.isArray(store.history)) store.history = [];
if (!Object.prototype.hasOwnProperty.call(store, 'activeGame')) store.activeGame = null;

let writeQueue = Promise.resolve();
function persistStore() {
  const snapshot = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(async () => {
    const temp = `${STORE_FILE}.tmp`;
    await fs.promises.writeFile(temp, snapshot, 'utf8');
    await fs.promises.rename(temp, STORE_FILE);
  }).catch(err => console.error('資料寫入失敗：', err));
  return writeQueue;
}

function cookieMap(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const idx = part.indexOf('=');
    return idx < 0 ? ['', ''] : [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
  }).filter(([k]) => k));
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', HOST_PASSWORD).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', HOST_PASSWORD).update(body).digest();
  let provided;
  try { provided = Buffer.from(sig, 'base64url'); } catch { return false; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now();
  } catch { return false; }
}

function isHostRequest(req) {
  return verifyToken(cookieMap(req.headers.cookie || '').kahoot_host);
}

function requireHost(req, res, next) {
  if (!isHostRequest(req)) return res.status(401).json({ error: '請先登入主持人帳號。' });
  next();
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, maxLength);
}

function validateQuestions(input) {
  if (!Array.isArray(input) || input.length !== TOTAL_QUESTIONS) {
    return { error: '題目必須剛好 9 題：1 題暖身題 + 8 題正式題。' };
  }
  const questions = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i] || {};
    const question = cleanText(item.question, 180);
    const options = Array.isArray(item.options) ? item.options.map(v => cleanText(v, 70)) : [];
    const correctIndex = Number(item.correctIndex);
    if (!question) return { error: `第 ${i + 1} 題題目不可空白。` };
    if (options.length !== 4 || options.some(v => !v)) return { error: `第 ${i + 1} 題必須填滿 4 個選項。` };
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) return { error: `第 ${i + 1} 題請選擇正確答案。` };
    questions.push({
      type: i === 0 ? 'warmup' : 'regular',
      question,
      options,
      correctIndex,
      explanation: cleanText(item.explanation, 240)
    });
  }
  return { questions };
}

function rankPlayers() {
  if (!game) return [];
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score || a.lastAwardAt - b.lastAwardAt || a.name.localeCompare(b.name, 'zh-Hant'))
    .map((p, index) => ({ rank: index + 1, id: p.id, name: p.name, score: p.score }));
}

function publicState() {
  if (!game) return { phase: 'no-game' };
  const q = game.currentIndex >= 0 ? store.questions[game.currentIndex] : null;
  const state = {
    phase: game.phase,
    pin: game.pin,
    playerCount: game.players.size,
    questionIndex: game.currentIndex,
    totalQuestions: TOTAL_QUESTIONS,
    isWarmup: game.currentIndex === 0,
    startedAt: game.startedAt,
    endsAt: game.endsAt,
    leaderboard: rankPlayers().slice(0, 10),
    answeredCount: [...game.players.values()].filter(p => p.answers[game.currentIndex] !== undefined).length
  };
  if (game.phase === 'question' && q) {
    state.question = { question: q.question, options: q.options };
  }
  if ((game.phase === 'leaderboard' || game.phase === 'finished') && q) {
    state.question = { question: q.question, options: q.options, correctIndex: q.correctIndex, explanation: q.explanation };
    state.lastQuestionCorrectIndex = q.correctIndex;
  }
  return state;
}

function sendState(target) {
  const state = publicState();
  if (target) target.emit('game:state', state);
  else if (game) {
    io.to(`game:${game.pin}`).emit('game:state', state);
    io.to('host-room').emit('game:state', state);
    persistActiveGame();
    for (const player of game.players.values()) {
      if (player.socketId) {
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) sendPrivateState(playerSocket);
      }
    }
  }
}

function sendPrivateState(socket) {
  if (!game || !socket.data.playerId) return;
  const player = game.players.get(socket.data.playerId);
  if (!player) return;
  socket.emit('player:private', {
    playerId: player.id,
    name: player.name,
    score: player.score,
    answerIndex: player.answers[game.currentIndex] ?? null
  });
}

function restoreActiveGame() {
  const saved = store.activeGame;
  if (!saved || !saved.pin || !Array.isArray(saved.players)) return null;
  const players = new Map(saved.players.map(p => [p.id, { ...p, socketId: null, answers: p.answers || {} }]));
  return {
    pin: saved.pin,
    phase: saved.phase || 'lobby',
    currentIndex: Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1,
    startedAt: saved.startedAt || null,
    endsAt: saved.endsAt || null,
    leaderboardUntil: saved.leaderboardUntil || null,
    players
  };
}

let game = restoreActiveGame();
let questionTimer = null;
let leaderboardTimer = null;

function persistActiveGame() {
  if (!game || game.phase === 'finished') { store.activeGame = null; return persistStore(); }
  store.activeGame = {
    pin: game.pin,
    phase: game.phase,
    currentIndex: game.currentIndex,
    startedAt: game.startedAt,
    endsAt: game.endsAt,
    leaderboardUntil: game.leaderboardUntil || null,
    players: [...game.players.values()].map(({ socketId, ...player }) => player)
  };
  return persistStore();
}

function clearTimers() {
  if (questionTimer) clearTimeout(questionTimer);
  if (leaderboardTimer) clearTimeout(leaderboardTimer);
  questionTimer = null;
  leaderboardTimer = null;
}

async function archiveGame() {
  if (!game) return;
  const result = {
    pin: game.pin,
    finishedAt: new Date().toISOString(),
    players: rankPlayers().slice(0, 200),
    totalPlayers: game.players.size
  };
  store.history.unshift(result);
  store.history = store.history.slice(0, 50);
  store.activeGame = null;
  await persistStore();
}

function settleQuestion() {
  if (!game || game.phase !== 'question') return;
  const q = store.questions[game.currentIndex];
  const now = Date.now();
  for (const player of game.players.values()) {
    const answer = player.answers[game.currentIndex];
    if (!answer || answer.choice !== q.correctIndex || answer.awarded) continue;
    const elapsed = Math.min(QUESTION_MS, Math.max(0, answer.at - game.startedAt));
    const points = Math.max(500, Math.round(1000 - (elapsed / QUESTION_MS) * 500));
    player.score += points;
    player.lastAwardAt = answer.at;
    answer.awarded = points;
  }
  game.phase = 'leaderboard';
  game.endsAt = null;
  game.leaderboardUntil = Date.now() + LEADERBOARD_MS;
  sendState();
  leaderboardTimer = setTimeout(advanceAfterLeaderboard, LEADERBOARD_MS);
}


async function advanceAfterLeaderboard() {
  if (!game || game.phase !== 'leaderboard') return;
  game.leaderboardUntil = null;
  if (game.currentIndex === TOTAL_QUESTIONS - 1) {
    game.phase = 'finished';
    await archiveGame();
  } else {
    game.phase = 'ready';
  }
  sendState();
}

function startQuestion() {
  if (!game) return { error: '目前沒有遊戲房間。' };
  if (game.phase === 'lobby') {
    game.currentIndex = 0;
  } else if (game.phase === 'ready') {
    game.currentIndex += 1;
  } else {
    return { error: '目前階段不能開始下一題。' };
  }
  if (game.currentIndex >= TOTAL_QUESTIONS) return { error: '題目已全部完成。' };
  clearTimers();
  game.phase = 'question';
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + QUESTION_MS;
  sendState();
  questionTimer = setTimeout(settleQuestion, QUESTION_MS);
  return { ok: true, questionIndex: game.currentIndex };
}

function makePin() {
  let pin;
  do { pin = String(100000 + crypto.randomInt(0, 900000)); }
  while (game && game.pin === pin);
  return pin;
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/host/me', (req, res) => res.json({ authenticated: isHostRequest(req) }));

app.post('/api/host/login', (req, res) => {
  const supplied = String(req.body?.password || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(HOST_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '密碼不正確。' });
  }
  const token = signPayload({ exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.cookie('kahoot_host', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  });
  res.json({ ok: true });
});

app.post('/api/host/logout', requireHost, (req, res) => {
  res.clearCookie('kahoot_host', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});

app.get('/api/host/questions', requireHost, (_req, res) => res.json({ questions: store.questions }));
app.put('/api/host/questions', requireHost, async (req, res) => {
  if (game && game.phase !== 'finished') return res.status(409).json({ error: '遊戲進行中，請先完成或結束目前場次，再修改題目。' });
  const validated = validateQuestions(req.body?.questions);
  if (validated.error) return res.status(400).json({ error: validated.error });
  store.questions = validated.questions;
  await persistStore();
  res.json({ ok: true, message: '題目已儲存。' });
});

app.post('/api/host/create-game', requireHost, (req, res) => {
  if (game && game.phase !== 'finished') return res.status(409).json({ error: '目前已有一場尚未結束的遊戲。' });
  clearTimers();
  game = {
    pin: makePin(),
    phase: 'lobby',
    currentIndex: -1,
    startedAt: null,
    endsAt: null,
    leaderboardUntil: null,
    players: new Map()
  };
  sendState();
  res.json({ ok: true, pin: game.pin });
});

app.post('/api/host/start-question', requireHost, (req, res) => {
  const result = startQuestion();
  if (result.error) return res.status(409).json(result);
  res.json(result);
});

app.get('/api/host/qr', requireHost, async (req, res) => {
  const pin = String(req.query.pin || '');
  if (!/^\d{6}$/.test(pin) || !game || game.pin !== pin) return res.status(400).json({ error: '房間代碼無效。' });
  const joinUrl = `${req.protocol}://${req.get('host')}/?pin=${pin}`;
  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
    res.json({ dataUrl, joinUrl });
  } catch (err) {
    res.status(500).json({ error: 'QR Code 產生失敗。' });
  }
});

io.use((socket, next) => {
  const cookies = cookieMap(socket.handshake.headers.cookie || '');
  socket.data.isHost = verifyToken(cookies.kahoot_host);
  next();
});

io.on('connection', socket => {
  if (socket.data.isHost) {
    socket.join('host-room');
    socket.emit('game:state', publicState());
  }

  socket.on('host:watch', () => {
    if (!socket.data.isHost) return socket.emit('game:error', '主持人登入已失效，請重新登入。');
    socket.emit('game:state', publicState());
  });

  socket.on('player:join', ({ pin, name, playerId } = {}) => {
    pin = String(pin || '').trim();
    name = cleanText(name, 16);
    playerId = cleanText(playerId, 80);
    if (!game || pin !== game.pin) return socket.emit('player:error', '找不到這個遊戲代碼，請確認主持人畫面上的 PIN。');
    if (!name) return socket.emit('player:error', '請先輸入暱稱。');
    if (!/^[\w-]{8,80}$/.test(playerId)) return socket.emit('player:error', '玩家識別碼無效，請重新整理頁面。');

    const existing = game.players.get(playerId);
    if (!existing && game.phase !== 'lobby') return socket.emit('player:error', '遊戲已開始，現在不能加入新玩家。');
    if (!existing && game.players.size >= MAX_PLAYERS) return socket.emit('player:error', `本場人數已達上限（${MAX_PLAYERS} 人）。`);
    const nameTaken = [...game.players.values()].some(p => p.id !== playerId && p.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (nameTaken) return socket.emit('player:error', '這個暱稱已有人使用，請換一個名字。');

    const player = existing || { id: playerId, name, score: 0, answers: {}, lastAwardAt: Date.now() };
    player.name = name;
    player.socketId = socket.id;
    game.players.set(playerId, player);
    socket.data.playerId = playerId;
    socket.data.pin = pin;
    socket.join(`game:${pin}`);
    sendState();
    sendPrivateState(socket);
    persistStore();
    socket.emit('player:joined', { playerId, name });
  });

  socket.on('player:answer', ({ choice } = {}) => {
    if (!game || socket.data.pin !== game.pin || game.phase !== 'question') return;
    const player = game.players.get(socket.data.playerId);
    if (!player || player.answers[game.currentIndex] !== undefined) return;
    choice = Number(choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    player.answers[game.currentIndex] = { choice, at: Date.now(), awarded: 0 };
    socket.emit('player:answer-accepted', { choice });
    sendState();
    persistStore();
  });

  socket.on('disconnect', () => {
    if (game && socket.data.playerId) {
      const player = game.players.get(socket.data.playerId);
      if (player && player.socketId === socket.id) player.socketId = null;
    }
  });
});

app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (game) {
  console.log(`正在還原遊戲房間 ${game.pin}（${game.phase}）`);
  if (game.phase === 'question') {
    const remaining = Math.max(0, (game.endsAt || Date.now()) - Date.now());
    questionTimer = setTimeout(settleQuestion, remaining);
  } else if (game.phase === 'leaderboard') {
    const remaining = Math.max(0, (game.leaderboardUntil || Date.now()) - Date.now());
    leaderboardTimer = setTimeout(advanceAfterLeaderboard, remaining);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kahoot Party Quiz 正在 http://0.0.0.0:${PORT}`);
  console.log(`資料儲存位置：${DATA_DIR}`);
});
