// Local dev server: serves web/ and proxies /api/* to the deployed site,
// mimicking production routing. Run `node dev-server.mjs`, open localhost:4173.
//
// The live URL is deliberately not in this repo. Put it in a `.api-url` file
// next to this script (ignored by git), or set the SCHEDULE_API env var.
import http from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, "web");

let API = process.env.SCHEDULE_API;
if (!API) {
  try {
    API = readFileSync(path.join(ROOT, ".api-url"), "utf8").trim();
  } catch {
    console.error("No API URL set. Create a .api-url file containing your deployed URL, or set SCHEDULE_API.");
    process.exit(1);
  }
}
const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

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
