// api/webhook.js — Telegram-Webhook: Bon-Code entgegennehmen, Umfrage lösen, Ergebnis senden
import { solveSurvey } from '../lib/solver.js';
import {
  isAllowedUser,
  CODE_RE,
  sendMessage,
  sendChatAction,
  sendPhoto,
  getToken,
} from '../lib/telegram.js';

// In-Memory-Dedupe gegen Telegram-Retries (geht bei Cold Start verloren,
// Codes sind ohnehin Einmal-Codes → Doppelversuch scheitert sauber)
const seenUpdates = new Set();
const MAX_SEEN = 500;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, name: 'mcd-survey-bot', hint: 'POST Telegram-Updates hierher' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let update;
  // Vercel liefert req.body bei application/json bereits als Objekt
  if (typeof req.body === 'string') {
    try {
      update = JSON.parse(req.body || '{}');
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }
  } else {
    update = req.body || {};
  }

  // Health-/Webhook-Bestätigung von Telegram
  if (update.message?.chat?.type && update.message.chat.type !== 'private') {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  const updateId = update.update_id;

  if (!chatId || text === undefined) {
    res.status(200).json({ ok: true });
    return;
  }

  // Dedupe
  if (updateId !== undefined) {
    if (seenUpdates.has(updateId)) {
      res.status(200).json({ ok: true, deduped: true });
      return;
    }
    seenUpdates.add(updateId);
    if (seenUpdates.size > MAX_SEEN) {
      const first = seenUpdates.values().next().value;
      seenUpdates.delete(first);
    }
  }

  try {
    getToken(); // früh validieren
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
    return;
  }

  // Antworten passieren über die Bot-API, dann 200 zurück (Telegram-Retry vermeiden)
  res.status(200).json({ ok: true });

  try {
    if (!isAllowedUser(chatId)) {
      await sendMessage(chatId, '⛔ Du bist nicht berechtigt, diesen Bot zu nutzen.');
      return;
    }

    if (text === '/start') {
      await sendMessage(
        chatId,
        '🍟 **McDonald\'s Survey-Bot**\n\nSchick mir den Umfrage-Code von deiner Quittung (12-stellig wie `0vm2-293m-hov` oder 25-stellig) und ich fülle die Umfrage für dich aus.\n\nDeine Chat-ID: `' + chatId + '`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const code = text.replace(/[^a-z0-9-]/gi, '');
    if (!CODE_RE.test(code)) {
      await sendMessage(
        chatId,
        'Das sieht nicht nach einem gültigen Code aus. Beispiele:\n`0vm2-293m-hov` (12-stellig)\n`CF4FK-T7K7F-CC6CH-WRCCD-CC7MP` (25-stellig)',
        { parse_mode: 'Markdown', reply_to_message_id: update.message.message_id }
      );
      return;
    }

    await sendMessage(
      chatId,
      `⏳ Lösse Umfrage für Code \`${code}\` … das dauert ~30–60 Sekunden.`,
      { parse_mode: 'Markdown', reply_to_message_id: update.message.message_id }
    );
    const typing = setInterval(() => sendChatAction(chatId), 4000);
    try {
      const result = await solveSurvey(code);
      clearInterval(typing);
      await sendChatAction(chatId, 'cancel').catch(() => {});

      if (result.screenshotPath) {
        await sendPhoto(chatId, result.screenshotPath, result.message).catch(async () => {
          await sendMessage(chatId, result.message, { parse_mode: 'Markdown' });
        });
      } else {
        await sendMessage(chatId, result.message, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      clearInterval(typing);
      await sendMessage(chatId, `❌ Interner Fehler: ${e.message.slice(0, 300)}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (e) {
    console.error('webhook error', e);
  }
}
