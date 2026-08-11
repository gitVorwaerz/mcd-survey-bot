// lib/telegram.js — schlanker Telegram-Bot-API-Client
import fs from 'node:fs';

const API = 'https://api.telegram.org/bot';

export function getToken() {
  const t = process.env.TELEGRAM_TOKEN;
  if (!t) throw new Error('TELEGRAM_TOKEN env fehlt');
  return t;
}

export async function tg(method, payload = {}, token = getToken()) {
  const isForm = typeof FormData !== 'undefined' && payload instanceof FormData;
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: isForm ? {} : { 'Content-Type': 'application/json' },
    body: isForm ? payload : JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

export function isAllowedUser(chatId) {
  const allowed = process.env.ALLOWED_USER_IDS || '*';
  if (allowed === '*') return true;
  return allowed
    .split(',')
    .map((s) => s.trim())
    .includes(String(chatId));
}

// 12-stellig: xxxx-xxxx-xxxx  |  25-stellig: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
export const CODE_RE =
  /^([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5})$/i;

export function sendMessage(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, ...extra });
}

export function sendChatAction(chatId, action = 'typing') {
  return tg('sendChatAction', { chat_id: chatId, action }).catch(() => {});
}

export function sendPhoto(chatId, path, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([fs.readFileSync(path)]), 'result.png');
  form.append('parse_mode', 'Markdown');
  if (caption) form.append('caption', caption);
  return tg('sendPhoto', form);
}

export async function setWebhook(url, token = getToken()) {
  const res = await fetch(`${API}${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message'] }),
  });
  return res.json();
}
