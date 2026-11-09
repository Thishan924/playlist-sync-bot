// Playlist sync control bot — Telegram webhook on Cloudflare Workers.
// v0.1.0 BASE: basic features only, before the extra /ping features.
//   - /start / /help, /sync, /status, /ping (basic)
//   - No /list on purpose: too many songs.
//   - KV (BOT_KV) remembers the last picked sync bot per chat, like the
//     NextDNS bot remembers the last picked profile. No KV binding ->
//     everything falls back to asking with buttons, exactly like before.
//   - /sync only triggers the GitHub Actions workflow (workflow_dispatch);
//     it never syncs directly. Dry run previews, real run asks to confirm.
//   - Later features, NOT in this base: /ping with last-run status /
//     duration, dispatch response time, YouTube / Spotify reachability.
//     Those go in after the base is live and tested.
// v0.2.0 adds src/polling.js: the same bot as a Node.js long-polling
// process (for hosts like HidenCloud that run Node, not Workers). The
// shared update handler below (handleUpdate) is used by both entries,
// so the commands behave the same on either host.
// v0.3.0 adds api/webhook.js: the same bot as a Vercel serverless function
// (webhook, no polling). Storage is now a small shim: Workers KV when
// present, Upstash Redis REST when its env vars are set, in-memory
// otherwise (no persistence — the bot just asks every time). Fetch
// timeouts are capped by env.FETCH_TIMEOUT_MS (Vercel sets 8000, inside
// the Hobby 10 s limit). Workers and polling behaviour are unchanged.
// Secrets come only from Worker env (wrangler secret put):
//   TELEGRAM_BOT_TOKEN
//   GITHUB_PAT — GitHub PAT for workflow_dispatch + reading private-repo
//     runs (the GitHub App cannot reach the thishan2012 repos). Added
//     separately by the user in the dashboard, never in code/chat.
// Optional: TELEGRAM_WEBHOOK_SECRET
// Allowed chat ID is hardcoded in code (user's choice, not a Secret):
//   7933991754 — same chat as the NextDNS bot.

export const VERSION = "0.3.0";
const ALLOWED_CHAT_ID = "7933991754";

// Sync bots. Cool phonks + Trending are wired (both sync.yml, both take
// a `dry_run` boolean input on workflow_dispatch — verified for Trending
// in thishan2012/-zq9-void-200/.github/workflows/sync.yml; Cool phonks
// uses the same file name, same input is assumed and a dispatch error
// is reported back instead of guessed at).
// Spotify-scour bot: repo + workflow file are NOT known yet, so it is
// listed but cannot be dispatched until the user gives them. It blocks
// only bot #3, not the base.
const SYNC_BOTS = [
  {
    id: "cool",
    name: "Cool phonks",
    repo: "thishan2012/Spotify-yt-playlist-sync-testing",
    workflow: "sync.yml",
    ref: "main",
  },
  {
    id: "trending",
    name: "Trending Phonk/funk songs",
    repo: "thishan2012/-zq9-void-200",
    workflow: "sync.yml",
    ref: "main",
  },
  {
    id: "scour",
    name: "Spotify-scour bot",
    repo: null,
    workflow: null,
    ref: "main",
  },
];

const HELP_TEXT = [
  `Playlist sync control bot — commands:`,
  ``,
  `/start — welcome + this list`,
  `/help — this list`,
  `/sync — pick a sync bot, then Dry run / Real run (real asks to confirm)`,
  `/status — last run of the picked sync bot (Added / Skipped / Failed is on the run page)`,
  `/ping — basic reachability check (GitHub API + Telegram, from the Worker)`,
  ``,
  `Sync bots:`,
  `- Cool phonks`,
  `- Trending Phonk/funk songs`,
  `- Spotify-scour bot (repo / workflow not set yet — pick it and the bot will say so)`,
  ``,
  `The bot remembers your last picked bot, so the next /sync goes straight`,
  `to it — send /sync and tap "Change bot" to pick another one.`,
  ``,
  `No /list command on purpose: there are too many songs to list.`,
  ``,
  `Buttons at the bottom of the chat (Sync / Status / Ping / Help) do the`,
  `same — tap one instead of typing.`,
].join("\n");

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "🔄 Sync" }, { text: "📊 Status" }],
    [{ text: "🏓 Ping" }, { text: "❓ Help" }],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
};

