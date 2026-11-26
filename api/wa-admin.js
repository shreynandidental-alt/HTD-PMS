// Admin-only WhatsApp (Meta) helper for moving PMS messaging from
// 7827168138 (Interakt) to 7827913595 (Meta Cloud API, direct).
//
//   action "info"              read-only: phone numbers + template counts of
//                              both WhatsApp accounts
//   action "apps"              read-only: which Meta app the token belongs to
//                              and which apps receive 7827913595's webhooks
//   action "subscribe"         connects the HTD PMS Messaging app to
//                              7827913595's account (HT Buddy inbox)
//   action "migrate_templates" copies every approved template from the old
//                              account into the new one, using Meta's
//                              Migrate Message Templates API. Originals stay.
//
// Uses the System User token already saved in Vercel (WA_ACCESS_TOKEN); the
// token never leaves the server. Only the PMS admin (settings.adminEmail)
// can call it, with their Firebase sign-in.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const SOURCE_WABA = (process.env.WA_SOURCE_WABA_ID || "1274654317892802").trim(); // 7827168138
const DEST_WABA = (process.env.WA_DEST_WABA_ID || "1413283470522382").trim();     // 7827913595
const V = () => (process.env.WA_API_VERSION || "v25.0").trim();

function app() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set on the server");
    const sa = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(sa) });
  }
}

async function graph(path, opts = {}) {
  const tok = (process.env.WA_ACCESS_TOKEN || "").trim();
  const r = await fetch(`https://graph.facebook.com/${V()}/${path}`, {
    method: opts.method || "GET",
    headers: Object.assign({ Authorization: `Bearer ${tok}` }, opts.body ? { "Content-Type": "application/json" } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function templatesOf(waba) {
  const out = [];
  let next = `${waba}/message_templates?fields=name,status,category,language,quality_score&limit=100`;
  for (let i = 0; i < 10 && next; i++) {
    const r = await graph(next);
    if (!r.ok) return { error: (r.data.error && r.data.error.message) || ("HTTP " + r.status) };
    (r.data.data || []).forEach((t) => out.push({ id: t.id, name: t.name, status: t.status, category: t.category, language: t.language, quality: t.quality_score && t.quality_score.score }));
    const after = r.data.paging && r.data.paging.cursors && r.data.paging.next ? r.data.paging.cursors.after : null;
    next = after ? `${waba}/message_templates?fields=name,status,category,language,quality_score&limit=100&after=${after}` : null;
  }
  return { templates: out };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.WA_ACCESS_TOKEN) return res.status(503).json({ error: "WA_ACCESS_TOKEN is not set in Vercel" });

  // Signed-in PMS admin only.
  const authz = req.headers.authorization || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!idToken) return res.status(401).json({ error: "Sign in first" });
  let email = "";
  try {
    app();
    const decoded = await getAuth().verifyIdToken(idToken);
    email = String(decoded.email || "").toLowerCase();
    const snap = await getFirestore().collection("settings").limit(5).get();
    let adminEmail = "";
    snap.forEach((d) => { const s = d.data(); if (!adminEmail && s.adminEmail) adminEmail = String(s.adminEmail).toLowerCase(); });
    if (adminEmail && adminEmail !== email) return res.status(403).json({ error: "Only the PMS admin can do this" });
  } catch (e) {
    return res.status(401).json({ error: "Session couldn't be verified: " + (e.message || e) });
  }

  const { action } = req.body || {};
  try {
    if (action === "info") {
      const fields = "id,display_phone_number,verified_name,quality_rating,status,platform_type,code_verification_status";
      const [sp, dp, st, dt] = await Promise.all([
        graph(`${SOURCE_WABA}/phone_numbers?fields=${fields}`),
        graph(`${DEST_WABA}/phone_numbers?fields=${fields}`),
        templatesOf(SOURCE_WABA),
        templatesOf(DEST_WABA),
      ]);
      const pick = (r) => (r.ok ? r.data.data : { error: (r.data.error && r.data.error.message) || ("HTTP " + r.status) });
      return res.status(200).json({
        source: { waba: SOURCE_WABA, phones: pick(sp), templates: st },
        dest: { waba: DEST_WABA, phones: pick(dp), templates: dt },
      });
    }
    if (action === "apps") {
      const [me, subs] = await Promise.all([graph("app?fields=id,name"), graph(`${DEST_WABA}/subscribed_apps`)]);
      return res.status(200).json({ tokenApp: me.data, subscribed: subs.ok ? subs.data.data : subs.data });
    }
    if (action === "subscribe") {
      const me = await graph("app?fields=id,name");
      const want = (process.env.HTB_APP_ID || "1669239164868137").trim();
      if (!me.ok || me.data.id !== want) return res.status(400).json({ error: "The saved WhatsApp token belongs to " + ((me.data && me.data.name) || "another app") + ", not HTD PMS Messaging", tokenApp: me.data });
      const r = await graph(`${DEST_WABA}/subscribed_apps`, { method: "POST" });
      const subs = await graph(`${DEST_WABA}/subscribed_apps`);
      return res.status(r.ok ? 200 : 400).json({ ok: r.ok, result: r.data, subscribed: subs.data && subs.data.data });
    }
    if (action === "migrate_templates") {
      const r = await graph(`${DEST_WABA}/migrate_message_templates`, { method: "POST", body: { source_waba_id: SOURCE_WABA, page_number: 0 } });
      return res.status(r.ok ? 200 : 400).json({ ok: r.ok, result: r.data });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
