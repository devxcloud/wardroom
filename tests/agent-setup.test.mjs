import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSetup, clientInstall } from "../dashboard/public/agents.js";

test("client setup preserves environment references and keeps Grok credentials in user scope", () => {
  const url = "http://devbox/mcp";
  const claude = JSON.parse(clientSetup("claude", url).code);
  assert.equal(claude.mcpServers.wardroom.url, url);
  assert.equal(
    claude.mcpServers.wardroom.headers.Authorization,
    "Bearer ${WARDROOM_MCP_TOKEN}",
  );
  assert.match(
    clientSetup("codex", url).code,
    /--bearer-token-env-var WARDROOM_MCP_TOKEN/,
  );
  assert.match(clientSetup("grok", url).code, /--scope user/);
  assert.match(clientSetup("grok", url).note, /stores the resolved token/);
  assert.match(clientSetup("other", url).code, /Streamable HTTP/);
  assert.match(
    clientInstall("claude", url).command,
    /claude mcp add-json --scope user/,
  );
  assert.match(
    clientInstall("claude", url).command,
    /\$\{WARDROOM_MCP_TOKEN\}/,
  );
  assert.match(
    clientInstall("codex", url).config,
    /bearer_token_env_var = "WARDROOM_MCP_TOKEN"/,
  );
});
