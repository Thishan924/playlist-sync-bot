import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleCommand, handleCallbackQuery, nextSyncSlot, VERSION } from "../src/index.js";

const env = {}; // no tokens — sendTelegram must not crash
const chatId = 7933991754;

async function post(update, envOverride) {
  const req = new Request("https://bot.example/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  return worker.fetch(req, envOverride || env);
}

function fakeKV() {
  const store = new Map();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => store.set(k, v),
  };
}

test("GET / is a health check", async () => {
  const res = await worker.fetch(new Request("https://bot.example/"), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Playlist sync control bot is running/);
});

test("POST /help returns 200 without a Telegram token", async () => {
  const res = await post({ message: { chat: { id: chatId }, text: "/help" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
});

test("POST /ping returns 200 without a Telegram token", async () => {
  const res = await post({ message: { chat: { id: chatId }, text: "/ping" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
});

test("POST from another chat is ignored (allowed chat is 7933991754)", async () => {
  const res = await post({ message: { chat: { id: 123 }, text: "/help" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
});

test("POST with no message is ignored", async () => {
  const res = await post({});
  assert.equal(res.status, 200);
});

test("/help lists /sync /status /ping and says no /list", async () => {
  const result = await handleCommand(env, chatId, "/help");
  assert.match(result.text, /\/sync/);
  assert.match(result.text, /\/status/);
  assert.match(result.text, /\/ping/);
  assert.match(result.text, /No \/list/);
});

test("/list is refused on purpose", async () => {
  const result = await handleCommand(env, chatId, "/list");
  assert.match(result.text, /No \/list command/);
});

test("/sync with no saved bot asks to pick one", async () => {
  const result = await handleCommand(env, chatId, "/sync");
  assert.match(result.text, /pick a bot/);
  assert.match(result.text, /Cool phonks/);
  assert.match(result.text, /Trending Phonk/);
});

test("/sync cool goes straight to Dry / Real choice", async () => {
  const result = await handleCommand(env, chatId, "/sync cool");
  assert.match(result.text, /Cool phonks/);
  assert.match(result.text, /Dry run/);
  const labels = result.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(labels.includes("sync:dry:cool"));
  assert.ok(labels.includes("sync:real:cool"));
});

test("/sync scour goes straight to Dry / Real choice", async () => {
  const result = await handleCommand(env, chatId, "/sync scour");
  assert.match(result.text, /botstar phonk playlist/);
  assert.match(result.text, /Dry run/);
  const labels = result.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(labels.includes("sync:dry:scour"));
  assert.ok(labels.includes("sync:real:scour"));
});

test("pick callback saves last bot in KV, next /sync reuses it", async () => {
  const kvEnv = { BOT_KV: fakeKV() };
  const picked = await handleCallbackQuery(kvEnv, chatId, {
    id: "cb1",
    data: "pick:trending",
    message: { chat: { id: chatId } },
  });
  assert.match(picked.text, /Trending Phonk/);
  const next = await handleCommand(kvEnv, chatId, "/sync");
  assert.match(next.text, /Trending Phonk/);
  assert.match(next.text, /remembered/);
});

test("dry dispatch without GITHUB_PAT fails cleanly and calls no fetch", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("fetch must not be called without GITHUB_PAT");
  };
  try {
    const result = await handleCallbackQuery(env, chatId, {
      id: "cb2",
      data: "sync:dry:cool",
      message: { chat: { id: chatId } },
    });
    assert.match(result.text, /GITHUB_PAT/);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("dry dispatch sends workflow_dispatch with dry_run=true + User-Agent", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(null, { status: 204 });
  };
  try {
    const result = await handleCallbackQuery(
      { GITHUB_PAT: "fake-pat" },
      chatId,
      { id: "cb3", data: "sync:dry:trending", message: { chat: { id: chatId } } },
    );
    assert.match(result.text, /Dry run dispatched/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /thishan2012\/-zq9-void-200\/actions\/workflows\/sync\.yml\/dispatches/);
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers["User-Agent"], "playlist-sync-bot");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.inputs.dry_run, "true");
    assert.equal(body.inputs.reset_db, "none");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("cool dispatch sends dry_run only — no reset_db (its workflow has none)", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(null, { status: 204 });
  };
  try {
    const result = await handleCallbackQuery(
      { GITHUB_PAT: "fake-pat" },
      chatId,
      { id: "cb3b", data: "sync:dry:cool", message: { chat: { id: chatId } } },
    );
    assert.match(result.text, /Dry run dispatched/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /thishan2012\/Spotify-yt-playlist-sync-testing\/actions\/workflows\/sync\.yml\/dispatches/);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.inputs.dry_run, "true");
    assert.equal("reset_db" in body.inputs, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("scour dispatch sends dry_run only to zq9-void-200-s2y", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(null, { status: 204 });
  };
  try {
    const result = await handleCallbackQuery(
      { GITHUB_PAT: "fake-pat" },
      chatId,
      { id: "cb3c", data: "sync:dry:scour", message: { chat: { id: chatId } } },
    );
    assert.match(result.text, /Dry run dispatched/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /thishan2012\/zq9-void-200-s2y\/actions\/workflows\/sync\.yml\/dispatches/);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.inputs.dry_run, "true");
    assert.equal("reset_db" in body.inputs, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("real run asks to confirm first, confirm dispatches dry_run=false", async () => {
  const ask = await handleCallbackQuery(env, chatId, {
    id: "cb4",
    data: "sync:real:cool",
    message: { chat: { id: chatId } },
  });
  assert.match(ask.text, /Are you sure/);
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(null, { status: 204 });
  };
  try {
    const result = await handleCallbackQuery(
      { GITHUB_PAT: "fake-pat" },
      chatId,
      { id: "cb5", data: "confirm:real:cool", message: { chat: { id: chatId } } },
    );
    assert.match(result.text, /Real run dispatched/);
    assert.equal(JSON.parse(calls[0].opts.body).inputs.dry_run, "false");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/status with no saved bot asks to pick one", async () => {
  const result = await handleCommand(env, chatId, "/status");
  assert.match(result.text, /pick a bot/);
});

test("/status reports the last run from the GitHub API (stubbed)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /workflow_runs|runs\?per_page=1/);
    return new Response(
      JSON.stringify({
        workflow_runs: [
          {
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-09T00:00:00Z",
            html_url: "https://github.com/x/y/actions/runs/1",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await handleCommand(
      { GITHUB_PAT: "fake-pat", BOT_KV: fakeKV() },
      chatId,
      "/status trending",
    );
    assert.match(result.text, /success/);
    assert.match(result.text, /Nov 9, 05:30/);
    assert.match(result.text, /github\.com\/x\/y\/actions\/runs\/1/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/runs with no saved bot asks to pick one", async () => {
  const result = await handleCommand(env, chatId, "/runs");
  assert.match(result.text, /pick a bot/);
});

test("/runs reports the last runs from the GitHub API (stubbed)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /runs\?per_page=5/);
    return new Response(
      JSON.stringify({
        workflow_runs: [
          {
            status: "completed",
            conclusion: "success",
            event: "schedule",
            created_at: "2026-11-09T06:00:00Z",
            updated_at: "2026-11-09T06:00:44Z",
            html_url: "https://github.com/x/y/actions/runs/2",
          },
          {
            status: "completed",
            conclusion: "failure",
            event: "workflow_dispatch",
            created_at: "2026-11-08T17:47:00Z",
            updated_at: "2026-11-08T17:47:55Z",
            html_url: "https://github.com/x/y/actions/runs/1",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await handleCommand(
      { GITHUB_PAT: "fake-pat", BOT_KV: fakeKV() },
      chatId,
      "/runs trending",
    );
    assert.match(result.text, /Runs — Trending Phonk/);
    assert.match(result.text, /✅ success/);
    assert.match(result.text, /❌ failure/);
    assert.match(result.text, /Scheduled/);
    assert.match(result.text, /Manual/);
    assert.match(result.text, /44s/);
    assert.match(result.text, /55s/);
    assert.match(result.text, /Nov 9, 11:30/);
    assert.match(result.text, /github\.com\/x\/y\/actions\/runs\/2/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/runs with no runs reports none", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ workflow_runs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await handleCommand(
      { GITHUB_PAT: "fake-pat", BOT_KV: fakeKV() },
      chatId,
      "/runs cool",
    );
    assert.match(result.text, /no runs yet/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("runs callback lists runs for the picked bot", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        workflow_runs: [
          {
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            created_at: "2026-11-09T06:00:00Z",
            updated_at: "2026-11-09T06:00:32Z",
            html_url: "https://github.com/x/y/actions/runs/3",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await handleCallbackQuery(
      { GITHUB_PAT: "fake-pat", BOT_KV: fakeKV() },
      chatId,
      { id: "cb7", data: "runs:trending", message: { chat: { id: chatId } } },
    );
    assert.match(result.text, /Runs — Trending Phonk/);
    assert.match(result.text, /✅ success/);
    assert.match(result.text, /32s/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/github reports All Systems Operational with no incidents (stubbed)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /githubstatus\.com\/api\/v2\/summary\.json/);
    return new Response(
      JSON.stringify({
        status: { indicator: "none", description: "All Systems Operational" },
        incidents: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await handleCommand(env, chatId, "/github");
    assert.match(result.text, /All Systems Operational/);
    assert.match(result.text, /No active incidents/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/github lists an active incident (stubbed)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        status: { indicator: "minor", description: "Partial System Outage" },
        incidents: [{ name: "Actions delays", status: "investigating", impact: "minor" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await handleCommand(env, chatId, "/github");
    assert.match(result.text, /Partial System Outage/);
    assert.match(result.text, /Actions delays/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/github fetch failure reports cleanly", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("boom");
  };
  try {
    const result = await handleCommand(env, chatId, "/github");
    assert.match(result.text, /could not reach githubstatus\.com/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("nextSyncSlot at 12:00 Colombo is today 17:47", () => {
  // 12:00 Colombo = 06:30 UTC.
  const slot = nextSyncSlot(Date.UTC(2026, 10, 9, 6, 30));
  assert.equal(slot.dayOffset, 0);
  assert.equal(slot.slot, 17 * 60 + 47);
});

test("nextSyncSlot at 23:50 Colombo is tomorrow 05:47", () => {
  // 23:50 Colombo = 18:20 UTC.
  const slot = nextSyncSlot(Date.UTC(2026, 10, 9, 18, 20));
  assert.equal(slot.dayOffset, 1);
  assert.equal(slot.slot, 5 * 60 + 47);
});

test("/about shows the version, host and sync bots", async () => {
  const result = await handleCommand(env, chatId, "/about");
  assert.match(result.text, new RegExp(`Version: ${VERSION}`));
  assert.match(result.text, /Vercel/);
  assert.match(result.text, /schkoss_logs_playlist_bot/);
  assert.match(result.text, /Cool phonks/);
  assert.match(result.text, /Trending Phonk/);
  assert.match(result.text, /botstar phonk playlist/);
  assert.match(result.text, /05:47 \/ 11:47 \/ 17:47 \/ 23:47/);
});

test("/help lists /about", async () => {
  const result = await handleCommand(env, chatId, "/help");
  assert.match(result.text, /\/about/);
});

test("/next reports the next scheduled sync time", async () => {
  const result = await handleCommand(env, chatId, "/next");
  assert.match(result.text, /Next scheduled sync/);
  assert.match(result.text, /05:47 \/ 11:47 \/ 17:47 \/ 23:47/);
  assert.match(result.text, /dry runs/);
});

test("callback_query with unknown data returns 200, no crash", async () => {
  const result = await handleCallbackQuery(env, chatId, {
    id: "cb6",
    data: "nonsense",
    message: { chat: { id: chatId } },
  });
  assert.match(result.text, /Unknown button/);
});
