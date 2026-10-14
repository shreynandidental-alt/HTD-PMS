// Vercel Cron Job - runs automatically once a day (see vercel.json for the
// schedule) with NO browser or person needing to have the PMS open. This
// is what actually sends:
//   1. Appointment reminders - every patient with an appointment today
//   2. Birthday greetings - every patient whose date of birth is today
//   3. 6-month follow-ups - every patient whose last completed visit was
//      about 6 months ago (same ~172-193 day window, and the same
//      dedup records, as the existing manual "Biannual Checkup Reminder"
//      widget on Home - so the two never double-send to the same patient)
//   4. Case/procedure follow-ups due today - the "Next Follow-up Date" /
//      "Follow-up (Next Coating)" fields in the Aligner Case, Braces
//      Case, Fluoride Varnish, and every other clinical case form that
//      sets a follow-up date (Trauma, Space Maintainer, Pulp Therapy
//      Review, Caries Risk Recall, Endodontics, Oral Medicine, etc. all
//      use this same mechanism already) - sent on the exact date set,
//      without removing the existing "shows as a reminder 7 days before"
//      behavior on Home, which still works exactly as it did.
//
// Everything else in the PMS's WhatsApp features stays exactly as it was
// - manual, staff-triggered sends. This file only adds these three
// specific automated ones.
//
// REQUIRED SETUP (both are new, one-time steps):
// 1. CRON_SECRET - any random string you choose, added as a Vercel
//    environment variable. Vercel automatically sends this as a Bearer
//    token when it calls this endpoint on schedule - without it set
//    correctly, this function refuses to run at all, so nobody else who
//    finds this URL can trigger real messages to your patients.
// 2. FIREBASE_SERVICE_ACCOUNT - your Firebase project's service account
//    key (JSON), as a single-line string, added as a Vercel environment
//    variable. This is what lets this server-side function read your
//    Firestore data directly, without anyone's browser needing to be
//    open. Get it from Firebase Console -> Project Settings -> Service
//    Accounts -> Generate New Private Key - that downloads a JSON file;
//    paste its entire contents as the value of this variable.
//
// Both are documented step by step in the message Claude gave you
// alongside this file.

import { activeBackend, notConfiguredError, sendWhatsAppTemplate } from "./_lib/whatsapp.js";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function getDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    let serviceAccount;
    try {
      // Tolerates the value being pasted with surrounding quotes or
      // whitespace, which Vercel's env editor makes easy to do by accident.
      serviceAccount = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    } catch (e) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON - paste the entire contents of the downloaded key file, from the first { to the last } (" + e.message + ")");
    }
    // The private key's line breaks often arrive as literal "\n" text
    // rather than real newlines, which makes cert() reject the key.
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key - make sure it's the service account key file, not the web app config");
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

// Uses Intl.DateTimeFormat with an explicit Asia/Kolkata timezone to read
// the correct IST date components, rather than manual millisecond math -
// that approach only gives the right answer if the server process itself
// happens to be running in UTC, which Vercel currently does but doesn't
// contractually guarantee, so this is the more robust choice for
// something that decides who an automated WhatsApp message goes to.
const IST_PARTS_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
function istDateParts(d) {
  // en-CA formats as YYYY-MM-DD, parsed back into numbers.
  const [y, m, day] = IST_PARTS_FMT.format(d).split("-").map(Number);
  return { year: y, month: m, day };
}
function todayIST() {
  // A Date constructed FROM the IST calendar date (at UTC midnight) -
  // only its y/m/d parts are meaningful here, used for day-count maths
  // and for istDateParts() again elsewhere; never read its hours/minutes.
  const p = istDateParts(new Date());
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}
function dateKeyIST(d) {
  const p = istDateParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function formatDateLong(d) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" }).format(d);
}
function formatTime12h(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

async function getAllDocs(db, collectionName) {
  const snap = await db.collection(collectionName).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// WhatsApp rejects a template if any variable is empty.
function v(x) { const s = x == null ? "" : String(x).trim(); return s || "-"; }

// Claims a record before sending, inside a transaction, so that if the
// scheduled run and the PMS's back-up trigger ever run at the same moment,
// a patient still only gets ONE message.
async function claim(db, ref, sentField) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return false;
    const d = snap.data();
    if (d[sentField]) return false;
    const c = d[sentField + "Claim"];
    if (c && Date.now() - new Date(c).getTime() < 10 * 60 * 1000) return false;
    t.update(ref, { [sentField + "Claim"]: new Date().toISOString() });
    return true;
  });
}

async function verifyStaff(req) {
  const authz = req.headers.authorization || "";
  if (!authz.startsWith("Bearer ")) return false;
  const tok = authz.slice(7);
  if (process.env.CRON_SECRET && tok === process.env.CRON_SECRET) return "cron";
  try { getDb(); await getAuth().verifyIdToken(tok); return "app"; } catch (e) { return false; }
}

