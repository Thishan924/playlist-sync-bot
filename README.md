# Playlist sync control bot

Telegram bot (Cloudflare Workers) to control the three playlist sync bots —
Cool phonks, Trending Phonk/funk songs, and the Spotify-scour bot.

**v0.3.0 — base + polling + Vercel.** Same commands as v0.1.0, plus a Node.js
long-polling entry point (`src/polling.js`) for hosts that run Node
instead of Workers, plus a Vercel serverless webhook entry
(`api/webhook.js`). The extra `/ping` features (last-run status/duration,
dispatch timing, YouTube/Spotify reachability) still come after the base
is live and tested.

## Commands

- `/start` / `/help` — commands list + persistent reply keyboard
  (Sync / Status / Ping / Help)
- `/sync` — pick a sync bot (buttons), then Dry run / Real run.
  Real run asks to confirm first. The bot remembers the last picked bot
  in KV, so the next `/sync` goes straight to it; tap "Change bot" to
  pick another one.
- `/status` — last GitHub Actions run of the picked bot
- `/ping` — basic reachability check from the Worker
  (GitHub API + Telegram, ms + HTTP status)
- No `/list` — on purpose, there are too many songs to list.

## Sync bots

| Bot | Repo | Workflow |
| --- | --- | --- |
| Cool phonks | `thishan2012/Spotify-yt-playlist-sync-testing` | `sync.yml` |
| Trending Phonk/funk songs | `thishan2012/-zq9-void-200` | `sync.yml` |
| Spotify-scour bot | not set yet | not set yet |

The scour bot is listed but cannot be dispatched until its repo +
workflow file are known — that blocks only bot #3, not the base.

`/sync` only triggers the GitHub Actions workflow via `workflow_dispatch`
(`dry_run: true/false`, `reset_db: none`). It never syncs directly.

## Setup

### Option A — Cloudflare Workers (webhook)

```bash
npm test
wrangler kv namespace create BOT_KV   # then add its id to wrangler.toml
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GITHUB_PAT
wrangler deploy
```

Then set the Telegram webhook to the Worker URL. Secrets are never in
code — `TELEGRAM_BOT_TOKEN` comes from @BotFather (a new bot, not the
NextDNS bot's token), `GITHUB_PAT` is a PAT with Actions read + write on
the thishan2012 sync repos.

### Option B — long-polling host, e.g. HidenCloud free tier (Node.js)

No Cloudflare account needed. The bot polls Telegram instead of
receiving a webhook, and remembers the last picked bot in a JSON file
(`data/state.json`) instead of KV.

1. Create a free server, Node.js egg. Upload this repo as one zip and
   extract it (no one-by-one upload; no git needed).
2. In the panel set the environment variables (never in code/chat):
   `TELEGRAM_BOT_TOKEN` (new bot from @BotFather),
   `GITHUB_PAT` (PAT scoped to the playlist repos, Actions: write).
   Optional: `STATE_FILE` for a different state-file path.
3. Start command: `node src/polling.js` (or `npm start`).
4. Update: upload a new zip, extract over the old files, restart the
   server. The server, env vars and state file stay — no need to delete
   and recreate anything. Free servers need a weekly renewal in the
   panel — renew on time or the server suspends.

### Option C — Vercel (serverless webhook)

Same bot, no long-lived process: Telegram calls
`https://<project>.vercel.app/api/webhook` and the function routes the
update through the same shared handler as Workers and polling.

1. Import the repo in the Vercel dashboard (or `vercel link` + `vercel`).
   No `vercel.json` is needed; `api/webhook.js` is picked up as a
   serverless function automatically.
2. In the dashboard set the environment variables (never in code/chat):
   `TELEGRAM_BOT_TOKEN` (new bot from @BotFather),
   `GITHUB_PAT` (PAT scoped to the playlist repos, Actions: write).
   Optional: `TELEGRAM_WEBHOOK_SECRET`;
   optional `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
   (Upstash Redis, free tier) to remember the last picked bot across
   cold starts. Without Upstash there is no persistence: the bot just
   asks which bot every time — correct, just less convenient. A warm
   container remembers the pick in memory until it is recycled.
3. Set the Telegram webhook to `https://<project>.vercel.app/api/webhook`
   (with the secret token if you set one).

Limits to know: Vercel Hobby kills functions at 10 s, so the bot caps
its GitHub fetch timeouts at 8 s (`FETCH_TIMEOUT_MS`) — a slow GitHub
call returns a clean error reply instead of a hard kill. `/ping` is
basic only and makes two quick checks; in practice both answer in well
under a second. The reply to Telegram is always HTTP 200, so Telegram
never retries an update.

Allowed chat ID `7933991754` is hardcoded in `src/index.js`, same as the
NextDNS bot.
