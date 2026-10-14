// AI features for the PMS, powered by Claude (Anthropic API).
//
// The PMS calls THIS endpoint (/api/ai), never Anthropic directly, so the
// API key stays on the server. Every request must carry the signed-in
// staff member's Firebase ID token — the token is verified here, so nobody
// outside the clinic can use (and run up costs on) the clinic's AI key.
//
// SETUP (one-time):
//   1. Get an API key at https://console.anthropic.com  (Settings -> API Keys)
//   2. Vercel -> Project -> Settings -> Environment Variables:
//        ANTHROPIC_API_KEY = <the key>
//      (FIREBASE_SERVICE_ACCOUNT, already added for the 9 AM reminders, is
//       reused here to check who is signed in.)
//      Optional: ANTHROPIC_MODEL to use a different model.
//   3. Redeploy.
//
// The prompts live here (not in the browser) so they can't be tampered with.
// Every task asks Claude for JSON back, which the PMS shows for the doctor to
// review before anything is saved or sent.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

function adminAuth() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set on the server");
    const sa = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(sa) });
  }
  return getAuth();
}

const CLINIC = "Healing Touch Dental (Gurgaon, India) and its kids' wing Bubbles Dental";
const JSON_ONLY = "Reply with ONLY a single JSON object, no markdown fences, no text before or after it.";