const KEYBOARD_COMMANDS = {
  "🔄 Sync": "/sync",
  "📊 Status": "/status",
  "🏓 Ping": "/ping",
  "❓ Help": "/help",
};

function findBot(botId) {
  return SYNC_BOTS.find((b) => b.id === botId) || null;
}

function findBotByArg(arg) {
  if (!arg) return null;
  const a = arg.toLowerCase();
  return (
    SYNC_BOTS.find((b) => b.id === a) ||
    SYNC_BOTS.find((b) => b.name.toLowerCase().includes(a)) ||
    null
  );
}

function botLines() {
  return SYNC_BOTS.map((b) =>
    b.repo ? `- ${b.name} (${b.repo})` : `- ${b.name} (not set up yet)`,
  ).join("\n");
}

// --- Remembered bot (storage) ---------------------------------------------
// Key: `last-sync-bot:<chatId>` -> JSON { id }. Storage is best-effort only:
// a missing backend, a failed read, or a failed write must never break
// a command — callers fall back to buttons.
//
// Backends, in order:
//   1. env.BOT_KV — Cloudflare KV (Workers) or the file KV (polling entry).
//      Same get/put shape, so both keep working unchanged.
//   2. Upstash Redis REST — when UPSTASH_REDIS_REST_URL +
//      UPSTASH_REDIS_REST_TOKEN are set (Vercel). Optional; no Upstash
//      account is needed to run the bot.
//   3. In-memory Map — no persistence. A fresh process has nothing
//      remembered, so the bot just asks which bot every time. Correct,
//      just less convenient.
// The in-memory store is created fresh per call on purpose: the Workers
// contract is "no KV binding -> always ask", and a process-wide Map would
// silently change that for the Workers and test paths. (The Vercel entry
// passes its own module-level memory store as BOT_KV instead, so warm
// containers there do remember the pick.)

function lastBotKey(chatId) {
  return `last-sync-bot:${chatId}`;
}

export function createMemoryStore() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v);
    },
  };
}

// Upstash Redis REST API: GET /get/<key> -> {"result": <string|null>},
// GET /set/<key>/<value> -> {"result": "OK"}. Both need
// `Authorization: Bearer <token>`. Values here are tiny JSON strings, so
// URL-encoding them is fine. Any failure means "nothing remembered".
function createUpstashStore(env) {
  const base = String(env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  async function call(path) {
    const res = await httpFetch(env, `${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs(env, 5000)),
    });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    return res.json();
  }
  return {
    get: async (key) => {
      try {
        const data = await call(`/get/${encodeURIComponent(key)}`);
        return data && typeof data.result === "string" ? data.result : null;
      } catch {
        return null;
      }
    },
    put: async (key, value) => {
      try {
        await call(`/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
      } catch (e) {
        console.log("[upstash] put failed:", e.message);
      }
    },
  };
}

function getStore(env) {
  if (
    env.BOT_KV &&
    typeof env.BOT_KV.get === "function" &&
    typeof env.BOT_KV.put === "function"
  ) {
    return env.BOT_KV;
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return createUpstashStore(env);
  }
  return createMemoryStore();
}

async function loadLastBot(env, chatId) {
  try {
    const raw = await getStore(env).get(lastBotKey(chatId));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.id !== "string") return null;
    return findBot(saved.id);
  } catch {
    return null;
  }
}

async function saveLastBot(env, chatId, bot) {
  try {
    if (!bot || !bot.id) return;
    await getStore(env).put(lastBotKey(chatId), JSON.stringify({ id: bot.id }));
  } catch (e) {
    console.log("[kv] save failed:", e.message);
  }
}

// Fetch timeouts: env.FETCH_TIMEOUT_MS caps them. Vercel Hobby kills the
// function at 10 s, so the Vercel entry sets 8000 — a slow GitHub call then
// returns a clean error reply instead of a hard kill. Workers keeps the
// defaults below.
function timeoutMs(env, def) {
  const v = Number(env && env.FETCH_TIMEOUT_MS);
  if (Number.isFinite(v) && v > 0) return Math.min(v, def);
  return def;
}

// Exported for tests: the dispatch timeout in effect for this env.
export function dispatchTimeoutMs(env) {
  return timeoutMs(env, 15000);
}

