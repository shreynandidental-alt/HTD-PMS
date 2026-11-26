// PMS -> HT Buddy (WhatsApp 7827913595). Signed-in clinic staff only.
// POST JSON {action, ...}:
//   threads                         latest 150 conversations
//   messages   {phone}              one conversation (last 300 messages)
//   read       {phone}              mark conversation read
//   send_text  {phone, text}        free text (only inside the 24-hour window)
//   send_template {phone, name, params[], language}
//   templates                       approved templates with their body text
//   media      {mediaId}            a photo/document as a data: URL (<= 4 MB)
//   status                          is the inbox receiving? (last webhook)

import { HTB_PHONE_ID, HTB_WABA_ID, db, graph, normPhone, saveMessage, verifyStaff } from "./_lib/htbuddy.js";

const DAY = 24 * 60 * 60 * 1000;

async function sendToMeta(phone, payload) {
  const r = await graph(`${HTB_PHONE_ID()}/messages`, { method: "POST", body: Object.assign({ messaging_product: "whatsapp", recipient_type: "individual", to: phone }, payload) });
  if (!r.ok) {
    const e = r.data.error || {};
    const detail = e.error_data && e.error_data.details ? " - " + e.error_data.details : "";
    let msg = (e.message || "WhatsApp send failed") + detail;
    if (e.code === 131047) msg = "More than 24 hours since this patient's last message - send a template instead.";
    throw Object.assign(new Error(msg), { status: 400, code: e.code });
  }
  return r.data.messages && r.data.messages[0] && r.data.messages[0].id;
}

function countParams(text) {
  const m = String(text || "").match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return m.reduce((mx, x) => Math.max(mx, Number(x.replace(/\D/g, ""))), 0);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.WA_ACCESS_TOKEN) return res.status(503).json({ error: "WA_ACCESS_TOKEN is not set in Vercel" });
  let who;
  try { who = await verifyStaff(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  const b = req.body || {};
  const fs = db();
  try {
    switch (b.action) {
      case "threads": {
        const snap = await fs.collection("waThreads").orderBy("lastAt", "desc").limit(150).get();
        const threads = []; snap.forEach((d) => threads.push(d.data()));
        return res.json({ threads, phone: "7827913595" });
      }
      case "messages": {
        const phone = normPhone(b.phone);
        const snap = await fs.collection("waMessages").where("phone", "==", phone).get();
        const msgs = []; snap.forEach((d) => msgs.push(d.data()));
        msgs.sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
        const t = await fs.collection("waThreads").doc(phone).get();
        return res.json({ messages: msgs.slice(-300), thread: t.exists ? t.data() : { phone } });
      }
      case "read": {
        const phone = normPhone(b.phone);
        await fs.collection("waThreads").doc(phone).set({ unread: 0 }, { merge: true });
        return res.json({ ok: true });
      }
      case "send_text": {
        const phone = normPhone(b.phone);
        const text = String(b.text || "").trim();
        if (!phone || !text) return res.status(400).json({ error: "Phone and message are required" });
        if (text.length > 4096) return res.status(400).json({ error: "Message is too long (max 4096 characters)" });
        const t = await fs.collection("waThreads").doc(phone).get();
        const lastIn = t.exists && t.data().lastInboundAt ? new Date(t.data().lastInboundAt).getTime() : 0;
        if (!lastIn || Date.now() - lastIn > DAY) return res.status(400).json({ error: "More than 24 hours since this patient's last message - send a template instead.", needTemplate: true });
        const id = await sendToMeta(phone, { type: "text", text: { preview_url: true, body: text } });
        const m = await saveMessage({ id, phone, dir: "out", type: "text", text, ts: new Date().toISOString(), status: "sent", by: who.email });
        return res.json({ ok: true, message: m });
      }
      case "send_template": {
        const phone = normPhone(b.phone);
        if (!phone || !b.name) return res.status(400).json({ error: "Phone and template are required" });
        const params = (b.params || []).map((x) => { const s = String(x == null ? "" : x).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim(); return { type: "text", text: s || "-" }; });
        const payload = { type: "template", template: { name: b.name, language: { code: b.language || "en" }, ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}) } };
        const id = await sendToMeta(phone, payload);
        const m = await saveMessage({ id, phone, dir: "out", type: "template", template: b.name, text: b.preview || "", ts: new Date().toISOString(), status: "sent", by: who.email, profileName: b.profileName || undefined });
        return res.json({ ok: true, message: m });
      }
      case "templates": {
        const out = [];
        let next = `${HTB_WABA_ID()}/message_templates?fields=name,status,category,language,components&limit=100`;
        for (let i = 0; i < 5 && next; i++) {
          const r = await graph(next);
          if (!r.ok) return res.status(400).json({ error: (r.data.error && r.data.error.message) || "Couldn't load templates" });
          (r.data.data || []).forEach((t) => {
            if (t.status !== "APPROVED") return;
            const body = (t.components || []).find((c) => c.type === "BODY") || {};
            const head = (t.components || []).find((c) => c.type === "HEADER") || {};
            if (head.format && head.format !== "TEXT") return; // media-header templates need a file; not offered here
            if (countParams(head.text)) return;
            out.push({ name: t.name, category: t.category, language: t.language, body: body.text || "", params: countParams(body.text) });
          });
          next = r.data.paging && r.data.paging.next ? r.data.paging.next : null;
        }
        out.sort((a, b2) => a.name.localeCompare(b2.name));
        return res.json({ templates: out });
      }
      case "media": {
        if (!/^\d+$/.test(String(b.mediaId || ""))) return res.status(400).json({ error: "Bad media id" });
        const info = await graph(String(b.mediaId));
        if (!info.ok || !info.data.url) return res.status(404).json({ error: "Media not available (WhatsApp keeps it for 30 days)" });
        if (info.data.file_size && info.data.file_size > 4 * 1024 * 1024) return res.status(413).json({ error: "File is larger than 4 MB" });
        const r = await graph(info.data.url, { raw: true });
        const buf = Buffer.from(await r.arrayBuffer());
        return res.json({ dataUrl: `data:${info.data.mime_type || "application/octet-stream"};base64,${buf.toString("base64")}`, mime: info.data.mime_type });
      }
      case "status": {
        const snap = await fs.collection("waThreads").orderBy("lastAt", "desc").limit(30).get();
        let lastIn = null; snap.forEach((d) => { const x = d.data().lastInboundAt; if (x && (!lastIn || x > lastIn)) lastIn = x; });
        return res.json({ lastInbound: lastIn, phoneId: HTB_PHONE_ID() });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || String(e), needTemplate: e.code === 131047 });
  }
}
