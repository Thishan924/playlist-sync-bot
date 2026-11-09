# Playlist sync control bot

Telegram bot (Cloudflare Workers) to control the three playlist sync bots —
Cool phonks, Trending Phonk/funk songs, and the Spotify-scour bot.

**v0.1.0 — base only.** Basic features first; the extra `/ping` features
(last-run status/duration, dispatch timing, YouTube/Spotify reachability)
come after the base is live and tested.

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

Allowed chat ID `7933991754` is hardcoded in `src/index.js`, same as the
NextDNS bot.
