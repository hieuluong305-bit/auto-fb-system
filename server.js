const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (!err) {
    db.run(`CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      name TEXT,
      access_token TEXT,
      telegram_chat_id TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_name TEXT,
      phone TEXT,
      comment_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ SQLite Database ready');
  }
});

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  bot.start((ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));
  bot.launch().catch(console.error);
}

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const BANNED_KEYWORDS = ['cam kết 100%', 'trị dứt điểm', 'thuốc', 'chữa khỏi', 'hàng fake', 'hàng auth', 'tuyển sỉ', 'giảm cân cấp tốc'];

app.get('/api/pages', (req, res) => {
  db.all('SELECT * FROM pages', [], (err, rows) => res.json(rows || []));
});

app.post('/api/pages', (req, res) => {
  const { id, name, access_token, telegram_chat_id } = req.body;
  db.run('INSERT OR REPLACE INTO pages (id, name, access_token, telegram_chat_id) VALUES (?, ?, ?, ?)',
    [id, name, access_token, telegram_chat_id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.post('/api/ai/generate', async (req, res) => {
  const { product, framework } = req.body;
  if (!openai) return res.status(400).json({ error: 'Chưa cấu hình OPENAI_API_KEY' });

  try {
    const prompt = `Viết bài FB cho: "${product}" theo công thức ${framework}. Không chứa từ: ${BANNED_KEYWORDS.join(', ')}. Gợi ý 5 hashtag.`;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }]
    });
    const content = response.choices[0].message.content;
    const warnings = BANNED_KEYWORDS.filter(k => content.toLowerCase().includes(k.toLowerCase()));
    res.json({ content, warnings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/posts/publish', async (req, res) => {
  const { pageIds, content, mediaUrl, isReels } = req.body;
  res.json({ success: true, message: 'Đang đăng bài giãn cách...' });

  for (let i = 0; i < pageIds.length; i++) {
    const pageId = pageIds[i];
    db.get('SELECT * FROM pages WHERE id = ?', [pageId], async (err, page) => {
      if (!page) return;
      if (i > 0) await new Promise(r => setTimeout(r, 20000));
      try {
        if (isReels && mediaUrl) {
          const init = await axios.post(`https://graph.facebook.com/v19.0/${page.id}/video_reels`, {
            upload_phase: 'start',
            access_token: page.access_token
          });
          await axios.post(`https://rupload.facebook.com/video-upload/v19.0/${init.data.video_id}`, {}, {
            headers: { 'Authorization': `OAuth ${page.access_token}`, 'file_url': mediaUrl }
          });
          await axios.post(`https://graph.facebook.com/v19.0/${page.id}/video_reels`, {
            upload_phase: 'finish',
            video_id: init.data.video_id,
            video_state: 'PUBLISHED',
            description: content,
            access_token: page.access_token
          });
        } else if (mediaUrl) {
          await axios.post(`https://graph.facebook.com/v19.0/${page.id}/photos`, {
            url: mediaUrl,
            caption: content,
            access_token: page.access_token
          });
        } else {
          await axios.post(`https://graph.facebook.com/v19.0/${page.id}/feed`, {
            message: content,
            access_token: page.access_token
          });
        }
      } catch (e) {
        console.error(e.response?.data || e.message);
      }
    });
  }
});

app.get('/api/leads', (req, res) => {
  db.all('SELECT * FROM leads ORDER BY id DESC LIMIT 50', [], (err, rows) => res.json(rows || []));
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.FB_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
          const comment = change.value;
          const message = comment.message || "";
          const commentId = comment.comment_id;
          const phoneRegex = /(0|\+84)(3|5|7|8|9)[0-9]{8}\b/;
          const match = message.match(phoneRegex);

          if (match) {
            const detectedPhone = match[0];
            db.get('SELECT * FROM pages WHERE id = ?', [entry.id], async (err, page) => {
              if (!page) return;
              await axios.post(`https://graph.facebook.com/v19.0/${commentId}`, { is_hidden: true }, {
                params: { access_token: page.access_token }
              }).catch(() => {});

              db.run('INSERT INTO leads (page_name, phone, comment_text) VALUES (?, ?, ?)',
                [page.name, detectedPhone, message]);

              if (bot && page.telegram_chat_id) {
                bot.telegram.sendMessage(page.telegram_chat_id, 
                  `🔔 *SĐT BỊ ẨN!*\nPage: *${page.name}*\nSĐT: \`${detectedPhone}\`\nCmt: "${message}"`, 
                  { parse_mode: 'Markdown' }
                ).catch(() => {});
              }
            });
          }
        }
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
