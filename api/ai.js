// AI features for the PMS. Two providers:
//   - Cloudflare Workers AI (free daily allowance, open models)
//   - Claude (Anthropic API, paid)
// Admin -> AI Provider in the PMS chooses: Cloudflare, Claude, or Mix
// (clinical tasks on Claude, everyday writing on Cloudflare).
//
// Cloudflare setup: Vercel -> Settings -> Environment Variables:
//   CF_AI_TOKEN   = a Cloudflare API token with "Workers AI" permission
//   CF_ACCOUNT_ID = (optional) Cloudflare account ID; defaults to the clinic's
//   CF_AI_MODEL   = (optional) model, default @cf/openai/gpt-oss-120b
// After adding or changing a variable, the site must be deployed again
// (any new commit does it) before the server can see it.
// Last token update: 2 Nov 2026 (10:56).
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
const CF_ACCOUNT = (process.env.CF_ACCOUNT_ID || "5c5dd2eef8759859f9d6c007d0212e1b").trim();
const CF_MODEL = (process.env.CF_AI_MODEL || "@cf/openai/gpt-oss-120b").trim();
// Tolerates a token pasted with spaces, quotes or a "Bearer " prefix.
const cfToken = () => String(process.env.CF_AI_TOKEN || "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
const cfReady = () => !!(cfToken() && CF_ACCOUNT);
const claudeReady = () => !!process.env.ANTHROPIC_API_KEY;
// Tasks where accuracy matters most go to Claude in "mix" mode.
const CLINICAL_TASKS = new Set(["clinical_notes", "patient_summary", "rx_check"]);

function pickProvider(requested, task) {
  const cf = cfReady(), cl = claudeReady();
  let want;
  if (requested === "claude") want = "claude";
  else if (requested === "cloudflare") want = "cloudflare";
  else if (requested === "mix") want = CLINICAL_TASKS.has(task) ? "claude" : "cloudflare";
  else want = cf ? "cloudflare" : "claude"; // auto
  if (want === "cloudflare" && !cf) want = cl ? "claude" : null;
  if (want === "claude" && !cl) want = cf ? "cloudflare" : null;
  return want;
}

async function runClaude(def, userText) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: def.max, system: def.system, messages: [{ role: "user", content: userText }] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((data && data.error && data.error.message) || ("Claude request failed (HTTP " + r.status + ")")), { status: 502 });
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

async function runCloudflare(def, userText) {
  const r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT + "/ai/run/" + CF_MODEL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + cfToken(), "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "system", content: def.system }, { role: "user", content: userText }],
      // reasoning models think before answering, so allow extra room
      max_tokens: Math.max(def.max * 2, 2048)
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    const e = (data.errors && data.errors[0]) || {};
    let msg = e.message || ("Cloudflare AI request failed (HTTP " + r.status + ")");
    if (r.status === 429 || /neuron|daily|limit|quota|capacity/i.test(msg)) msg = "Today's free Cloudflare AI allowance is used up (or the service is busy). Try again later, or switch Admin → AI Provider to Claude.";
    else if (r.status === 401 || r.status === 403 || e.code === 10000) {
      // Safe diagnostics only: never the token itself, just its shape.
      const t = cfToken();
      let verify = "?";
      try { const v = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { "Authorization": "Bearer " + t } }).then(x => x.json()); verify = v && v.success ? ((v.result && v.result.status) || "valid") : "not recognised by Cloudflare"; } catch (_) {}
      msg = "Cloudflare refused the AI token (" + (e.code ? e.code + ": " : "") + (e.message || "HTTP " + r.status) + "). The saved CF_AI_TOKEN is " + t.length + " characters" + (/^[A-Za-z0-9_\-]+$/.test(t) ? "" : " and contains spaces or unusual characters") + "; Cloudflare says the token is: " + verify + ". It should be the ~40-character value shown once after Create/Roll.";
    }
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const res = data.result || {};
  if (typeof res.response === "string") return res.response;
  if (res.response && typeof res.response === "object") return JSON.stringify(res.response);
  const ch = res.choices && res.choices[0] && res.choices[0].message;
  return (ch && ch.content) || "";
}

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

