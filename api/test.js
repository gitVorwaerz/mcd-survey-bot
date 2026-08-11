// api/test.js — Verifikation: Kann die Vercel-Funktion Chromium starten? (wird nach Test entfernt)
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export default async function handler(req, res) {
  const t0 = Date.now();
  let browser = null;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      executablePath,
      args: chromium.args,
      headless: true,
      defaultViewport: { width: 800, height: 600 },
    });
    const page = await browser.newPage();
    await page.goto('data:text/html,<h1>chromium-ok</h1>');
    const title = await page.title();
    await browser.close();
    browser = null;
    res.status(200).json({ ok: true, chromium: executablePath, title, ms: Date.now() - t0 });
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    res.status(500).json({ ok: false, error: e.message.slice(0, 500), ms: Date.now() - t0 });
  }
}
