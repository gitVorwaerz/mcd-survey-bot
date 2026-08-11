// api/setup.js — Webhook registrieren: GET /api/setup?url=https://<deine-domain>/api/webhook
import { setWebhook, getToken } from '../lib/telegram.js';

export default async function handler(req, res) {
  const url = req.query.url;
  if (!url) {
    res.status(400).json({
      error: 'url fehlt',
      usage: 'GET /api/setup?url=https://deine-app.vercel.app/api/webhook',
    });
    return;
  }
  try {
    const result = await setWebhook(url);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
