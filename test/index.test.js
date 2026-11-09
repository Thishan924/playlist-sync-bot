import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleCommand, handleCallbackQuery } from "../src/index.js";

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

test("/sync scour says it is not set up yet", async () => {
  const result = await handleCommand(env, chatId, "/sync scour");
  assert.match(result.text, /not set up yet/);
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
    assert.match(result.text, /completed \/ success/);
    assert.match(result.text, /2026-11-09/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("callback_query with unknown data returns 200, no crash", async () => {
  const result = await handleCallbackQuery(env, chatId, {
    id: "cb6",
    data: "nonsense",
    message: { chat: { id: chatId } },
  });
  assert.match(result.text, /Unknown button/);
});