// Fetch indirection: env.FETCH overrides the global fetch when set.
// The Workers entry never sets it; the polling entry (and tests) pass
// their own fetch, so no Telegram/GitHub call escapes the stub.
function httpFetch(env, url, opts) {
  const f = (env && env.FETCH) || fetch;
  return f(url, opts);
}

// --- Telegram ------------------------------------------------------------

async function sendTelegram(env, chatId, text, replyMarkup) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log("[telegram: no token] to", chatId, ":", text);
    return false;
  }
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await httpFetch(
    env,
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) console.log("[telegram] send failed:", res.status, await res.text());
  return res.ok;
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !callbackQueryId) return false;
  try {
    const res = await httpFetch(
      env,
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || "" }),
      },
    );
    return res.ok;
  } catch (e) {
    console.log("[telegram] answerCallbackQuery failed:", e.message);
    return false;
  }
}

function reply(text, replyMarkup) {
  return replyMarkup ? { text, replyMarkup } : { text };
}

// --- Keyboards -----------------------------------------------------------

function botPickKeyboard(prefix) {
  return {
    inline_keyboard: SYNC_BOTS.map((b) => [
      { text: b.repo ? b.name : `${b.name} — not set up`, callback_data: `${prefix}:${b.id}` },
    ]),
  };
}

function syncChoiceKeyboard(bot) {
  return {
    inline_keyboard: [
      [
        { text: "👀 Dry run", callback_data: `sync:dry:${bot.id}` },
        { text: "▶️ Real run", callback_data: `sync:real:${bot.id}` },
      ],
      [{ text: "🔀 Change bot", callback_data: "change" }],
    ],
  };
}

function confirmRealKeyboard(bot) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Yes, run it for real", callback_data: `confirm:real:${bot.id}` },
        { text: "❌ Cancel", callback_data: `pick:${bot.id}` },
      ],
    ],
  };
}

// --- GitHub --------------------------------------------------------------
// User-Agent header is required: GitHub answers 403 without one, and
// Workers' fetch sends none by default (learned on the NextDNS bot).

function githubHeaders(env) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "playlist-sync-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_PAT) headers.Authorization = `Bearer ${env.GITHUB_PAT}`;
  return headers;
}

