# 🍟 McDonald's Survey-Bot (Vercel-Port)

Port des [Ruby-Bots von sapphyrus](https://github.com/sapphyrus/mcd-survey-bot) für **Vercel**.
Der alte Bot lief auf Ruby + PhantomJS gegen das inzwischen abgeschaltete Questback-System
(`fast-insight.com`). McDonald's Deutschland nutzt heute **Qualtrics**
(`feedback.mcdonalds.com`, inkl. Invisible-reCAPTCHA und „Receipt Scanner"-Plugin) — genau
dieser Flow wird hier automatisiert.

**Bon-Code rein → 50-Cent-Gutschein-Code raus.** 🧾🡢🥤

## Wie es funktioniert

Telegram-Bot (Webhook statt Long-Polling) → Headless-Chromium (`@sparticuz/chromium`, läuft
in der Vercel-Serverless-Funktion) füllt die Umfrage aus:

1. Umfrage öffnen, Intro-Seite überspringen (reCAPTCHA-Assessment läuft unsichtbar durch)
2. Code in das „Receipt Scanner"-Plugin-Iframe eingeben (`xxxx-xxxx-xxxx` oder 25-stellig)
3. Code serverseitig validieren lassen
4. Alle Fragen generisch beantworten (Bewertungen positiv, „keine Auskunft"-Freitext, Zustimmung)
5. Gutschein-Code extrahieren + Screenshot per Telegram zurückschicken

## Setup

### 1. Bot erstellen
Bei [@BotFather](https://t.me/BotFather) einen Bot erstellen → Token merken.

### 2. Deploy auf Vercel
Repo auf GitHub, Projekt in Vercel importieren, dann Env-Variablen setzen:

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | Bot-Token von BotFather |
| `ALLOWED_USER_IDS` | – | Komma-getrennte Telegram-Chat-IDs, `*` = alle (Default) |

### 3. Webhook registrieren
```
curl "https://DEINE-APP.vercel.app/api/setup?url=https://DEINE-APP.vercel.app/api/webhook"
```

### 4. Nutzung
Dem Bot den Code von der Quittung schicken (12-stellig `0vm2-293m-hov` oder 25-stellig).
Der Bot antwortet nach ~30–60 s mit Gutschein-Code + Screenshot.

## Limits & Hinweise

- **Vercel-Hobby-Limit: 60 s Funktionslaufzeit.** Der Solver bricht nach 55 s selbst ab.
  Bei Zeitüberschreitung einfach erneut schicken (Codes sind Einmal-Codes → kein Doppel-Gutschein).
- Codes sind **7 Tage** nach Transaktion gültig, max. 2 Gutscheine / 30 Tage (McDonald's-Regeln).
- Der Bot antwortet auf ungültige/abgelaufene Codes mit der Original-Fehlermeldung.
- Invisible-reCAPTCHA „detect" besteht in sauberem Headless-Chromium — kann theoretisch
  mal anschlagen; dann meldet der Bot das.

## Lokale Entwicklung

```bash
npm install
# Playwright-Chromium als Engine + DNS-Override (nur nötig, wenn dein Netz wie das
# Heimnetz hier die xm-apps-static.com-Domain blockt):
CHROMIUM_PATH=~/.cache/ms-playwright/chromium_headless_shell-1208/chrome-linux/headless_shell \
LOCAL_HOST_MAP="www.xm-apps-static.com 23.62.15.16" \
node test/local-solver.js 0vm2-293m-hov
```

Ohne `CHROMIUM_PATH` nutzt der Solver automatisch `@sparticuz/chromium` (wie auf Vercel).

## API

- `POST /api/webhook` — Telegram-Webhook (Update-Handling + Solver)
- `GET  /api/setup?url=…` — `setWebhook` aufrufen
- `GET  /api/webhook` — Health-Check
