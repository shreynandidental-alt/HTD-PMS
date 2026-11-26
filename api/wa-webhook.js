// Meta -> PMS webhook for HT Buddy (WhatsApp 7827913595).
// Configure in Meta App Dashboard (HTD PMS Messaging app) -> WhatsApp ->
// Configuration -> Webhook:
//   Callback URL: https://htd-pms.vercel.app/api/wa-webhook
//   Verify token: htd-pms-htbuddy   (or WA_WEBHOOK_VERIFY_TOKEN if set)
//   Webhook fields: messages
// Only events for HT Buddy's phone number are stored; everything else is
// acknowledged and ignored. If WA_APP_SECRET is set, Meta's signature is
// checked and unsigned/forged requests are rejected.

import crypto from "node:crypto";
import { HTB_PHONE_ID, saveMessage, db } from "./_lib/htbuddy.js";

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tsOf(sec) { return new Date((Number(sec) || Date.now() / 1000) * 1000).toISOString(); }

function fromIncoming(msg, contacts) {
  const c = (contacts || []).find((x) => x.wa_id === msg.from) || (contacts || [])[0] || {};
  const out = { id: msg.id, phone: msg.from, dir: "in", type: msg.type, ts: tsOf(msg.timestamp), profileName: c.profile && c.profile.name };
  const t = msg.type;
  if (t === "text") out.text = msg.text && msg.text.body;
  else if (t === "button") out.text = msg.button && (msg.button.text || msg.button.payload);
  else if (t === "interactive") {
    const i = msg.interactive || {};
    out.text = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || "[Interactive reply]";
  } else if (["image", "document", "audio", "video", "sticker"].includes(t)) {
    const m = msg[t] || {};
    out.mediaId = m.id; out.mime = m.mime_type; out.caption = m.caption; out.filename = m.filename;
  } else if (t === "location") {
    const l = msg.location || {};
    out.text = `📍 ${l.name || "Location"} ${l.address || ""} https://maps.google.com/?q=${l.latitude},${l.longitude}`.trim();
  } else if (t === "contacts") {
    out.text = "👤 " + ((msg.contacts || []).map((x) => (x.name && x.name.formatted_name) + " " + ((x.phones || [])[0] || {}).phone).join(", "));
  } else if (t === "reaction") {
    out.text = "Reacted " + ((msg.reaction && msg.reaction.emoji) || "");
  } else {
    out.text = "[" + t + " message]";
  }
  if (msg.context && msg.context.id) out.replyTo = msg.context.id;
  return out;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const q = req.query || {};
    const want = (process.env.WA_WEBHOOK_VERIFY_TOKEN || "htd-pms-htbuddy").trim();
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === want) return res.status(200).send(q["hub.challenge"]);
    return res.status(403).send("Forbidden");
  }
  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRaw(req);
  const secret = (process.env.WA_APP_SECRET || "").trim();
  if (secret) {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    const want = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send("Bad signature");
  }

  let body;
  try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return res.status(400).send("Bad JSON"); }
  const phoneId = HTB_PHONE_ID();
  try {
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        if (!v.metadata || v.metadata.phone_number_id !== phoneId) continue;
        for (const msg of v.messages || []) await saveMessage(fromIncoming(msg, v.contacts));
        for (const st of v.statuses || []) {
          const ref = db().collection("waMessages").doc(st.id);
          const snap = await ref.get();
          if (!snap.exists) continue; // only track messages the PMS sent
          const upd = { status: st.status, statusAt: tsOf(st.timestamp) };
          if (st.errors && st.errors[0]) upd.error = (st.errors[0].title || "") + (st.errors[0].error_data && st.errors[0].error_data.details ? " - " + st.errors[0].error_data.details : "");
          await ref.set(upd, { merge: true });
        }
      }
    }
  } catch (e) {
    console.error("[wa-webhook]", e);
  }
  return res.status(200).send("OK");
}
