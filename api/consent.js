// Online consent signing for patients (consent.html).
//
//   POST /api/consent  {t, signerName, signatureDataUrl}
//
// The form itself is published by the PMS in publicReceipts/<token>
// (docType "consent"), which the patient's phone reads directly. This
// endpoint only records the signature, once, in consentSubmissions/<token>
// using the Firebase admin key (a "create" that fails if it already exists,
// so a form can't be signed twice). The PMS then files it into the
// patient's Files -> Consent Forms.

let FA = null;
async function db() {
  if (FA) return FA;
  const [app, fs] = await Promise.all([import("firebase-admin/app"), import("firebase-admin/firestore")]);
  if (!app.getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    const sa = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    app.initializeApp({ credential: app.cert(sa) });
  }
  FA = fs.getFirestore();
  return FA;
}

const TOKEN_RE = /^[a-f0-9]{16,64}$/i;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const t = String(body.t || "");
    const signerName = String(body.signerName || "").trim().slice(0, 120);
    const sig = String(body.signatureDataUrl || "");
    if (!TOKEN_RE.test(t)) return res.status(400).json({ error: "This link isn't valid." });
    if (signerName.length < 2) return res.status(400).json({ error: "Please enter your full name." });
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 500000) {
      return res.status(400).json({ error: "The signature couldn't be read. Please clear it and sign again." });
    }
    const signedAt = new Date().toISOString();
    try {
      await (await db()).collection("consentSubmissions").doc(t).create({
        id: t, status: "new", signatureDataUrl: sig, signerName, signedAt,
        signerAgent: String(req.headers["user-agent"] || "").slice(0, 300)
      });
    } catch (e) {
      if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) {
        return res.status(409).json({ error: "This consent form has already been signed." });
      }
      throw e;
    }
    return res.status(200).json({ success: true, signedAt });
  } catch (err) {
    console.error("[consent] " + (err && err.stack ? err.stack : err));
    const quota = /RESOURCE_EXHAUSTED|quota/i.test(String(err && err.message));
    return res.status(500).json({ error: quota ? "The clinic's system is busy right now. Please try again in a little while." : "Something went wrong. Please try again." });
  }
}
