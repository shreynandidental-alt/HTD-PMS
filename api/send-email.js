// Sends an email (optionally with PDF attachments) from the clinic's Gmail.
//
//   GET  /api/send-email  -> {configured, from}   (no login needed, sends nothing)
//   POST /api/send-email  -> {success} or {error}
//        headers: Authorization: Bearer <Firebase login token of a PMS user>
//        body:    {to, subject, text, attachments:[{filename, contentType, contentBase64}]}
//
// Only signed-in PMS users (the admin login or a login listed in Manage Users)
// can send, so nobody else can use the clinic's Gmail through this address.

import { emailConfigured, emailFrom, emailNotConfiguredError, sendEmail } from "./_lib/email.js";

let FA = null;
async function admin() {
  if (FA) return FA;
  const [app, fs, auth] = await Promise.all([
    import("firebase-admin/app"), import("firebase-admin/firestore"), import("firebase-admin/auth")
  ]);
  if (!app.getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    const sa = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    app.initializeApp({ credential: app.cert(sa) });
  }
  FA = { db: fs.getFirestore(), auth: auth.getAuth() };
  return FA;
}

async function authorize(req) {
  const authz = req.headers.authorization || "";
  if (!authz.startsWith("Bearer ")) return { ok: false, why: "Please sign in to the PMS first." };
  const { db, auth } = await admin();
  let decoded;
  try { decoded = await auth.verifyIdToken(authz.slice(7)); }
  catch (e) { return { ok: false, why: "Your login has expired. Please refresh the PMS and try again." }; }
  const email = String(decoded.email || "").toLowerCase();
  if (!email) return { ok: false, why: "This login has no email address." };
  const settings = await db.collection("settings").get();
  const adminEmail = settings.docs.map(d => d.data().adminEmail).find(Boolean);
  if (!adminEmail || String(adminEmail).toLowerCase() === email) return { ok: true, email };
  const staff = await db.collection("staffUsers").get();
  if (staff.docs.some(d => String(d.data().email || "").toLowerCase() === email)) return { ok: true, email };
  return { ok: false, why: "This login isn't a PMS staff account." };
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const MAX_ATTACH_BYTES = 3.3 * 1024 * 1024; // Vercel accepts ~4.5 MB per request

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ configured: emailConfigured(), from: emailConfigured() ? emailFrom() : "" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!emailConfigured()) return res.status(500).json({ error: emailNotConfiguredError() });

    let who;
    try { who = await authorize(req); }
    catch (e) { return res.status(500).json({ error: "Login check failed on the server: " + e.message }); }
    if (!who.ok) return res.status(401).json({ error: who.why });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const to = String(body.to || "").trim();
    if (!EMAIL_RE.test(to)) return res.status(400).json({ error: "Enter one valid email address." });
    const subject = String(body.subject || "Healing Touch Dental").slice(0, 300);
    const text = String(body.text || "").slice(0, 20000);
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 5) : [];
    let bytes = 0;
    for (const a of attachments) {
      if (!a || typeof a.contentBase64 !== "string") return res.status(400).json({ error: "Attachment is missing its file." });
      bytes += Math.floor(a.contentBase64.length * 3 / 4);
      a.filename = String(a.filename || "document.pdf").replace(/[\\/:*?"<>|\r\n]+/g, "").slice(0, 120) || "document.pdf";
      a.contentType = /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType || "") ? a.contentType : "application/pdf";
    }
    if (bytes > MAX_ATTACH_BYTES) return res.status(413).json({ error: "The attachment is too large to email (over 3 MB)." });

    const result = await sendEmail({ to, subject, text, attachments, replyTo: emailFrom() });
    if (!result.success) return res.status(result.status || 500).json({ error: result.error });
    console.log("[send-email] sent to " + to.replace(/^(.).*(@.*)$/, "$1***$2") + " by " + who.email);
    return res.status(200).json({ success: true, id: result.id });
  } catch (err) {
    console.error("[send-email] crashed: " + (err && err.stack ? err.stack : err));
    if (!res.headersSent) return res.status(500).json({ error: "Email server error: " + (err && err.message ? err.message : String(err)) });
  }
}
