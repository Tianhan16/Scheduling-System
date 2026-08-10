// Local dev server: serves web/ and proxies /api/* to the deployed CloudFront,
// mimicking production routing. Run `node dev-server.mjs`, open localhost:4173.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const API = "https://private-url-removed.example";
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname.startsWith("/api/")) {
        let body = "";
        for await (const chunk of req) body += chunk;
        const r = await fetch(API + req.url, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body: body || undefined,
        });
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(await r.text());
        return;
      }
      const file = pathname === "/" ? "/index.html" : pathname;
      const data = await readFile(path.join(WEB, path.basename(file)));
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "text/plain" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(4173, () => console.log("dev server: http://localhost:4173"));