// ---- AI Skills (Assist → AI Skills) ----
// Figures (risk scores, forecasts, segments, stock run-outs, peak hours) are
// calculated in the PMS from the clinic's own data; these skills only read
// those figures and turn them into insights, actions, drafts and documents.
const INSIGHT_SKILLS = {
  no_show: "You are a no-show prevention adviser. The data lists upcoming appointments with a risk score (0-100) the PMS calculated from each patient's own history (past no-shows, cancellations, lead time, gap since last visit, new vs returning). Explain the pattern and give concrete steps (who to call, who needs an extra reminder, which slots to double-book or keep a waitlist for).",
  cashflow: "You are a cash-flow forecaster for a dental clinic. The data has the last 90 days of daily collections, weekday averages, the PMS's 30-day projection, scheduled appointments and outstanding invoices. Comment on the trend, the weeks likely to fall below 70% of average, and practical ways to protect cash flow (collections follow-up, EMI, filling quiet days). Amounts are in Indian Rupees.",
  inventory: "You are a dental clinic inventory adviser. The data lists each stock item with current stock, average daily use, days until it runs out, and the PMS's suggested order quantity (≈60 days of use). Flag what must be ordered now, what is over-stocked, and any odd usage patterns. Be conservative; don't over-order.",
  segmentation: "You are a patient-retention adviser. The PMS ran an RFM analysis (recency, frequency, monetary) and grouped patients into VIP, Loyal, Regular, New, At-risk (3-6 months since last visit) and Churning (6+ months). Give specific, practical retention actions for each segment suitable for an Indian dental clinic (recall calls, WhatsApp check-ups, family offers, 6-monthly cleaning reminders). Don't invent numbers.",
  pricing: "You are a demand-based pricing adviser for a dental clinic in Gurgaon, India. The data has appointment counts by weekday and hour, doctor workloads and treatment demand. Suggest off-peak offers to fill quiet slots and where demand supports premium/priority slots, with a short rationale. Keep it ethical: never suggest raising prices for emergencies or pain relief.",
  lab: "You are a dental lab coordinator. The data has per-lab statistics (cases, average turnaround days, late deliveries vs promised date, remakes/corrections) and the cases currently overdue. Recommend which lab suits which work, what to chase today, and how to avoid delays for patients.",
  billing: "You are a billing and collections adviser for a dental clinic in India. The data lists patients with outstanding balances and how many days overdue, grouped into reminder stages (3 days friendly reminder, 7 days payment link + WhatsApp, 14 days staff call, 21+ days escalate to doctor). Give a prioritised, polite collection plan. Never suggest threatening language."
};

