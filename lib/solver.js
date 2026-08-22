// lib/solver.js — McDonald's DE Survey-Solver (Qualtrics JFE v2)
// Steuert einen Headless-Chromium durch die Umfrage, beantwortet Fragen generisch
// und extrahiert den 50-Cent-Gutschein-Code.
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export const SURVEY_URL =
  process.env.SURVEY_URL ||
  'https://feedback.mcdonalds.com/jfe/form/SV_3fv6PsQJMBgs6ea';

// Antwort-Template für Freitext-Fragen („keine Auskunft", zufällig variiert)
const TEXT_TEMPLATE =
  process.env.TEXT_TEMPLATE ||
  '{Möchte|Ich möchte|Ich will|ich will|will|mag|Mag|Werde|Ich werde|ich werde} {|hierzu|dazu|dadrauf|darauf} {keine|ihnen keine} {Antwort|antwort|Auskunft|auskunft} {geben|abgeben|sagen}{||||||||.|.|.|.|.|.|.|.|..|...}';

function randomize(template) {
  let out = '';
  for (const part of template.split('{')) {
    const pieces = part.split('}');
    out += pieces.shift().split('|').sort(() => Math.random() - 0.5)[0];
    if (pieces.length) out += pieces.join('}');
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

// Soft-Cap: Vercel-Funktion darf max ~60s laufen → Solver bricht früher ab
const SOLVER_TIMEOUT_MS = parseInt(process.env.SOLVER_TIMEOUT_MS || '55000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('SOLVER_TIMEOUT'), { onTimeout })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function solveSurvey(code) {
  const logs = [];
  const log = (s) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
    logs.push(line);
    console.log(line);
  };

  const result = { ok: false, message: '', screenshotPath: null, screenshots: [], code: null, logs };
  let shotCount = 0;

  let executablePath = process.env.CHROMIUM_PATH;
  let args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
  if (!executablePath) {
    executablePath = await chromium.executablePath();
    args = chromium.args;
  }
  // Lokale Tests: DNS-Blockade im Heimnetz umgehen (nur für Entwicklung)
  if (process.env.LOCAL_HOST_MAP) {
    args.push(`--host-resolver-rules=MAP ${process.env.LOCAL_HOST_MAP}`);
  }

  let browser = null;
  const run = async () => {
    log(`Starting headless chromium for code ${code}`);
    browser = await puppeteer.launch({
      executablePath,
      args,
      headless: true,
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    page.setDefaultTimeout(20000);

    const mainText = () => page.evaluate(() => document.body.innerText || '');
    const nextButton = () => page.evaluate(() => {
      const b = document.querySelector('#next-button');
      return b ? { disabled: b.disabled, text: (b.innerText || '').trim() } : null;
    });
    const clickNext = async () => {
      const ok = await page.evaluate(() => {
        const b = document.querySelector('#next-button');
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      });
      return ok;
    };
    const progress = () => page.evaluate(() => {
      const p = document.querySelector('[role="progressbar"]');
      if (p) {
        const v = p.getAttribute('aria-valuenow') || p.textContent || '';
        if (v.trim()) return v.trim().replace('%', '');
      }
      const m = (document.body.innerText || '').match(/(\d{1,3})%\s*(?:Survey Completion|Umfragefortschritt|Completion)/i);
      return m ? m[1] : null;
    });
    const screenshot = async () => {
      const path = `/tmp/mcd-result-${String(shotCount).padStart(2, '0')}.png`;
      shotCount++;
      await page.screenshot({ path, fullPage: false });
      result.screenshots.push(path);
      return path;
    };

    // ---------- 1) Umfrage öffnen ----------
    log('Opening survey');
    await page.goto(SURVEY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#next-button:not([disabled])', { visible: true, timeout: 25000 });
    // reCAPTCHA-JS + Session-Setup Zeit zum Initialisieren geben
    await sleep(3500);

    // ---------- 2) Intro-Seite überspringen (löst reCAPTCHA-Assessment + Session aus) ----------
    log('Skipping intro page');
    const introClicked = await page.evaluate(() => {
      const b = document.querySelector('#next-button');
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!introClicked) {
      await page.waitForSelector('#next-button:not([disabled])', { visible: true, timeout: 10000 });
      await page.evaluate(() => {
        const b = document.querySelector('#next-button');
        if (b && !b.disabled) b.click();
      });
    }

    // ---------- 3) Warten auf Plugin-Iframe (Receipt-Scanner) ----------
    log('Waiting for receipt plugin iframe');
    let pluginFrame = null;
    for (let i = 0; i < 30; i++) {
      pluginFrame = page.frames().find((f) => (f.url() || '').includes('xm-apps-static'));
      if (pluginFrame) break;
      await sleep(1000);
    }
    if (!pluginFrame) {
      const dbg = await page.evaluate(() => ({
        text: document.body.innerText.slice(0, 300),
        iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 90)),
      }));
      throw new Error(`Plugin-Iframe nicht geladen: ${JSON.stringify(dbg)}`);
    }
    log('Receipt plugin iframe loaded');
    await pluginFrame.waitForSelector('input[type="text"]', { timeout: 25000 });

    // ---------- 4) Code in Plugin eingeben ----------
    log('Entering receipt code');
    const codeInput = await pluginFrame.$('input[type="text"]');
    if (!codeInput) throw new Error('Code-Eingabefeld im Plugin nicht gefunden');
    await codeInput.click();
    await codeInput.type(code, { delay: 25 });

    // ---------- 5) Warten bis Survey-Code vom Plugin akzeptiert (Next-Button aktiv) ----------
    log('Waiting for code validation by plugin');
    const accepted = await page.waitForFunction(
      () => {
        const b = document.querySelector('#next-button');
        return b && !b.disabled;
      },
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
    if (!accepted) {
      result.message = 'Der Code wurde vom Plugin nicht akzeptiert (Format?). Beispiele: `0vm2-293m-hov` (12) oder `CF4FK-T7K7F-CC6CH-WRCCD-CC7MP` (25).';
      result.screenshotPath = await screenshot();
      return;
    }

    // ---------- 6) Code serverseitig validieren lassen ----------
    log('Submitting code for server validation');
    await clickNext();
    await sleep(6000);

    // ---------- 7) Fragen beantworten ----------
    let lastSig = '';
    let noProgress = 0;
    for (let i = 0; i < 40; i++) {
      const text = await mainText();

      // Ende / Fehler ohne Fragen?
      const qs = await readQuestions(page);
      const prog = await progress();
      log(`[${prog ?? '?'}] questions=${qs.length} next=${JSON.stringify(await nextButton())}`);

      // Voucher-/Danke-Seite?
      if (/vielen dank|thank you|gutschein|dein code|ihr code|voucher/i.test(text) && qs.length === 0) {
        break;
      }
      // 100 % + keine Fragen: erst Danke-Seite rendern lassen, dann Fehler vs. Erfolg unterscheiden
      if (qs.length === 0 && String(prog ?? '').trim() === '100') {
        await sleep(5000);
        const text2 = await mainText();
        const isErr =
          /nicht entgegennehmen|unable to accept|bereits teilgenommen|already (participated|completed|been used)|5-tage|5 days|ungültig|invalid|nicht gültig/i.test(text2);
        if (isErr) {
          result.message = `Umfrage nicht möglich:\n${cleanupText(text2.slice(0, 500))}`;
          result.screenshotPath = await screenshot();
          return;
        }
        log('Survey completed — thank-you page');
        break; // → Ergebnis-Extraktion
      }
      if (qs.length === 0) {
        // ggf. Zwischenseite ohne Fragen → weiter
        if (await clickNext()) { await sleep(2500); continue; }
        break;
      }

      // Fragen beantworten
      let emailRequired = null;
      for (const q of qs) {
        if (q.hasIframe) continue; // Plugin-Fragen überspringen
        const a = await answerQuestion(page, q, log);
        if (a && a.error === 'EMAIL_REQUIRED') emailRequired = a.label;
      }
      if (emailRequired) {
        result.message = `⛔ Für den Gutschein wird eine **E-Mail-Adresse** verlangt (Frage: „${emailRequired.slice(0, 120)}…"). Bitte VOUCHER_EMAIL als Env-Variable setzen.`;
        result.screenshotPath = await screenshot();
        return;
      }

      // Next klicken; wenn disabled → Zwangsbeantwortung, dann nochmal
      let clicked = await clickNext();
      if (!clicked) {
        await sleep(1200);
        await forceAnswer(page);
        await sleep(800);
        clicked = await clickNext();
      }
      if (!clicked) break;

      // Screenshot von jeder Seite (für den User)
      await screenshot();

      // warten bis sich die Seite ändert (Fragen wechseln oder Ende)
      await sleep(2500);
      const sig = (await mainText()).slice(0, 300) + '|' + (await progress());
      if (sig === lastSig) {
        // keine Änderung → max. 3× wiederholen, dann aufgeben
        noProgress++;
        if (noProgress >= 3) {
          const errText = await page.evaluate(() => {
            const els = [...document.querySelectorAll('.error-message, .Error, [class*="error"], [role="alert"]')]
              .map((e) => e.innerText.trim()).filter(Boolean);
            return els.join(' | ').slice(0, 200);
          }).catch(() => '');
          result.message = `⛔ Stecke auf der Seite fest. Screenshot anbei.${errText ? `\nFehlertext: ${errText}` : ''}\n${cleanupText(sig.split('|')[0].slice(0, 300))}`;
          result.screenshotPath = await screenshot();
          return;
        }
        await sleep(2500);
      } else {
        noProgress = 0;
      }
      lastSig = sig;
      if (i % 5 === 4) log(`Progress check: ${prog}`);
    }

    // ---------- 8) Ergebnis extrahieren ----------
    // Auf gerenderte Danke-Seite warten (bis zu 15s)
    let text = '';
    for (let i = 0; i < 15; i++) {
      text = await mainText();
      if (text.trim().length > 10) break;
      await sleep(1000);
    }
    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);
    const prog = await progress();
    result.screenshotPath = await screenshot();

    const voucherCode = extractVoucherCode(text);
    if (voucherCode) {
      result.ok = true;
      result.code = voucherCode;
      result.message = `**Gutschein-Code:** \`${voucherCode}\``;
      const around = text.split('\n').find(l => l.includes(voucherCode)) || '';
      if (around.trim()) result.message += `\n${around.trim().slice(0, 200)}`;
    } else if (String(prog ?? '').trim() === '100') {
      // Umfrage abgeschlossen, Code wird per E-Mail geliefert
      result.ok = true;
      result.message = `✅ **Umfrage abgeschlossen!**\nDer Gutschein wird per E-Mail an \`${process.env.VOUCHER_EMAIL || 'deine Adresse'}\` geliefert (prüf auch den Spam-Ordner). Screenshot anbei.`;
    } else {
      result.message = `Umfrage beendet (${prog ?? '?'}). Konnte keinen Code extrahieren – Screenshot anbei.\nFinal-URL: ${finalUrl}\nText: ${cleanupText(text.slice(0, 400))}`;
    }
  };

  try {
    await withTimeout(run(), SOLVER_TIMEOUT_MS, () => {
      result.message = 'Zeitüberschreitung (55s-Limit der Serverless-Funktion). Screenshot anbei – evtl. einfach nochmal versuchen.';
    });
  } catch (e) {
    if (e.message !== 'SOLVER_TIMEOUT') {
      log(`Error: ${e.message}`);
      result.message = `Fehler: ${e.message.slice(0, 300)}`;
    }
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    result.logs = logs;
  }
  return result;
}

// ---------- DOM-Lesen ----------
async function readQuestions(page) {
  return page.evaluate(() => {
    const out = [];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sec of document.querySelectorAll('section.question')) {
      if (!visible(sec)) continue;
      const qid = sec.id.replace('question-', '');
      const qTextEl = sec.querySelector('.question-display')
        || sec.querySelector('#question-display-' + qid)
        || sec.querySelector('[class*="question-display"], [class*="QuestionText"], [class*="questionText"], legend, h1, h2');
      const qText = qTextEl ? qTextEl.innerText || '' : '';
      const radios = [...sec.querySelectorAll('input[type="radio"]')]
        .filter(r => visible(r.closest('.selection') || r) || true)
        .map(r => ({ value: r.value, label: ((r.closest('.selection') || {}).innerText || '').trim().slice(0, 120) }));
      const checkboxes = [...sec.querySelectorAll('input[type="checkbox"]')].filter(c => visible(c.closest('.selection') || c) || true);
      const textInputs = [...sec.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input[type="email"]')].filter(i => visible(i));
      // E-Mail-Felder: type=email ODER Platzhalter/Aria/ID mit mail-Hinweis ODER Fragentext erwähnt E-Mail/Adresse
      const emailInputs = [...sec.querySelectorAll('input[type="email"], input[type="text"], input[type="tel"]')].filter(i => visible(i) && /mail|e-mail|email/i.test((i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.id || '')));
      // Robuste E-Mail-Erkennung: Fragentext matcht ODER ein Input ist type=email ODER hat einen "@"-Wert vorbelegt
      const emailLikely = (/mail|e-mail|adresse|address/i.test(qText) && sec.querySelectorAll('input[type="text"], input[type="tel"]').length > 0)
        || sec.querySelector('input[type="email"]')
        || [...sec.querySelectorAll('input[type="text"], input[type="tel"]')].some(i => /@/.test(i.value || ''));
      const textareas = [...sec.querySelectorAll('textarea')].filter(t => visible(t));
      const selects = [...sec.querySelectorAll('select')].filter(s => visible(s));
      const ranges = [...sec.querySelectorAll('input[type="range"]')];
      const hasIframe = !!sec.querySelector('iframe');
      if (radios.length || checkboxes.length || textInputs.length || textareas.length || selects.length || ranges.length || emailInputs.length || emailLikely) {
        out.push({ qid, radios, checkboxes: checkboxes.length, emailInputs: Math.max(emailInputs.length, emailLikely ? textInputs.length : 0), textInputs: textInputs.length, textareas: textareas.length, selects: selects.length, ranges: ranges.length, hasIframe });
      }
    }
    return out;
  });
}

// ---------- Beantworten ----------
function pickRadio(radios) {
  const hasJa = radios.some(r => /ja|yes/i.test(r.label));
  const hasNein = radios.some(r => /nein|no/i.test(r.label));
  if (hasJa && hasNein) {
    return radios.find(r => /ja|yes/i.test(r.label)) || radios[0];
  }
  const nums = radios.map(r => parseFloat(r.value)).filter(n => Number.isFinite(n));
  if (nums.length) {
    const max = Math.max(...nums);
    // positiv, aber nicht verdächtig perfekt: 4/5 bzw. 8/10
    let target = max > 6 ? 8 : 4;
    if (target > max) target = max;
    const byVal = radios.find(r => parseFloat(r.value) === target);
    if (byVal) return byVal;
    // Sortierung: möglichst nah an target
    return [...radios].sort((a, b) => Math.abs(parseFloat(a.value) - target) - Math.abs(parseFloat(b.value) - target))[0];
  }
  // sonst zufällig, aber "keine Angabe"-Optionen vermeiden
  const filtered = radios.filter(r => !/keine angabe|keine antwort|weiß nicht|nichts davon/i.test(r.label));
  return (filtered.length ? filtered : radios).sort(() => Math.random() - 0.5)[0];
}

async function answerQuestion(page, q, log) {
  const questionLabel = await page.evaluate((qid) => {
    const el = document.querySelector('#question-display-' + qid);
    return el ? el.innerText.trim().slice(0, 300) : qid;
  }, q.qid);

  // E-Mail-Feld (Gutschein-Zustellung) — zuerst behandeln
  if (q.emailInputs) {
    const email = process.env.VOUCHER_EMAIL;
    if (!email) {
      log(`EMAIL REQUIRED bei '${questionLabel}' — VOUCHER_EMAIL env fehlt`);
      return { error: 'EMAIL_REQUIRED', label: questionLabel };
    }
    await page.evaluate((qid, mail) => {
      // Fokus setzen, damit type() im richtigen Feld landet
      const sec = document.getElementById('question-' + qid);
      const el = sec.querySelector('input[type="email"], input[type="text"], input[type="tel"]');
      if (el) {
        el.focus();
        // Vorbelegten Wert (z.B. Platzhalter redacted@mcdonalds.com) sicher loeschen
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, q.qid, email);
    const mailInput = await page.$(`#question-${q.qid} input[type="email"], #question-${q.qid} input[type="text"], #question-${q.qid} input[type="tel"]`);
    if (mailInput) {
      // Doppelte Absicherung: 1) React-kompatibler Setter + Events, 2) echte Tastendrücke
      await page.evaluate((qid, mail) => {
        const sec = document.getElementById('question-' + qid);
        const el = sec.querySelector('input[type="email"], input[type="text"], input[type="tel"]');
        if (el) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, mail);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, q.qid, email);
      // KEIN click(3x) + type() mehr — der Setter oben setzt den Wert einmal;
      // type() haengt die Adresse sonst doppelt an (Cursor steht am Ende)!
      // Screenshot NACH der E-Mail-Eingabe (Verifikation der Adresse im Feld)
      const shotPath = `/tmp/mcd-email-${Date.now()}.png`;
      try { await page.screenshot({ path: shotPath }); log(`Email-Screenshot: ${shotPath}`); } catch { /* ignore */ }
      // WARTEN bis der User bestätigt (Datei /tmp/mcd-email-go) — max 300s
      const fs = await import('fs');
      const deadline = Date.now() + 300000;
      fs.rmSync('/tmp/mcd-email-go', { force: true });
      while (!fs.existsSync('/tmp/mcd-email-go') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
      }
      log(fs.existsSync('/tmp/mcd-email-go')
        ? 'Bestätigung erhalten — sende ab'
        : 'Timeout 300s — sende trotzdem ab (E-Mail ist korrekt)');
      fs.rmSync('/tmp/mcd-email-go', { force: true });
    }
    log(`Answering '${questionLabel}' with email (${email.slice(0, 20)}…)`);
    return;
  }

  // Radios (inkl. Matrix/NPS)
  if (q.radios.length) {
    const picked = pickRadio(q.radios);
    const done = await page.evaluate((qid, value) => {
      const sec = document.getElementById('question-' + qid);
      const radios = [...sec.querySelectorAll('input[type="radio"]')];
      const target = radios.find(r => r.value === value);
      if (!target) return false;
      target.click();
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, q.qid, picked.value);
    log(`Answering '${questionLabel}' with ${picked.label ? `'${picked.label.slice(0, 50)}'` : `value ${picked.value}`} (radio)`);
    if (!done) log(`  ! radio click failed for ${q.qid}`);
    return;
  }
  // Checkboxen
  if (q.checkboxes) {
    await page.evaluate((qid) => {
      const sec = document.getElementById('question-' + qid);
      const boxes = [...sec.querySelectorAll('input[type="checkbox"]')];
      // Zustimmungs-Checkboxen zuerst (Datenschutz etc.)
      const labels = boxes.map(b => ((b.closest('.selection') || {}).innerText || '').toLowerCase());
      let pick = boxes.find((_, i) => /stimme|zustimmen|akzeptier|einverstanden|ich stimme/i.test(labels[i]));
      if (!pick) pick = boxes[0];
      pick.click();
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    }, q.qid);
    log(`Answering '${questionLabel}' with checkbox`);
    return;
  }
  // Textfelder
  if (q.textInputs || q.textareas) {
    const text = randomize(TEXT_TEMPLATE);
    await page.evaluate((qid, t) => {
      const sec = document.getElementById('question-' + qid);
      for (const el of sec.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input[type="email"], textarea')) {
        const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
        setter.call(el, t);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, q.qid, text);
    log(`Answering '${questionLabel}' with text (randomized)`);
    return;
  }
  // Dropdowns
  if (q.selects) {
    await page.evaluate((qid) => {
      const sec = document.getElementById('question-' + qid);
      for (const sel of sec.querySelectorAll('select')) {
        const opts = [...sel.options].filter(o => o.value && o.text && !/bitte wählen|auswählen/i.test(o.text));
        if (opts.length) {
          const pick = opts.sort(() => Math.random() - 0.5)[0];
          sel.value = pick.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, q.qid);
    log(`Answering '${questionLabel}' with select option`);
    return;
  }
  // Slider
  if (q.ranges) {
    await page.evaluate((qid) => {
      const sec = document.getElementById('question-' + qid);
      for (const r of sec.querySelectorAll('input[type="range"]')) {
        r.value = String(Math.min(parseInt(r.max, 10) || 10, 8));
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, q.qid);
    log(`Answering '${questionLabel}' with slider`);
  }
}

// Zwangsbeantwortung für Pflichtfragen, die übersehen wurden
async function forceAnswer(page) {
  await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sec of document.querySelectorAll('section.question')) {
      if (!visible(sec)) continue;
      const radios = [...sec.querySelectorAll('input[type="radio"]')].filter(r => visible(r));
      if (radios.length && !radios.some(r => r.checked)) {
        const pick = radios[Math.floor(Math.random() * radios.length)];
        pick.click();
        pick.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}

// ---------- Code-Extraktion ----------
function extractVoucherCode(text) {
  const candidates = [];
  // mehrteilige alphanumerische Codes (z.B. F4KJ-9X2M-Q7PL oder 5x5)
  candidates.push(...(text.match(/\b[A-Z0-9]{4,5}(?:-[A-Z0-9]{4,5}){2,4}\b/g) || []));
  // numerische Codes (z.B. 337109219)
  candidates.push(...(text.match(/\b\d{6,12}\b/g) || []));
  return candidates[0] || null;
}

function cleanupText(t) {
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, 600);
}
