import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressBelongs,
  messageBelongs,
  AgentMail,
} from "../dashboard/agent/mail.mjs";

test("project mail domain is exactly {project}.test or {project}.local", () => {
  assert.equal(addressBelongs("dev@thryx.test", "thryx"), true);
  assert.equal(addressBelongs("noreply@thryx.local", "thryx"), true);
  assert.equal(addressBelongs("noreply@thryx.io", "thryx"), false);
  assert.equal(addressBelongs("thryx@example.com", "thryx"), false);
  assert.equal(addressBelongs("user@gmail.com", "thryx"), false);
  assert.equal(addressBelongs("user@other.test", "test"), false);
  assert.equal(addressBelongs("user@thryx.local", "local"), false);
  assert.equal(
    messageBelongs(
      {
        From: { Address: "noreply@thryx.test" },
        To: [{ Address: "user@gmail.com" }],
      },
      "thryx",
    ),
    true,
  );
  assert.equal(
    messageBelongs(
      {
        From: { Address: "other@example.com" },
        To: [{ Address: "user@gmail.com" }],
      },
      "thryx",
    ),
    false,
  );
});

test("mail tools hide other projects, refuse unscoped deletes, and truncated follows the unfiltered page", async () => {
  const keep = {
    ID: "keep",
    From: { Address: "noreply@thryx.test" },
    To: [{ Address: "user@gmail.com" }],
    Subject: "Reset",
    Created: "now",
    Size: 12,
  };
  const drop = {
    ID: "drop",
    From: { Address: "other@example.com" },
    To: [{ Address: "user@gmail.com" }],
    Subject: "Nope",
  };
  const page = [keep, ...Array.from({ length: 49 }, () => drop)];
  const calls = [];
  const mail = new AgentMail("http://mailpit:8025", {
    fetch: async (url, options = {}) => {
      calls.push([options.method || "GET", String(url), options.body]);
      if (String(url).includes("/search"))
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ messages: page, total: 80 }),
        };
      if (String(url).includes("/message/keep"))
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify(keep),
        };
      if (String(url).includes("/message/drop"))
        return {
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify(drop),
        };
      return {
        ok: true,
        headers: { get: () => "text/plain" },
        text: async () => "ok",
      };
    },
  });
  const listed = await mail.list({ project: "thryx" });
  assert.deepEqual(
    listed.messages.map((m) => m.id),
    ["keep"],
  );
  assert.equal(listed.mailDomain, "thryx.test");
  assert.equal(listed.truncated, true);
  assert.match(calls[0][1], /thryx\.test/);
  assert.match(
    decodeURIComponent(calls[0][1].replaceAll("+", "%20")),
    /thryx\.test OR thryx\.local/,
  );
  await assert.rejects(mail.get({ project: "thryx", id: "drop" }), /mail domain/);
  await assert.rejects(mail.remove({ project: "thryx", id: "drop" }), /mail domain/);
  await mail.remove({ project: "thryx", id: "keep" });
  assert.equal(calls.at(-1)[0], "DELETE");
  assert.match(calls.at(-1)[2], /keep/);
  assert.doesNotMatch(calls.at(-1)[2], /drop/);
});
