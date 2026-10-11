# Jom Luah — Teman Hati (Render webhook)

This version uses Telegram webhook directly on Render so it reacts to new messages promptly. It does not use Google Apps Script polling.

## Required Render environment variables

- `TELEGRAM_BOT_TOKEN`: token from BotFather
- `GEMINI_API_KEY`: Gemini API key
- `GEMINI_MODEL`: optional; defaults to `gemini-3.1-flash-lite`
- `PUBLIC_URL`: exact Render service URL, e.g. `https://your-service.onrender.com` (no trailing slash)
- `WEBHOOK_SECRET`: random string containing only letters, numbers, `_` or `-`
- `SETUP_SECRET`: another random secret used once to register webhook

Keep tokens and keys in Render Environment, never in source code or a public repository.

## Render settings

- Service type: Web Service
- Build command: `npm install`
- Start command: `npm start`

After the service deploys, open this URL once in a browser, replacing the values:

`https://YOUR-SERVICE.onrender.com/setup-webhook?key=YOUR_SETUP_SECRET&drop_pending=true`

A JSON response with `"ok": true` confirms registration. The `drop_pending=true` part deliberately discards old queued Telegram updates so they do not trigger a flood of late replies. After successful setup, do not keep revisiting this URL.

Then disable/delete old Apps Script time triggers used for Telegram polling. The Render webhook will now receive Telegram messages.

## Notes

- Gemini is called only when a new private text message arrives (ordinary text messages are answered even if the user did not type `/mula`).
- `/start` and `/mula` show a welcome message; `/bantuan` shows help; `/tamat` clears the current in-memory chat history.
- Session history is stored only in service memory and is lost on service restart/redeploy. This is a prototype, not a production-ready system for sensitive counselling data.
- Render free services may sleep after 15 minutes idle and can take about a minute to wake. An always-on plan is needed for more consistent latency.
