'use strict';

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SETUP_SECRET = process.env.SETUP_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const MAX_ACTIVE_SESSIONS = 10;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 12;
const GEMINI_MAX_ATTEMPTS = 3;

const sessions = new Map();
const histories = new Map();
const updateIds = new Map();
const chatQueues = new Map();

const SYSTEM_INSTRUCTION = `
Anda ialah Teman Hati, pembantu AI sokongan emosi untuk murid sekolah rendah.

GAYA:
- Gunakan Bahasa Melayu yang mudah, lembut dan mesra kanak-kanak.
- Dengar dengan empati. Jangan menghukum, memperlekehkan atau menyalahkan murid.
- Tanya satu soalan pada satu masa.
- Akui perasaan murid tanpa membuat andaian yang belum disahkan.
- Bantu murid mengenal pasti perasaan dan memikirkan langkah kecil yang selamat.
- Jawab dengan ringkas dan jelas.

BATASAN:
- Anda ialah AI, bukan kaunselor manusia, guru atau ahli psikologi.
- Jangan membuat diagnosis atau menjanjikan kerahsiaan mutlak.
- Jangan meminta nama penuh, alamat, nombor telefon, kata laluan atau maklumat pengenalan diri.
- Jangan mendesak murid menceritakan perkara yang menyakitkan.
- Jangan mendakwa telah menghubungi sesiapa jika anda tidak melakukannya.

KESELAMATAN:
- Galakkan murid berbincang dengan guru, ibu bapa/penjaga atau orang dewasa dipercayai.
- Jika berlaku buli, ugutan, penderaan atau bahaya, dengar tanpa menyalahkan murid dan galakkan mereka memberitahu orang dewasa dipercayai dengan segera.
- Jika murid mungkin mencederakan diri, membunuh diri atau berada dalam bahaya segera, utamakan keselamatan. Galakkan mereka pergi kepada orang dewasa dipercayai yang berada berdekatan sekarang dan mendapatkan bantuan kecemasan setempat jika perlu.
- Jangan jadikan AI satu-satunya sumber bantuan ketika kecemasan.
- Jangan memberikan arahan untuk mencederakan diri sendiri atau orang lain.

CARA MENJAWAB:
1. Akui perasaan murid.
2. Ringkaskan apa yang anda fahami.
3. Tanya satu soalan yang sesuai.
4. Cadangkan langkah kecil yang selamat apabila sesuai.
5. Galakkan bantuan orang dewasa dipercayai jika diperlukan.

Balas dalam Bahasa Melayu kecuali murid meminta bahasa lain.
`.trim();

const TEXT = {
  welcome: '🌷 Hai! Selamat datang ke Jom Luah — Teman Hati 💙\n\n' +
    'Kamu boleh berkongsi perasaan dan perkara yang mengganggu fikiran kamu di sini.\n\n' +
    '🤖 Saya ialah AI, bukan kaunselor manusia. Jika kamu berada dalam bahaya atau berasa tidak selamat, beritahu orang dewasa yang kamu percayai.\n\n' +
    '💬 Apa yang sedang kamu rasa hari ini?\n\n' +
    'Taip /bantuan untuk panduan atau /tamat untuk menamatkan sesi.',
  help: '💙 BANTUAN TEMAN HATI\n\n' +
    '/mula — Mulakan sesi baharu\n' +
    '/bantuan — Paparkan panduan\n' +
    '/tamat — Tamatkan sesi dan padam sejarah perbualan yang disimpan oleh bot\n\n' +
    'Kamu boleh menghantar mesej teks untuk berbual.\n\n' +
    '🌷 Jangan kongsi kata laluan, alamat rumah atau maklumat peribadi. Saya ialah AI. Untuk perkara serius atau jika kamu tidak selamat, dapatkan bantuan orang dewasa yang dipercayai.',
  ended: '🌷 Terima kasih kerana berkongsi dengan Teman Hati.\n\n' +
    'Sesi telah ditamatkan dan sejarah perbualan yang disimpan dalam memori bot telah dipadam.\n\n' +
    'Taip /mula jika kamu mahu berbual lagi. 💙',
  busy: '💙 Maaf ya, Teman Hati sedang menemani ramai murid sekarang. Cuba lagi sebentar nanti.',
  technical: '🌷 Maaf ya, Teman Hati sedang mengalami gangguan teknikal. Cuba hantar mesej sekali lagi sebentar nanti. Jika kamu dalam bahaya atau memerlukan bantuan segera, beritahu orang dewasa yang kamu percayai sekarang. 💙',
  textOnly: '💬 Buat masa ini, Teman Hati hanya boleh menerima mesej teks.'
};

function getBotApiUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegram(method, body) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN belum ditetapkan.');
  const response = await fetch(getBotApiUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data.result;
}

async function sendMessage(chatId, text) {
  try {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: String(text || '').slice(0, 4000)
    });
  } catch (err) {
    console.error('Gagal menghantar mesej Telegram:', err.message);
  }
}

async function sendTyping(chatId) {
  try {
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch (err) {
    console.warn('sendChatAction gagal:', err.message);
  }
}

function pruneSessions() {
  const now = Date.now();
  for (const [chatId, session] of sessions.entries()) {
    if (!session.lastActivity || now - session.lastActivity > SESSION_TIMEOUT_MS) {
      sessions.delete(chatId);
      histories.delete(chatId);
    }
  }
}

function openSession(chatId, resetHistory = false) {
  pruneSessions();
  const existing = sessions.has(chatId);
  if (!existing && sessions.size >= MAX_ACTIVE_SESSIONS) return false;
  const now = Date.now();
  sessions.set(chatId, { startedAt: existing ? sessions.get(chatId).startedAt : now, lastActivity: now });
  if (resetHistory || !histories.has(chatId)) histories.set(chatId, []);
  return true;
}

function touchSession(chatId) {
  const session = sessions.get(chatId);
  if (!session || Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(chatId);
    histories.delete(chatId);
    return false;
  }
  session.lastActivity = Date.now();
  sessions.set(chatId, session);
  return true;
}

function enqueueChat(chatId, task) {
  const previous = chatQueues.get(chatId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  chatQueues.set(chatId, next);
  next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  }).catch(() => {});
  return next;
}

async function processMessage(message) {
  if (!message || !message.chat || !message.chat.id) return;
  if (message.from && message.from.is_bot) return;
  // Hadkan bot kepada chat peribadi untuk melindungi luahan murid.
  if (message.chat.type && message.chat.type !== 'private') return;

  const chatId = String(message.chat.id);
  const text = String(message.text || '').trim();
  if (!text) {
    await sendMessage(chatId, TEXT.textOnly);
    return;
  }

  const command = text.split(/\s+/)[0].toLowerCase().split('@')[0];
  if (command === '/start' || command === '/mula') {
    if (!openSession(chatId, true)) {
      await sendMessage(chatId, TEXT.busy);
      return;
    }
    await sendMessage(chatId, TEXT.welcome);
    return;
  }
  if (command === '/bantuan' || command === '/help') {
    await sendMessage(chatId, TEXT.help);
    return;
  }
  if (command === '/tamat' || command === '/end') {
    sessions.delete(chatId);
    histories.delete(chatId);
    await sendMessage(chatId, TEXT.ended);
    return;
  }
  if (text.startsWith('/')) {
    await sendMessage(chatId, 'Arahan tidak dikenali. Taip /bantuan untuk melihat arahan yang tersedia.');
    return;
  }

  // Soalan biasa boleh terus memulakan sesi tanpa /mula.
  if (!sessions.has(chatId) && !openSession(chatId, false)) {
    await sendMessage(chatId, TEXT.busy);
    return;
  }
  if (!touchSession(chatId)) {
    if (!openSession(chatId, false)) {
      await sendMessage(chatId, TEXT.busy);
      return;
    }
  }

  await sendTyping(chatId);
  const answer = await askGemini(chatId, text);
  await sendMessage(chatId, answer);
}

