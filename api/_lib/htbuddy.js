// HT Buddy - the PMS's WhatsApp chat for 7827913595 (Meta Cloud API, direct).
// Shared helpers for api/wa-webhook.js (Meta -> PMS) and api/wa-inbox.js
// (PMS screen -> Meta). Conversations are stored in Firestore:
//   waThreads/{phone}   one row per patient number: name, last message,
//                       unread count, lastInboundAt (24-hour reply window)
//   waMessages/{wamid}  every message in or out (text, media id, status)
// Env (Vercel): WA_ACCESS_TOKEN (system user token, already set)
//               HTB_PHONE_ID (optional, default 1475794725608484 = 7827913595)
//               HTB_WABA_ID  (optional, default 1413283470522382)
//               WA_APP_SECRET (optional, checks Meta's webhook signature)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const HTB_PHONE_ID = () => (process.env.HTB_PHONE_ID || "1475794725608484").trim();
export const HTB_WABA_ID = () => (process.env.HTB_WABA_ID || "1413283470522382").trim();
const V = () => (process.env.WA_API_VERSION || "v25.0").trim();

export function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set on the server");
    const sa = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}
export { FieldValue };

export async function verifyStaff(req) {
  const authz = req.headers.authorization || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!idToken) throw Object.assign(new Error("Please sign in again"), { status: 401 });
  db();
  try {
    const d = await getAuth().verifyIdToken(idToken);
    return { email: String(d.email || "").toLowerCase(), uid: d.uid };
  } catch (e) {
    throw Object.assign(new Error("Session couldn't be verified - sign out and in again"), { status: 401 });
  }
}

export async function graph(path, opts = {}) {
  const tok = (process.env.WA_ACCESS_TOKEN || "").trim();
  const r = await fetch(path.startsWith("http") ? path : `https://graph.facebook.com/${V()}/${path}`, {
    method: opts.method || "GET",
    headers: Object.assign({ Authorization: `Bearer ${tok}` }, opts.body ? { "Content-Type": "application/json" } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.raw) return r;
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Indian numbers -> 91XXXXXXXXXX; anything else keeps its digits.
export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) d = "91" + d;
  if (d.length === 11 && d.startsWith("0")) d = "91" + d.slice(1);
  return d;
}
export const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

// Find a PMS patient for this number (only when a thread is first created).
export async function matchPatient(phone) {
  const want = last10(phone);
  if (want.length !== 10) return null;
  const snap = await db().collection("patients").select("name", "mobile", "whatsappNumber", "status").get();
  let hit = null;
  snap.forEach((doc) => {
    if (hit) return;
    const p = doc.data();
    if (p.status === "Archived") return;
    if (last10(p.mobile) === want || last10(p.whatsappNumber) === want) hit = { id: doc.id, name: p.name || "" };
  });
  return hit;
}

export function previewOf(m) {
  if (m.text) return String(m.text).slice(0, 120);
  if (m.type === "image") return "📷 Photo" + (m.caption ? ": " + m.caption.slice(0, 80) : "");
  if (m.type === "document") return "📄 " + (m.filename || "Document");
  if (m.type === "audio") return "🎤 Voice note";
  if (m.type === "video") return "🎬 Video";
  if (m.type === "sticker") return "Sticker";
  if (m.type === "location") return "📍 Location";
  if (m.type === "template") return "📋 " + (m.template || "Template");
  return m.type || "Message";
}

// Save one message and update its thread.
export async function saveMessage(m) {
  const fs = db();
  const phone = normPhone(m.phone);
  const id = m.id || ("local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  const doc = Object.assign({}, m, { id, phone, savedAt: new Date().toISOString() });
  Object.keys(doc).forEach((k) => doc[k] === undefined && delete doc[k]);
  await fs.collection("waMessages").doc(id).set(doc, { merge: true });

  const tRef = fs.collection("waThreads").doc(phone);
  const tSnap = await tRef.get();
  const t = tSnap.exists ? tSnap.data() : { phone, createdAt: doc.ts, unread: 0 };
  if (!tSnap.exists || !t.patientId) {
    const p = await matchPatient(phone).catch(() => null);
    if (p) { t.patientId = p.id; t.patientName = p.name; }
  }
  if (m.profileName) t.profileName = m.profileName;
  if (!t.lastAt || doc.ts >= t.lastAt) { t.lastAt = doc.ts; t.lastPreview = previewOf(doc); t.lastDir = doc.dir; }
  if (doc.dir === "in") { t.unread = (t.unread || 0) + 1; t.lastInboundAt = doc.ts; }
  t.phone = phone;
  await tRef.set(t, { merge: true });
  return doc;
}
