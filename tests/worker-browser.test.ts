/**
 * Regression tests for the Telegram worker directory picker
 * Covers listing, keyboard shape, navigation, start, expiry, and root defaults
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramWorkerDirectoryBrowser,
  TELEGRAM_WORKER_CALLBACK_PREFIX,
  type TelegramWorkerBrowserReply,
} from "../lib/worker-browser.ts";

const tree: Record<string, string[]> = {
  "/home/u": ["projects", "Downloads", ".hidden"],
  "/home/u/projects": ["alpha", "beta"],
  "/home/u/projects/alpha": [],
};

function buttonFor(reply: TelegramWorkerBrowserReply, text: string): string {
  const match = (reply.keyboard?.inline_keyboard ?? [])
    .flat()
    .find((button) => button.text.includes(text));
  assert.ok(match, `expected a button containing ${text}`);
  return match.callback_data;
}

function setup() {
  const started: string[] = [];
  const browser = createTelegramWorkerDirectoryBrowser({
    root: "/home/u",
    listDirectories: (path) => tree[path] ?? [],
    resolveDirectory: (path) => (path in tree ? path : undefined),
    onStart: (path) => {
      started.push(path);
      return { ok: true, message: `Starting worker in ${path}` };
    },
  });
  return { browser, started };
}

test("Directory picker lists subdirectories with a start and back row", () => {
  const { browser } = setup();
  const reply = browser.open();
  assert.equal(reply.ok, true);
  assert.match(reply.html, /\/home\/u/u);
  assert.match(reply.html, /projects/u);
  assert.doesNotMatch(reply.html, /\.hidden/u);
  const flat = (reply.keyboard?.inline_keyboard ?? []).flat();
  assert.ok(flat.some((button) => button.text.includes("projects")));
  assert.ok(flat.some((button) => button.text.includes("Start a worker here")));
  assert.ok(
    flat.some(
      (button) => button.callback_data === `${TELEGRAM_WORKER_CALLBACK_PREFIX}c`,
    ),
  );
});

test("Directory picker navigates into a subdirectory and back up", () => {
  const { browser } = setup();
  const root = browser.open("/home/u");
  const into = browser.navigate(buttonFor(root, "projects"));
  assert.match(into.html, /\/home\/u\/projects/u);
  const up = browser.navigate(buttonFor(into, ".."));
  assert.match(up.html, /\/home\/u/u);
});

test("Directory picker starts a worker in the selected directory", () => {
  const { browser, started } = setup();
  const listing = browser.open("/home/u/projects");
  const reply = browser.navigate(buttonFor(listing, "Start a worker here"));
  assert.equal(reply.ok, true);
  assert.deepEqual(started, ["/home/u/projects"]);
  assert.match(reply.html, /Starting worker/u);
});

test("Directory picker reports an expired or unknown token", () => {
  const { browser } = setup();
  const reply = browser.navigate(`${TELEGRAM_WORKER_CALLBACK_PREFIX}o:zzzzzz:0`);
  assert.equal(reply.ok, false);
  assert.match(reply.html, /expired/u);
});

test("Directory picker rejects an unreadable path and exposes a list button", () => {
  const { browser } = setup();
  const missing = browser.open("/nope");
  assert.equal(missing.ok, false);
  assert.match(missing.html, /Not an existing directory/u);
  const listKeyboard = browser.keyboardForList();
  assert.equal(
    listKeyboard.inline_keyboard[0]?.[0]?.callback_data,
    `${TELEGRAM_WORKER_CALLBACK_PREFIX}b`,
  );
});
