import { createServer } from "node:http";
import type { TripAgent } from "./agent/handler";
import { config } from "./config";
import { log } from "./log";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Local-only page for the demo's "memory flex": which chat passages each
 * template question pulled for the latest plan. Bound to 127.0.0.1 because it
 * shows message text.
 */
export function startDebugServer(agent: TripAgent): void {
  if (config.DEBUG_PORT === 0) return;
  const server = createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    const sections = [...agent.recent.values()].map((trip) => {
      const slots = (trip.lastRetrieval ?? [])
        .map(
          (s) =>
            `<h3>${escape(s.slot)}</h3><p class="q">${escape(s.question)}</p><ol>${s.hits
              .map((h) => `<li><span class="tag">${h.via} ${h.score.toFixed(3)}</span> ${escape(h.preview)}…</li>`)
              .join("")}</ol>`,
        )
        .join("");
      return `<section><h2>${escape(trip.chatId)} · ${trip.phase}</h2>${slots || "<p>No plan yet.</p>"}</section>`;
    });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>${config.AGENT_NAME} memory</title>
<style>body{font:15px system-ui;margin:24px;max-width:960px;background:#fff;color:#111}h3{margin:18px 0 4px}.q{color:#555;margin:0}.tag{font:12px monospace;background:#eef;padding:1px 5px;border-radius:4px}li{margin:4px 0}</style>
<h1>${config.AGENT_NAME} retrieval</h1>${sections.join("") || "<p>No chats yet.</p>"}`);
  });
  server.on("error", (err) => log.error("debug_server_failed", err));
  server.listen(config.DEBUG_PORT, "127.0.0.1", () => log.info("debug_server", { url: `http://127.0.0.1:${config.DEBUG_PORT}` }));
}