async function askGemini(chatId, userText) {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY belum ditetapkan.');
    return TEXT.technical;
  }

  const history = histories.get(chatId) || [];
  const contents = history.concat([{ role: 'user', parts: [{ text: userText }] }]);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 600 }
  };

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    let status = 0;
    let body = '';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000)
      });
      status = response.status;
      body = await response.text();

      if (response.ok) {
        const data = JSON.parse(body);
        const answer = (data.candidates?.[0]?.content?.parts || [])
          .map(part => part.text || '')
          .join('')
          .trim();
        if (!answer) {
          console.error('Gemini tidak memberikan teks jawapan:', body.slice(0, 600));
          return TEXT.technical;
        }
        const updated = contents.concat([{ role: 'model', parts: [{ text: answer }] }]);
        histories.set(chatId, updated.slice(-HISTORY_LIMIT));
        return answer;
      }

      console.error(`Gemini HTTP ${status}, percubaan ${attempt}: ${body.slice(0, 600)}`);
      const retryable = [408, 429, 500, 502, 503, 504].includes(status);
      if (!retryable || attempt === GEMINI_MAX_ATTEMPTS) break;
    } catch (err) {
      console.error(`Gemini gagal, percubaan ${attempt}: ${err.message}`);
      if (attempt === GEMINI_MAX_ATTEMPTS) break;
    }

    // Cuba semula secara ringkas sahaja supaya respons tidak terlalu lambat.
    await new Promise(resolve => setTimeout(resolve, 700 * attempt));
  }

  return TEXT.technical;
}

function rememberUpdate(updateId) {
  if (updateIds.has(updateId)) return false;
  updateIds.set(updateId, Date.now());
  if (updateIds.size > 5000) {
    const oldest = updateIds.keys().next().value;
    updateIds.delete(oldest);
  }
  return true;
}

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'Jom Luah — Teman Hati', model: GEMINI_MODEL });
});
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Telegram menghantar setiap mesej baharu ke endpoint ini.
// Balas 200 dahulu supaya Telegram tidak mengulang kemas kini
// hanya kerana Gemini mengambil masa untuk menjawab.
app.post('/telegram', (req, res) => {
  if (!WEBHOOK_SECRET || req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.status(403).send('Forbidden');
  }

  const update = req.body;
  if (!update || update.update_id === undefined) {
    return res.status(200).send('ok');
  }
  if (!rememberUpdate(String(update.update_id))) {
    return res.status(200).send('duplicate ignored');
  }

  res.status(200).send('ok');

  if (update.message) {
    const chatId = update.message.chat?.id ? String(update.message.chat.id) : null;
    const task = () => processMessage(update.message);
    if (chatId) {
      enqueueChat(chatId, task).catch(err => console.error('Pemprosesan mesej gagal:', err));
    } else {
      task().catch(err => console.error('Pemprosesan mesej gagal:', err));
    }
  }
});

// Daftarkan webhook sekali selepas deploy dengan membuka URL ini.
// Contoh: /setup-webhook?key=SETUP_SECRET_ANDA&drop_pending=true
app.get('/setup-webhook', async (req, res) => {
  if (!SETUP_SECRET || req.query.key !== SETUP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  if (!TELEGRAM_BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'Tetapkan TELEGRAM_BOT_TOKEN, PUBLIC_URL dan WEBHOOK_SECRET dalam Render Environment.'
    });
  }

  try {
    const result = await telegram('setWebhook', {
      url: `${PUBLIC_URL}/telegram`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message'],
      drop_pending_updates: String(req.query.drop_pending || 'false') === 'true'
    });
    res.status(200).json({ ok: true, webhook_set: true, result });
  } catch (err) {
    console.error('Gagal memasang webhook:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jom Luah berjalan pada port ${PORT}; model=${GEMINI_MODEL}`);
});
