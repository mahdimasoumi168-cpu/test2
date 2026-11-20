const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const audioEngine = fs.readFileSync(path.join(__dirname, "..", "public", "audio-processing.js"), "utf8");
const appScript = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const scripts = [audioEngine, appScript, ...[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])].filter(source => source.trim());
if (!scripts.length) throw new Error("No inline application script found.");
const temp = path.join(os.tmpdir(), "hamyar-client-check-" + process.pid + ".js");
try {
  fs.writeFileSync(temp, scripts.join("\n"));
  const result = spawnSync(process.execPath, ["--check", temp], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  console.log("Client JavaScript syntax: OK");
} finally {
  try { fs.unlinkSync(temp); } catch {}
}
