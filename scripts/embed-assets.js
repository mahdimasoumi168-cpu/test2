const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const output = path.join(root, "cloudflare", "src", "embedded-assets.js");
const files = [
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "application/javascript; charset=utf-8"],
  ["audio-processing.js", "application/javascript; charset=utf-8"],
  ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["sw.js", "application/javascript; charset=utf-8"],
  ["setup.html", "text/html; charset=utf-8"],
  ["setup.js", "application/javascript; charset=utf-8"]
];

const assets = {};
for (const [name, contentType] of files) {
  const filePath = path.join(publicDir, name);
  assets["/" + name] = {
    content: fs.readFileSync(filePath, "utf8"),
    contentType
  };
}

const source = "export const STATIC_ASSETS = " + JSON.stringify(assets) + ";\n";
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, source, "utf8");
console.log("Embedded " + files.length + " public assets into " + path.relative(root, output));