async function dispatchSync(env, bot, dryRun) {
  if (!bot.repo || !bot.workflow) {
    return {
      ok: false,
      detail:
        `${bot.name} is not set up yet — its repo / workflow file is not known. ` +
        `Give the repo + workflow file and it can be wired in.`,
    };
  }
  if (!env.GITHUB_PAT) {
    return {
      ok: false,
      detail:
        "Not configured yet — GITHUB_PAT is missing as a Worker secret, " +
        "so the bot cannot dispatch the workflow.",
    };
  }
  const url =
    `https://api.github.com/repos/${bot.repo}/actions/workflows/` +
    `${encodeURIComponent(bot.workflow)}/dispatches`;
  try {
    const res = await httpFetch(env, url, {
      method: "POST",
      headers: { ...githubHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({
        ref: bot.ref || "main",
        inputs: { dry_run: dryRun ? "true" : "false", reset_db: "none" },
      }),
      signal: AbortSignal.timeout(dispatchTimeoutMs(env)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `GitHub API ${res.status} — ${body.slice(0, 200)}` };
    }
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: e.message || "fetch failed" };
  }
}

async function lastRun(env, bot) {
  if (!bot.repo || !bot.workflow) {
    return `${bot.name} is not set up yet — its repo / workflow file is not known.`;
  }
  const url =
    `https://api.github.com/repos/${bot.repo}/actions/workflows/` +
    `${encodeURIComponent(bot.workflow)}/runs?per_page=1`;
  try {
    const res = await httpFetch(env, url, {
      headers: githubHeaders(env),
      signal: AbortSignal.timeout(timeoutMs(env, 10000)),
    });
    if (!res.ok) {
      if (res.status === 404) {
        return (
          `Status: could not read ${bot.name} (${bot.repo}) — GitHub returned 404. ` +
          `For a private repo this usually means GITHUB_PAT is missing or ` +
          `cannot see that repo.`
        );
      }
      return `Status: GitHub API ${res.status} for ${bot.name}.`;
    }
    const data = await res.json();
    const run = (data.workflow_runs || [])[0];
    if (!run) return `Status: ${bot.name} — no runs yet.`;
    const lines = [
      `Status — ${bot.name} (${bot.repo}):`,
      `- Run: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}`,
      `- Started: ${run.created_at}`,
      run.html_url ? `- Run page: ${run.html_url}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  } catch (e) {
    return `Status: ${bot.name} — error: ${e.message}`;
  }
}

// --- Commands ------------------------------------------------------------
// /ping here is BASIC on purpose (base v0.1.0): Worker -> GitHub API and
// Worker -> Telegram, ms + HTTP status. Last-run status/duration,
// dispatch timing and YouTube/Spotify reachability are later features.

async function pingOne(url, env) {
  const start = Date.now();
  try {
    const res = await httpFetch(env, url, { method: "GET", signal: AbortSignal.timeout(timeoutMs(env, 5000)) });
    await res.text().catch(() => {});
    return { url, ok: true, status: res.status, ms: Date.now() - start };
  } catch (e) {
    return { url, ok: false, status: null, ms: Date.now() - start, error: e.name || "fetch failed" };
  }
}

async function handlePing(env) {
  const targets = ["https://api.github.com", "https://api.telegram.org"];
  const results = [];
  for (const url of targets) results.push(await pingOne(url, env));
  const lines = ["Ping (basic, from the Worker edge):"];
  for (const r of results) {
    lines.push(
      r.ok
        ? `- ${r.url} — ${r.ms} ms (HTTP ${r.status})`
        : `- ${r.url} — FAILED in ${r.ms} ms (${r.error})`,
    );
  }
  const ok = results.filter((r) => r.ok);
  lines.push(
    ok.length === 0
      ? "Result: both unreachable from the Worker right now."
      : `Result: OK — best ${Math.min(...ok.map((r) => r.ms))} ms.`,
  );
  lines.push("Note: this is Worker -> service, not your phone -> service.");
  lines.push(`Version: ${VERSION}`);
  return reply(lines.join("\n"));
}

async function handleSync(env, chatId, botArg) {
  const picked = botArg ? findBotByArg(botArg) : null;
  if (botArg && !picked) {
    return reply(
      `Unknown bot "${botArg}". Pick one:\n${botLines()}`,
      botPickKeyboard("pick"),
    );
  }
  if (picked) {
    await saveLastBot(env, chatId, picked);
    if (!picked.repo) {
      return reply(
        `${picked.name} is not set up yet — its repo / workflow file is not known.\n` +
          `Give the repo + workflow file and it can be wired in.`,
        botPickKeyboard("pick"),
      );
    }
    return reply(
      `Sync — ${picked.name} (${picked.repo}):\nDry run previews only, real run writes to Spotify.`,
      syncChoiceKeyboard(picked),
    );
  }
  const saved = await loadLastBot(env, chatId);
  if (saved) {
    if (!saved.repo) {
      return reply(
        `Your last pick was ${saved.name}, which is not set up yet — pick another one:`,
        botPickKeyboard("pick"),
      );
    }
    return reply(
      `Sync — ${saved.name} (${saved.repo}) — remembered from last time.\nDry run previews only, real run writes to Spotify.`,
      syncChoiceKeyboard(saved),
    );
  }
  return reply(`Sync — pick a bot:\n${botLines()}`, botPickKeyboard("pick"));
}

async function handleStatus(env, chatId, botArg) {
  const picked = botArg ? findBotByArg(botArg) : null;
  if (botArg && !picked) {
    return reply(
      `Unknown bot "${botArg}". Pick one for status:`,
      botPickKeyboard("status"),
    );
  }
  const bot = picked || (await loadLastBot(env, chatId));
  if (!bot) {
    return reply("Status — pick a bot first:", botPickKeyboard("status"));
  }
  return reply(await lastRun(env, bot));
}

export async function handleCommand(env, chatId, text) {
  const cmd = (text || "").trim();
  const mapped = KEYBOARD_COMMANDS[cmd] || cmd;
  const [base, ...rest] = mapped.split(/\s+/);
  const arg = rest.join(" ").trim() || null;

  if (base === "/start") {
    return reply(
      `Playlist sync control bot — welcome!\n\n${HELP_TEXT}`,
      MAIN_KEYBOARD,
    );
  }
  if (base === "/help") {
    return reply(HELP_TEXT, MAIN_KEYBOARD);
  }
  if (base === "/sync") return handleSync(env, chatId, arg);
  if (base === "/status") return handleStatus(env, chatId, arg);
  if (base === "/ping") return handlePing(env);
  if (base === "/list") {
    return reply(
      "No /list command — there are too many songs to list, so it was left out on purpose.",
    );
  }
  if (base.startsWith("/")) {
    return reply(`Unknown command ${base}.\n\n${HELP_TEXT}`, MAIN_KEYBOARD);
  }
  return reply(`I only answer commands.\n\n${HELP_TEXT}`, MAIN_KEYBOARD);
}

export async function handleCallbackQuery(env, chatId, callbackQuery) {
  const data = callbackQuery.data || "";
  const parts = data.split(":");
  const kind = parts[0];

  if (kind === "pick" || kind === "status") {
    const bot = findBot(parts[1]);
    if (!bot) return reply("Unknown button — send /sync to pick again.");
    await saveLastBot(env, chatId, bot);
    if (kind === "status") return reply(await lastRun(env, bot));
    if (!bot.repo) {
      return reply(
        `${bot.name} is not set up yet — its repo / workflow file is not known.\n` +
          `Give the repo + workflow file and it can be wired in.`,
        botPickKeyboard("pick"),
      );
    }
    return reply(
      `Sync — ${bot.name} (${bot.repo}):\nDry run previews only, real run writes to Spotify.`,
      syncChoiceKeyboard(bot),
    );
  }

  if (kind === "change") {
    return reply(`Sync — pick a bot:\n${botLines()}`, botPickKeyboard("pick"));
  }

  if (kind === "sync") {
    const mode = parts[1]; // dry | real
    const bot = findBot(parts[2]);
    if (!bot) return reply("Unknown button — send /sync to pick again.");
    if (mode === "dry") {
      const res = await dispatchSync(env, bot, true);
      return reply(
        res.ok
          ? `✅ Dry run dispatched for ${bot.name} — preview only, nothing written to Spotify. Check the run page in a minute with /status.`
          : `❌ Dry run failed for ${bot.name}: ${res.detail}`,
      );
    }
    if (mode === "real") {
      return reply(
        `⚠️ Real run for ${bot.name} will WRITE to Spotify.\nAre you sure?`,
        confirmRealKeyboard(bot),
      );
    }
    return reply("Unknown button — send /sync to pick again.");
  }

  if (kind === "confirm") {
    const bot = findBot(parts[2]);
    if (!bot) return reply("Unknown button — send /sync to pick again.");
    const res = await dispatchSync(env, bot, false);
    return reply(
      res.ok
        ? `✅ Real run dispatched for ${bot.name} — writing to Spotify. Check /status in a minute.`
        : `❌ Real run failed for ${bot.name}: ${res.detail}`,
    );
  }

  return reply("Unknown button — send /help for commands.");
}

// --- Shared update handler ------------------------------------------------
// One place, one behavior: used by the Workers webhook (fetch below) and
// by the Node long-polling entry point (src/polling.js). It answers the
// update and sends/edits the reply; it never returns an HTTP response.

export async function handleUpdate(env, update) {
  if (!update || typeof update !== "object") return;

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id ?? cq.from?.id;
    if (String(chatId) !== ALLOWED_CHAT_ID) return;
    await answerCallbackQuery(env, cq.id, "");
    const result = await handleCallbackQuery(env, chatId, cq);
    // Edit the message the button was on, so the chat does not fill up.
    if (env.TELEGRAM_BOT_TOKEN && cq.message?.message_id) {
      try {
        await httpFetch(
          env,
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: cq.message.message_id,
              text: result.text,
              ...(result.replyMarkup ? { reply_markup: result.replyMarkup } : {}),
            }),
          },
        );
      } catch (e) {
        console.log("[telegram] edit failed:", e.message);
        await sendTelegram(env, chatId, result.text, result.replyMarkup);
      }
    } else {
      await sendTelegram(env, chatId, result.text, result.replyMarkup);
    }
    return;
  }

  const message = update.message;
  if (!message || typeof message.text !== "string") return;
  const chatId = message.chat?.id;
  if (String(chatId) !== ALLOWED_CHAT_ID) return;

  const result = await handleCommand(env, chatId, message.text);
  await sendTelegram(env, chatId, result.text, result.replyMarkup);
}

// --- Worker entry ---------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`Playlist sync control bot is running (v${VERSION}).`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("OK", { status: 200 });
      }
    }

    await handleUpdate(env, update);
    return new Response("OK", { status: 200 });
  },
};
