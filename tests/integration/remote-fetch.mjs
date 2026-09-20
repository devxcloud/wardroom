import { spawn } from "node:child_process";

// Test-only transport through the already-validated SSH Docker context. No
// listener is published and no credentials appear in process arguments.
export async function remoteFetch(input, init) {
  const request = new Request(input, init);
  const headers = Object.fromEntries(request.headers);
  headers.host = new URL(request.url).host;
  const payload = JSON.stringify({
    method: request.method,
    headers,
    body: await request.text(),
  });
  const code = `import http from 'node:http'; let raw=''; for await(const c of process.stdin) raw+=c;
    const a=JSON.parse(raw); const r=http.request({host:'127.0.0.1',port:8790,path:'/mcp',method:a.method,headers:a.headers},s=>{
      let b='';s.on('data',c=>b+=c);s.on('end',()=>process.stdout.write(JSON.stringify({status:s.statusCode,headers:s.headers,body:b})));});
    r.on('error',()=>{process.stderr.write('Remote MCP request failed');process.exitCode=1});r.end(a.body);`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "scripts/compose.sh",
        "exec",
        "-T",
        "mcp",
        "node",
        "--input-type=module",
        "-e",
        code,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0)
        reject(Error("Remote MCP test transport failed: " + err.slice(0, 300)));
      else {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error("Invalid remote MCP transport response"));
        }
      }
    });
    child.stdin.end(payload);
  });
  return new Response(
    [204, 205, 304].includes(result.status) ? null : result.body,
    { status: result.status, headers: result.headers },
  );
}