const SKILL_TASKS = {
  skill_insights: {
    max: 1800,
    system: `You are an analytics assistant inside the practice management system of ${CLINIC}.
Use ONLY the numbers in the data provided; never invent figures. Be specific, practical and brief.
${JSON_ONLY}
Shape: {"headline":"one-line takeaway","insights":["3-6 short observations citing the data"],"actions":["3-6 concrete actions, most important first"]}`,
    user: (i) => `Skill: ${INSIGHT_SKILLS[i.skill] || i.skill}\n\nData (JSON):\n${JSON.stringify(i.data || {})}`
  },

  treatment_advisor: {
    max: 2200,
    system: `You assist dentists with treatment planning at ${CLINIC}.
Given a patient's details, diagnosis/findings and affected teeth (FDI numbering), suggest a logical, correctly sequenced treatment plan (e.g. extraction before bridge, RCT before crown, scaling before restorative, perio before prosthetics).
- Estimate cost per step ONLY from the clinic price list provided (match by treatment name); if not in the list, leave estCost 0.
- Flag contraindications from the medical history: allergies, diabetes before surgery (HbA1c), pregnancy for X-rays, anticoagulants before extractions (INR), cardiac conditions, bisphosphonates before extractions/implants.
- Offer alternatives where sensible (e.g. implant vs bridge vs RPD).
- Never give a definitive diagnosis or prescribe drugs; this is decision support for the treating dentist.
- patientSummary: 80-150 words, plain language, for the patient.
${JSON_ONLY}
Shape: {"plan":[{"step":1,"treatment":"","teeth":"","visits":"","estCost":0,"why":""}],"totalEstimate":0,"alternatives":[""],"warnings":[""],"patientSummary":""}`,
    user: (i) => `Patient: ${JSON.stringify(i.patient || {})}\nDiagnosis / findings: ${i.diagnosis || ""}\nTeeth: ${i.teeth || ""}\nDentist's notes: ${i.notes || ""}\nClinic price list: ${JSON.stringify(i.prices || [])}`
  },

  smart_scheduler: {
    max: 1200,
    system: `You book appointments for ${CLINIC}. The PMS gives you the request in plain words (English/Hindi/Hinglish), today's date, and the list of FREE slots (already checked: no double-booking, inside clinic hours).
Pick the 3 best slots that match the request (day, part of day: morning 10:30-13:00, afternoon 13:00-17:00, evening 17:00-20:00; "urgent" = earliest; preferred doctor/clinic if mentioned). Only choose slots from the list, copying date, time, doctor and clinic exactly.
${JSON_ONLY}
Shape: {"understood":"what you understood from the request","options":[{"date":"YYYY-MM-DD","time":"HH:MM","doctor":"","clinic":"","why":""}]}`,
    user: (i) => `Today: ${i.today}\nRequest: ${i.request || ""}\nTreatment: ${i.treatment || ""}\nFree slots: ${JSON.stringify(i.slots || [])}`
  },

  claim_analyzer: {
    max: 2200,
    system: `You are an insurance claim adviser for ${CLINIC} (India: Star Health, HDFC Ergo, Niva Bupa, ICICI Lombard, CGHS, TPAs, etc.). Analyse the claim (pending, rejected or partly paid) and help the clinic recover it.
${JSON_ONLY}
Shape: {"analysis":{"likelyCause":"","category":"CODING|DOCUMENTATION|ELIGIBILITY|MEDICAL_NECESSITY|TIMELY_FILING|DUPLICATE|OTHER","outlook":"RECOVERABLE|PARTIAL|UNLIKELY"},"documentsNeeded":[""],"suggestions":[{"action":"","priority":"HIGH|MEDIUM|LOW"}],"appealLetter":"full professional letter, or empty string if not worth appealing","preventionTips":[""]}`,
    user: (i) => `Claim: ${JSON.stringify(i.claim || {})}\nPatient: ${JSON.stringify(i.patient || {})}\nExtra notes from clinic: ${i.notes || ""}`
  },

  consent_generator: {
    max: 2600,
    system: `You write dental procedure consent forms for ${CLINIC}, in simple language suited to Indian patients (and parents, for children).
Be thorough but not alarming; include common and rare-but-serious risks specific to the procedure; include "doing nothing" as an alternative.
Write in the requested language (english, hindi = Devanagari, hinglish = Hindi in Roman letters).
${JSON_ONLY}
Shape: {"title":"","procedureDescription":"2-3 short paragraphs","benefits":[""],"risks":[""],"alternatives":[""],"anesthesia":"","duration":"","postOpInstructions":[""],"acknowledgements":["I understand ...","I have had the chance to ask questions ..."]}`,
    user: (i) => `Procedure: ${i.procedure || ""}\nTeeth: ${i.teeth || ""}\nLanguage: ${i.language || "english"}\nPatient: ${JSON.stringify(i.patient || {})}`
  },

  clinic_analyst: {
    max: 1600,
    system: `You are the business analyst for ${CLINIC}. Answer the owner's question using ONLY the clinic data provided (monthly figures, doctor-wise and treatment-wise breakdowns, appointment and patient counts). State the period you used, compare with previous periods where useful, and end with the single most important action. Amounts in Indian Rupees (₹, Indian digit grouping). If the data can't answer the question, say what's missing.
${JSON_ONLY}
Shape: {"answer":"short paragraph(s)","keyNumbers":[{"label":"","value":""}],"topAction":""}`,
    user: (i) => `Question: ${i.question || ""}\n\nClinic data (JSON):\n${JSON.stringify(i.data || {})}`
  },

  patient_intake: {
    max: 1800,
    system: `You are an intake assistant at ${CLINIC}. The receptionist pastes a new patient's details and answers (any order, English/Hindi/Hinglish, maybe a WhatsApp message or a filled paper form). Extract them into structured fields and score medical risk.
Risk score guide (add up, cap at 100): drug allergy +15; diabetes uncontrolled +20 / controlled +10; hypertension +10; heart disease +15; hepatitis +10; HIV +10; epilepsy +15; pregnancy +20; bleeding disorder or blood thinners +20; heavy smoking/alcohol +10. 0-30 low, 31-60 moderate (doctor review), 61-100 high (review before any treatment).
Only use what's written; leave unknown fields empty. Mobile numbers: 10 digits, no country code.
${JSON_ONLY}
Shape: {"patient":{"name":"","gender":"","age":"","dob":"YYYY-MM-DD or empty","mobile":"","email":"","address":"","emergencyContact":"","chiefComplaint":""},"medical":{"conditions":[""],"medications":[""],"allergies":[""],"pregnant":"yes|no|unknown","habits":[""]},"riskScore":0,"riskLevel":"low|moderate|high","flags":["things the dentist must see"],"missing":["important info not given"]}`,
    user: (i) => `Details given:\n${i.text || ""}`
  },

  wa_receptionist: {
    max: 1000,
    system: `You draft WhatsApp replies for the front desk of ${CLINIC} (Sector 45 Gurgaon: 10:30 AM-8 PM; Palam Vihar / Sector 23: 10:30 AM-7 PM; phone/WhatsApp 7827168138; kids' wing Bubbles Dental at Sector 45).
Reply in the patient's language and style (English, Hindi or Hinglish), warm and brief (under 70 words), at most one emoji. Never quote prices, diagnoses or guarantees unless given in the clinic info; for pain/swelling/bleeding/trauma advise coming in or calling. Offer to book when relevant.
${JSON_ONLY}
Shape: {"intent":"booking|reschedule|cancel|pricing|emergency|report_or_records|feedback|other","reply":"","suggestedAction":"what the staff should do next"}`,
    user: (i) => `Patient message:\n${i.message || ""}\n\nPatient (if known): ${JSON.stringify(i.patient || {})}\nUpcoming appointment (if any): ${JSON.stringify(i.appointment || null)}\nClinic info / notes: ${i.info || ""}`
  }
};
Object.assign(TASKS, SKILL_TASKS);

