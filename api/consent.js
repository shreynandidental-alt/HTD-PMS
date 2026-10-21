// Online consent signing for patients (consent.html).
//
//   GET  /api/consent?t=<token>  -> the form to show (status, text, patient, clinic)
//   POST /api/consent            -> {t, signerName, signatureDataUrl}; signs it once
//
// The form lives in Firestore publicConsents/<token>, created by the PMS when
// staff tap "Send to Patient to Sign". This server reads/writes it with the
// Firebase admin key, so no public Firestore rule is needed. A form can only
// go from "pending" to "signed" once; the PMS then files it into the
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
const PUBLIC_FIELDS = ["status", "name", "body", "patientName", "ageGender", "mobile", "clinicName", "clinicAddress", "clinicPhone", "clinicLogo", "signedAt"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const t = String((req.query && req.query.t) || "");
      if (!TOKEN_RE.test(t)) return res.status(400).json({ error: "invalid" });
      const snap = await (await db()).collection("publicConsents").doc(t).get();
      if (!snap.exists) return res.status(404).json({ error: "not_found" });
      const d = snap.data(), out = {};
      for (const k of PUBLIC_FIELDS) if (d[k] !== undefined) out[k] = d[k];
      return res.status(200).json(out);
    }
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

    const fs = await db();
    const ref = fs.collection("publicConsents").doc(t);
    const signedAt = new Date().toISOString();
    const result = await fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { code: 404, error: "We couldn't find this consent form." };
      if (snap.data().status !== "pending") return { code: 409, error: "This consent form has already been signed." };
      tx.update(ref, {
        status: "signed", signatureDataUrl: sig, signedAt, signerName,
        signerAgent: String(req.headers["user-agent"] || "").slice(0, 300)
      });
      return { code: 200 };
    });
    if (result.code !== 200) return res.status(result.code).json({ error: result.error });
    return res.status(200).json({ success: true, signedAt });
  } catch (err) {
    console.error("[consent] " + (err && err.stack ? err.stack : err));
    const quota = /RESOURCE_EXHAUSTED|quota/i.test(String(err && err.message));
    return res.status(500).json({ error: quota ? "The clinic's system is busy right now. Please try again in a little while." : "Something went wrong. Please try again." });
  }
}
