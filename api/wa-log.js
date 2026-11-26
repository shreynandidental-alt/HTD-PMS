// Marketing OS -> HT Buddy: copies of messages the Marketing OS sends from
// 7827913595 (AI chatbot replies, or staff replies typed in the Marketing OS),
// so the PMS's HT Buddy chat shows the whole conversation, not only the
// patient's side. (Meta only sends a message's text to the app that sent it.)
//
// Called by the Marketing OS worker after each successful send:
//   POST https://htd-pms.vercel.app/api/wa-log
//   Authorization: Bearer <OS_SYNC_KEY>      (same key as /api/os-sync)
//   { "phone": "919876543210", "text": "...", "id": "<wamid from Meta>",
//     "type": "text" | "template" | "image" | ..., "template": "name",
//     "by": "ai" | "<staff name>", "ts": "<ISO time, optional>" }
//   or { "messages": [ {...}, {...} ] } for several at once (max 50).
// Saving is idempotent: the same Meta message id is stored once.

import { timingSafeEqual } from "node:crypto";
import { saveMessage, normPhone } from "./_lib/htbuddy.js";

function authorised(req) {
  const key = process.env.OS_SYNC_KEY || "";
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!key || key.length < 16 || !got) return false;
  const a = Buffer.from(key), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TYPES = new Set(["text", "template", "image", "document", "audio", "video", "sticker", "interactive", "location"]);

function clean(m) {
  const phone = normPhone(m.phone || m.to);
  if (phone.length < 11) return null;
  const type = TYPES.has(m.type) ? m.type : (m.template ? "template" : "text");
  const text = String(m.text || m.body || m.caption || "").slice(0, 4096);
  if (!text && type === "text") return null;
  const ts = m.ts && !isNaN(Date.parse(m.ts)) ? new Date(m.ts).toISOString() : new Date().toISOString();
  const id = /^[A-Za-z0-9._=:-]{6,200}$/.test(String(m.id || "")) ? String(m.id) : undefined;
  return {
    id, phone, dir: "out", type, text,
    template: m.template ? String(m.template).slice(0, 120) : undefined,
    by: String(m.by || "ai").slice(0, 60),
    source: "marketing-os",
    ts, status: m.status ? String(m.status).slice(0, 20) : "sent",
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.OS_SYNC_KEY) return res.status(503).json({ error: "OS_SYNC_KEY is not set in Vercel yet" });
  if (!authorised(req)) return res.status(401).json({ error: "unauthorised" });

  const b = req.body || {};
  const list = (Array.isArray(b.messages) ? b.messages : [b]).slice(0, 50).map(clean).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: "Nothing to save (phone and text are required)" });
  try {
    let saved = 0;
    for (const m of list) { await saveMessage(m); saved++; }
    return res.json({ ok: true, saved });
  } catch (e) {
    console.error("[wa-log]", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