function extractJson(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}

export default async function handler(req, res) {
  // GET: which providers are set up (no secrets returned).
  if (req.method === "GET") return res.status(200).json({ cloudflare: cfReady(), claude: claudeReady(), cloudflareModel: CF_MODEL, claudeModel: MODEL });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!cfReady() && !claudeReady()) {
    return res.status(500).json({ error: "AI isn't set up yet: add CF_AI_TOKEN (free Cloudflare Workers AI) or ANTHROPIC_API_KEY in Vercel -> Project -> Settings -> Environment Variables, then redeploy." });
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

  const { task, input, provider } = req.body || {};
  const def = TASKS[task];
  if (!def) return res.status(400).json({ error: "Unknown AI task" });

  const userText = def.user(input || {});
  if (userText.length > 60000) return res.status(413).json({ error: "Too much data for one AI request" });

  const use = pickProvider(String(provider || "auto"), task);
  if (!use) return res.status(500).json({ error: "The chosen AI provider isn't set up in Vercel." });
  try {
    const text = use === "cloudflare" ? await runCloudflare(def, userText) : await runClaude(def, userText);
    const result = extractJson(text);
    if (!result) return res.status(502).json({ error: "The AI reply couldn't be read — please try again." });
    return res.status(200).json({ success: true, result, provider: use, model: use === "cloudflare" ? CF_MODEL : MODEL });
  } catch (err) {
    console.error("[ai] " + task + " (" + use + ") failed: " + (err && err.message || err));
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: (err && err.message) || "AI request failed" });
  }
}