export default async function handler(req, res) {
  // Two callers are allowed:
  //  - Vercel's scheduler at 9 AM IST (sends CRON_SECRET), and
  //  - the PMS itself, as a back-up, when a signed-in staff member opens it
  //    and the 9 AM run hasn't happened (sends their Firebase login token).
  // Nobody else can trigger real messages to patients.
  let db;
  try { db = getDb(); } catch (err) {
    console.error("[cron-daily] ABORTED: Firebase Admin setup failed - " + err.message);
    return res.status(500).json({ error: "Firebase Admin setup failed: " + err.message });
  }
  const todayKey = dateKeyIST(new Date());
  const runRef = db.collection("cronRuns").doc(todayKey);
  const logRun = (data) => runRef.set({ istDate: todayKey, updatedAt: new Date().toISOString(), ...data }, { merge: true }).catch(() => {});

  const caller = await verifyStaff(req);
  if (!caller) {
    const why = !process.env.CRON_SECRET ? "CRON_SECRET is not set in Vercel" : (req.headers.authorization ? "wrong secret/login token" : "no authorization sent");
    console.error("[cron-daily] ABORTED: unauthorized (" + why + ")");
    if (!process.env.CRON_SECRET) await logRun({ status: "error", error: "CRON_SECRET is not set in Vercel environment variables" });
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!activeBackend()) {
    console.error("[cron-daily] ABORTED: WhatsApp is not configured.");
    await logRun({ status: "error", error: "WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID are not set in Vercel environment variables" });
    return res.status(500).json({ error: notConfiguredError() });
  }

  const summary = { appointmentReminders: { sent: 0, skipped: 0, failed: 0 }, birthdays: { sent: 0, skipped: 0, failed: 0 }, sixMonthFollowUps: { sent: 0, skipped: 0, failed: 0 }, caseFollowUps: { sent: 0, skipped: 0, failed: 0 }, errors: [] };
  await logRun({ status: "running", startedAt: new Date().toISOString(), trigger: caller, backend: activeBackend() });

  const today = todayIST();
  const todayParts = istDateParts(new Date());
  const patientCache = {};
  async function getPatient(id) {
    if (!id) return null;
    if (patientCache[id] !== undefined) return patientCache[id];
    try { const d = await db.collection("patients").doc(String(id)).get(); patientCache[id] = d.exists ? { id: d.id, ...d.data() } : null; }
    catch (e) { patientCache[id] = null; }
    return patientCache[id];
  }

  // ---------- 1. Appointment reminders - done FIRST and with a targeted
  // query (only today's appointments), so nothing else can slow it down or
  // stop it. ----------
  try {
    const snap = await db.collection("appointments").where("date", "==", todayKey).get();
    const allToday = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log("[cron-daily] IST " + todayKey + ": " + allToday.length + " appointments today");
    const due = allToday.filter(a => !["Cancelled", "NoShow", "Completed", "Reserved", "Rescheduled"].includes(a.status) && !a.reminderSentAt);
    for (const appt of due) {
      try {
        const patient = await getPatient(appt.patientId);
        const phone = (patient && (patient.whatsappNumber || patient.mobile)) || appt.patientMobile || appt.mobile;
        if (!phone) { summary.appointmentReminders.skipped++; continue; }
        const ref = db.collection("appointments").doc(appt.id);
        if (!(await claim(db, ref, "reminderSentAt"))) { summary.appointmentReminders.skipped++; continue; }
        const result = await sendWhatsAppTemplate({
          phoneNumber: phone,
          templateName: "appointment_reminder",
          bodyValues: [v(appt.patientName || (patient && patient.name)), v(formatDateLong(today)), v(formatTime12h(appt.startTime))]
        });
        if (result.success) {
          await ref.update({ reminderSentAt: new Date().toISOString(), reminderSentBy: "auto-9am" });
          summary.appointmentReminders.sent++;
        } else {
          await ref.update({ reminderSentAtClaim: null }).catch(() => {});
          summary.appointmentReminders.failed++;
          summary.errors.push("Appointment reminder for " + (appt.patientName || appt.id) + ": " + result.error);
        }
      } catch (e) {
        summary.appointmentReminders.failed++;
        summary.errors.push("Appointment reminder for " + (appt.patientName || appt.id) + ": " + e.message);
      }
    }
  } catch (err) {
    summary.errors.push("Appointment reminders crashed: " + err.message);
    console.error("[cron-daily] appointment reminders crashed: " + (err.stack || err));
  }
  await logRun({ remindersDoneAt: new Date().toISOString(), summary });

  // ---------- 4. Case/procedure follow-ups due today ----------
  try {
    const allReminders = await getAllDocs(db, "reminders");
    const dueFollowUps = allReminders.filter(r =>
      r.followupDate && r.patientId && r.status === "Pending" &&
      dateKeyIST(new Date(r.followupDate)) === todayKey && !r.autoFollowUpSentAt
    );
    for (const rem of dueFollowUps) {
      const patient = await getPatient(rem.patientId);
      const phone = patient && (patient.whatsappNumber || patient.mobile);
      if (!phone) { summary.caseFollowUps.skipped++; continue; }
      const ref = db.collection("reminders").doc(rem.id);
      if (!(await claim(db, ref, "autoFollowUpSentAt"))) { summary.caseFollowUps.skipped++; continue; }
      const result = await sendWhatsAppTemplate({ phoneNumber: phone, templateName: "follow_up", bodyValues: [v(patient.name), v(rem.type || "your treatment")] });
      if (result.success) { await ref.update({ autoFollowUpSentAt: new Date().toISOString() }); summary.caseFollowUps.sent++; }
      else { summary.caseFollowUps.failed++; summary.errors.push("Case follow-up (" + (rem.type || "") + ") for " + (patient.name || rem.patientId) + ": " + result.error); }
    }
  } catch (err) {
    summary.errors.push("Case follow-ups crashed: " + err.message);
  }

  // ---------- 2 & 3. Birthdays and 6-month follow-ups (need all patients) ----------
  try {
    const [patients, appointments, plans, biannualActions] = await Promise.all([
      getAllDocs(db, "patients"), getAllDocs(db, "appointments"),
      getAllDocs(db, "treatmentPlans"), getAllDocs(db, "biannualFollowUpActions")
    ]);
    const todayMonth = todayParts.month - 1, todayDate = todayParts.day, currentYear = todayParts.year;

    for (const patient of patients) {
      if (!patient.dob || patient.lastBirthdayGreetingYear === currentYear) continue;
      const d = new Date(patient.dob + "T00:00:00");
      if (isNaN(d.getTime()) || d.getMonth() !== todayMonth || d.getDate() !== todayDate) continue;
      const phone = patient.whatsappNumber || patient.mobile;
      if (!phone) { summary.birthdays.skipped++; continue; }
      const result = await sendWhatsAppTemplate({ phoneNumber: phone, templateName: "birthday_greeting", bodyValues: [v(patient.name)] });
      if (result.success) { await db.collection("patients").doc(patient.id).update({ lastBirthdayGreetingYear: currentYear }); summary.birthdays.sent++; }
      else { summary.birthdays.failed++; summary.errors.push("Birthday greeting for " + (patient.name || patient.id) + ": " + result.error); }
    }

    const MIN_DAYS = 172, MAX_DAYS = 193;
    const nowMs = today.getTime();
    const actionedKeys = new Set(biannualActions.map(a => a.patientId + "|" + a.visitDate));
    const lastVisitByPatient = {};
    for (const pl of plans) {
      if (!pl.patientId || !Array.isArray(pl.items)) continue;
      for (const item of pl.items) {
        if (item.status !== "Completed" || !item.treatmentDate) continue;
        const t = new Date(item.treatmentDate).getTime();
        if (!lastVisitByPatient[pl.patientId] || t > lastVisitByPatient[pl.patientId]) lastVisitByPatient[pl.patientId] = t;
      }
    }
    for (const a of appointments) {
      if (a.status !== "Completed" || !a.patientId || !a.date) continue;
      const t = new Date(a.date).getTime();
      if (!lastVisitByPatient[a.patientId] || t > lastVisitByPatient[a.patientId]) lastVisitByPatient[a.patientId] = t;
    }
    const hasFutureAppt = new Set(appointments.filter(a => a.patientId && a.date && new Date(a.date).getTime() > nowMs && !["Cancelled", "NoShow"].includes(a.status)).map(a => a.patientId));
    for (const patient of patients) {
      const lastVisit = lastVisitByPatient[patient.id];
      if (!lastVisit) continue;
      const daysAgo = (nowMs - lastVisit) / 86400000;
      if (daysAgo < MIN_DAYS || daysAgo > MAX_DAYS || hasFutureAppt.has(patient.id)) continue;
      const visitDateKey = dateKeyIST(new Date(lastVisit));
      if (actionedKeys.has(patient.id + "|" + visitDateKey)) continue;
      const phone = patient.whatsappNumber || patient.mobile;
      if (!phone) { summary.sixMonthFollowUps.skipped++; continue; }
      const result = await sendWhatsAppTemplate({ phoneNumber: phone, templateName: "lead_qualification_checkup_reminder", bodyValues: [v(patient.name)] });
      if (result.success) {
        await db.collection("biannualFollowUpActions").add({ patientId: patient.id, visitDate: visitDateKey, action: "Reminded", source: "auto-cron", createdAt: new Date().toISOString() });
        summary.sixMonthFollowUps.sent++;
      } else { summary.sixMonthFollowUps.failed++; summary.errors.push("6-month follow-up for " + (patient.name || patient.id) + ": " + result.error); }
    }
  } catch (err) {
    summary.errors.push("Birthdays/6-month follow-ups crashed: " + err.message);
  }

  summary.errors = summary.errors.slice(0, 30);
  console.log("[cron-daily] DONE " + JSON.stringify(summary));
  await logRun({ status: "done", finishedAt: new Date().toISOString(), summary });
  return res.status(200).json({ success: true, istDate: todayKey, summary });
}
