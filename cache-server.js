// Run with: node cache-server.js
// Serves GET/POST http://localhost:3456/<key> → cached_api_calls/<key>.json

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3456;
const CACHE_DIR = path.join(__dirname, "cached_api_calls");
fs.mkdirSync(CACHE_DIR, { recursive: true });

function safeFilename(key) {
  // Allow only alphanumeric, hyphens, underscores — reject traversal attempts
  return /^[\w-]+$/.test(key) ? key : null;
}

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const key = safeFilename(req.url.replace(/^\//, ""));
    if (!key) {
      res.writeHead(400);
      res.end("Invalid key");
      return;
    }

    const file = path.join(CACHE_DIR, `${key}.json`);

    if (req.method === "GET") {
      try {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(fs.readFileSync(file, "utf8"));
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    } else if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          fs.writeFileSync(file, body, "utf8");
          res.writeHead(200);
          res.end("OK");
        } catch {
          res.writeHead(500);
          res.end("Write failed");
        }
      });
    } else {
      res.writeHead(405);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`Cache server → http://localhost:${PORT}  (files in cached_api_calls/)`));
