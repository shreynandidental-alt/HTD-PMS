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

import { sendInteraktTemplate } from "./_lib/interakt.js";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function getDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    const serviceAccount = JSON.parse(raw);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

const IST_PARTS_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
function istDateParts(d) {
  const [y, m, day] = IST_PARTS_FMT.format(d).split("-").map(Number);
  return { year: y, month: m, day };
}
function todayIST() {
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

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "CRON_SECRET is not set on the server - refusing to run automated sends until it is." });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!process.env.INTERAKT_API_KEY) {
    return res.status(500).json({ error: "INTERAKT_API_KEY is not set on the server." });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    return res.status(500).json({ error: "Firebase Admin setup failed: " + err.message });
  }

  const summary = { appointmentReminders: { sent: 0, skipped: 0, failed: 0 }, birthdays: { sent: 0, skipped: 0, failed: 0 }, sixMonthFollowUps: { sent: 0, skipped: 0, failed: 0 }, errors: [] };

  try {
    const today = todayIST();
    const todayKey = dateKeyIST(today);
    const todayParts = istDateParts(new Date());
    const todayMonth = todayParts.month - 1;
    const todayDate = todayParts.day;

    const [patients, appointments, plans, biannualActions] = await Promise.all([
      getAllDocs(db, "patients"),
      getAllDocs(db, "appointments"),
      getAllDocs(db, "treatmentPlans"),
      getAllDocs(db, "biannualFollowUpActions")
    ]);
    const patientsById = {};
    patients.forEach(p => { patientsById[p.id] = p; });

    const todaysAppts = appointments.filter(a =>
      a.date === todayKey &&
      !["Cancelled", "NoShow", "Completed"].includes(a.status) &&
      !a.reminderSentAt
    );
    for (const appt of todaysAppts) {
      const patient = appt.patientId ? patientsById[appt.patientId] : null;
      const phone = (patient && (patient.whatsappNumber || patient.mobile)) || appt.patientMobile;
      if (!phone) { summary.appointmentReminders.skipped++; continue; }
      const result = await sendInteraktTemplate({
        phoneNumber: phone,
        templateName: "appointment_reminder",
        bodyValues: [appt.patientName || (patient && patient.name) || "", formatDateLong(today), formatTime12h(appt.startTime)]
      });
      if (result.success) {
        await db.collection("appointments").doc(appt.id).update({ reminderSentAt: new Date().toISOString() });
        summary.appointmentReminders.sent++;
      } else {
        summary.appointmentReminders.failed++;
        summary.errors.push("Appointment reminder for " + (appt.patientName || appt.id) + ": " + result.error);
      }
    }

    const currentYear = todayParts.year;
    const birthdayPatients = patients.filter(p => {
      if (!p.dob) return false;
      const d = new Date(p.dob + "T00:00:00");
      if (isNaN(d.getTime())) return false;
      if (d.getMonth() !== todayMonth || d.getDate() !== todayDate) return false;
      return p.lastBirthdayGreetingYear !== currentYear;
    });
    for (const patient of birthdayPatients) {
      const phone = patient.whatsappNumber || patient.mobile;
      if (!phone) { summary.birthdays.skipped++; continue; }
      const result = await sendInteraktTemplate({
        phoneNumber: phone,
        templateName: "birthday_greeting",
        bodyValues: [patient.name || ""]
      });
      if (result.success) {
        await db.collection("patients").doc(patient.id).update({ lastBirthdayGreetingYear: currentYear });
        summary.birthdays.sent++;
      } else {
        summary.birthdays.failed++;
        summary.errors.push("Birthday greeting for " + (patient.name || patient.id) + ": " + result.error);
      }
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
    const hasFutureAppt = new Set(
      appointments.filter(a => a.patientId && a.date && new Date(a.date).getTime() > nowMs && !["Cancelled", "NoShow"].includes(a.status)).map(a => a.patientId)
    );
    for (const patient of patients) {
      const lastVisit = lastVisitByPatient[patient.id];
      if (!lastVisit) continue;
      const daysAgo = (nowMs - lastVisit) / 86400000;
      if (daysAgo < MIN_DAYS || daysAgo > MAX_DAYS) continue;
      if (hasFutureAppt.has(patient.id)) continue;
      const visitDateKey = dateKeyIST(new Date(lastVisit));
      if (actionedKeys.has(patient.id + "|" + visitDateKey)) continue;
      const phone = patient.whatsappNumber || patient.mobile;
      if (!phone) { summary.sixMonthFollowUps.skipped++; continue; }
      const result = await sendInteraktTemplate({
        phoneNumber: phone,
        templateName: "lead_qualification_checkup_reminder",
        bodyValues: [patient.name || ""]
      });
      if (result.success) {
        await db.collection("biannualFollowUpActions").add({ patientId: patient.id, visitDate: visitDateKey, action: "Reminded", source: "auto-cron", createdAt: new Date().toISOString() });
        summary.sixMonthFollowUps.sent++;
      } else {
        summary.sixMonthFollowUps.failed++;
        summary.errors.push("6-month follow-up for " + (patient.name || patient.id) + ": " + result.error);
      }
    }

    const allReminders = await getAllDocs(db, "reminders");
    const dueFollowUps = allReminders.filter(r =>
      r.followupDate &&
      r.patientId &&
      r.status === "Pending" &&
      dateKeyIST(new Date(r.followupDate)) === todayKey &&
      !r.autoFollowUpSentAt
    );
    summary.caseFollowUps = { sent: 0, skipped: 0, failed: 0 };
    for (const rem of dueFollowUps) {
      const patient = patientsById[rem.patientId];
      const phone = patient && (patient.whatsappNumber || patient.mobile);
      if (!phone) { summary.caseFollowUps.skipped++; continue; }
      const result = await sendInteraktTemplate({
        phoneNumber: phone,
        templateName: "follow_up",
        bodyValues: [patient.name || "", rem.type || "your treatment"]
      });
      if (result.success) {
        await db.collection("reminders").doc(rem.id).update({ autoFollowUpSentAt: new Date().toISOString() });
        summary.caseFollowUps.sent++;
      } else {
        summary.caseFollowUps.failed++;
        summary.errors.push("Case follow-up (" + (rem.type || "") + ") for " + (patient && patient.name || rem.patientId) + ": " + result.error);
      }
    }

    return res.status(200).json({ success: true, ranAt: today.toISOString(), summary });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Cron job failed", summary });
  }
}