const TASKS = {
  clinical_notes: {
    max: 1500,
    system: `You are a clinical documentation assistant for dentists at ${CLINIC}. Turn the dentist's shorthand or dictated notes into clean, professional dental case notes.
Rules:
- Use only findings the dentist actually stated. Never invent findings, test results or diagnoses. If something is implied (e.g. "TOP+" means tender on percussion), expand it correctly.
- Use FDI two-digit tooth numbering. Use standard dental terminology (e.g. "Symptomatic irreversible pulpitis with symptomatic apical periodontitis" only if supported by the findings).
- Keep each field concise; separate multiple items with commas or short sentences.
- Leave a field as an empty string if the notes say nothing about it.
${JSON_ONLY}
Shape: {"chiefComplaint":"","observations":"","diagnosis":"","investigations":"","treatmentAdvised":"","notes":""}`,
    user: (i) => `Patient: ${JSON.stringify(i.patient || {})}\n\nDentist's notes:\n${i.text || ""}`
  },

  patient_summary: {
    max: 1800,
    system: `You are a clinical assistant at ${CLINIC}. Summarise a patient's record for the dentist before or during a visit.
Rules:
- Only use the data provided. Do not invent anything. If data is missing, don't mention it.
- Lead with anything safety-critical (medical alerts, allergies, current medications).
- Then: treatment history (what was done, which teeth, when), pending/ongoing work, upcoming appointments, outstanding balance, follow-ups due, lab cases in progress.
- Short bullet points, dentist-friendly, use FDI tooth numbers and dates as given. Amounts in the currency given.
${JSON_ONLY}
Shape: {"headline":"one line about the patient","alerts":["..."],"sections":[{"title":"...","points":["..."]}],"nextSteps":["suggested next steps for the clinic, based only on the data"]}`,
    user: (i) => `Patient record (JSON):\n${JSON.stringify(i.data || {})}`
  },

  rewrite_message: {
    max: 1200,
    system: `You rewrite messages that ${CLINIC} sends to patients on WhatsApp, SMS or email.
Rules:
- Keep every fact exactly: names, dates, times, amounts, tooth numbers, phone numbers, links and addresses must stay unchanged.
- Don't add new promises, prices, offers or medical claims.
- Style requested:
  friendly = warm, caring, professional; short sentences; at most one or two fitting emojis.
  short = as brief as possible while keeping all facts.
  formal = polite and professional.
  hindi = natural, simple Hindi in Devanagari script (keep names, numbers, links in English).
  hinglish = natural Hindi written in English (Roman) letters, as commonly used on WhatsApp in India.
  fix = only correct spelling and grammar; keep the wording otherwise.
${JSON_ONLY}
Shape: {"text":"the rewritten message"}`,
    user: (i) => `Style: ${i.style || "friendly"}\n\nMessage:\n${i.text || ""}`
  },

  plan_explainer: {
    max: 1600,
    system: `You explain dental treatment plans to patients (or parents) of ${CLINIC} in plain, reassuring, accurate language.
Rules:
- For each treatment: what it is, why it is needed (based on the diagnosis given, if any), roughly how many visits it usually takes, and what to expect. Keep it simple — no jargon, or explain it.
- Don't invent diagnoses, prices, guarantees or success rates. Don't mention prices at all (the plan already lists them).
- If the patient is a child, address the parent and keep the tone gentle.
- About 120–250 words. Short paragraphs or simple bullets using "•". No markdown headings, no asterisks.
- Write in the requested language (english, hindi = Devanagari, hinglish = Hindi in Roman letters).
${JSON_ONLY}
Shape: {"text":"the explanation"}`,
    user: (i) => `Language: ${i.language || "english"}\nPatient: ${JSON.stringify(i.patient || {})}\nTreatment plan items: ${JSON.stringify(i.items || [])}`
  },

  rx_check: {
    max: 2500,
    system: `You are a clinical pharmacology decision-support assistant for dentists at ${CLINIC} (India). Review a dental prescription against the patient's details.
Check for:
1. Allergies and cross-reactivity (e.g. penicillin allergy vs amoxicillin/amox-clav; cephalosporin cross-reactivity; NSAID/aspirin sensitivity).
2. Drug–drug interactions between the prescribed medicines AND with the patient's current medications (e.g. NSAIDs with anticoagulants/antiplatelets/ACE inhibitors/methotrexate/lithium; metronidazole with warfarin or alcohol; macrolides/azoles with statins etc.; duplicate NSAIDs or duplicate paracetamol).
3. Drug–condition issues from the medical history/alerts (pregnancy/lactation, asthma with NSAIDs, peptic ulcer, kidney/liver disease, diabetes, hypertension, bleeding disorders, G6PD, epilepsy, etc.).
4. Dose, frequency and duration problems for the patient's age/weight; adult-only drugs or strengths given to children.
5. Pediatric dosing: if the patient is under 18, OR a weight is given and the patient is under 14, calculate the weight-based dose for EACH medicine using standard pediatric references (mg/kg/dose and mg/kg/day), state the calculation, the maximum daily dose, and a practical measure for the form (e.g. ml of a 250 mg/5 ml suspension). If no weight is given for a child, say the weight is needed and give the usual age-band dose with that caveat.
Rules:
- Be specific and practical. Don't pad with generic warnings; only list real, relevant issues. If nothing is wrong, say so.
- severity: "high" (avoid / change now), "moderate" (adjust or monitor), "low" (minor note).
- This is decision support for a qualified dentist; the dentist makes the final decision.
${JSON_ONLY}
Shape: {"overall":"ok|caution|danger","summary":"one or two sentences","issues":[{"severity":"high|moderate|low","medicine":"","problem":"","suggestion":""}],"pediatric":[{"index":0,"medicine":"","recommendedDose":"e.g. 250 mg (5 ml of 250mg/5ml) three times a day","calculation":"e.g. 15 mg/kg × 18 kg = 270 mg","maxDaily":""}]}
(The "index" in pediatric is the position of the medicine in the list provided, starting at 0. Leave "pediatric" empty for adults.)`,
    user: (i) => `Patient: ${JSON.stringify(i.patient || {})}\n\nPrescribed medicines (in order, index starting at 0):\n${JSON.stringify(i.medicines || [])}`
  },

  op_instructions: {
    max: 1400,
    system: `You write ${"pre-operative or post-operative"} instructions for patients of ${CLINIC}, to be sent on WhatsApp and printed.
Rules:
- Specific to the procedure given (e.g. root canal treatment, extraction, wisdom tooth surgery, dental implant, scaling, crown/bridge, fillings, braces/aligners, pulpotomy, sedation / laughing gas for children, bone graft, gum surgery).
- Practical, evidence-based, standard dental advice: what to do, what to avoid, eating/drinking, oral hygiene, pain and swelling, bleeding, medicines (refer to "the medicines prescribed by your dentist" — never name drugs or doses), and clear "call the clinic immediately if…" warning signs.
- For sedation / children, address the parent and include fasting, supervision and recovery guidance as appropriate.
- 8 to 12 short points, one per line, each under 120 characters, no numbering symbols other than the text itself, no markdown, no emojis.
- Write in the requested language (english, hindi = Devanagari, hinglish = Hindi in Roman letters).
- Take the patient's details into account if relevant (e.g. diabetic → slower healing, watch for infection; on blood thinners → bleeding advice).
${JSON_ONLY}
Shape: {"title":"short procedure name","instructions":["point 1","point 2"]}`,
    user: (i) => `Type: ${i.type === "pre" ? "PRE-operative (before the procedure)" : "POST-operative (after the procedure)"}\nProcedure: ${i.procedure || ""}\nLanguage: ${i.language || "english"}\nPatient: ${JSON.stringify(i.patient || {})}`
  }
};

function extractJson(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "AI isn't set up yet: add ANTHROPIC_API_KEY in Vercel -> Project -> Settings -> Environment Variables, then redeploy." });
  }

  // Only signed-in clinic staff may use the clinic's AI key.
  const authz = req.headers.authorization || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!idToken) return res.status(401).json({ error: "Please sign in again to use AI features." });
  try {
    await adminAuth().verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: "Your session couldn't be verified — please sign out and sign in again. (" + (err.message || "auth error") + ")" });
  }

  const { task, input } = req.body || {};
  const def = TASKS[task];
  if (!def) return res.status(400).json({ error: "Unknown AI task" });

  const userText = def.user(input || {});
  if (userText.length > 60000) return res.status(413).json({ error: "Too much data for one AI request" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: def.max,
        system: def.system,
        messages: [{ role: "user", content: userText }]
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ("AI request failed (HTTP " + r.status + ")");
      console.error("[ai] " + task + " failed: " + msg);
      return res.status(502).json({ error: msg });
    }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const result = extractJson(text);
    if (!result) return res.status(502).json({ error: "The AI reply couldn't be read — please try again." });
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error("[ai] " + task + " crashed: " + (err && err.stack || err));
    return res.status(500).json({ error: (err && err.message) || "AI request failed" });
  }
}
