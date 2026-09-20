import { test } from "node:test";
import assert from "node:assert/strict";
import { redisKey } from "../dashboard/agent/data.mjs";
test("relative Redis keys always stay inside exact project prefix", () => {
  assert.equal(redisKey("alpha:", "alpha2:secret"), "alpha:alpha2:secret");
  assert.equal(redisKey("alpha:", "*"), "alpha:*");
  assert.throws(() => redisKey("alpha:", "\0"));
  assert.throws(() => redisKey("alpha:", ""));
});
