// Read-only sync endpoint for the Dental Marketing OS (Cloudflare Worker).
//
// The Marketing OS calls this to learn which slots are already booked in the
// PMS (so the WhatsApp AI never offers a taken slot) and whether a lead has
// actually visited / is booked (so leads move to "Visited" automatically).
// Nothing here writes to the PMS.
//
// SETUP (one-time):
//   1. In Vercel → this project → Settings → Environment Variables, add
//      OS_SYNC_KEY = any long random string (same idea as CRON_SECRET).
//   2. Put the SAME value in the Marketing OS worker as a secret
//      (e.g. `wrangler secret put PMS_SYNC_KEY`) and have it call:
//        GET https://htd-pms.vercel.app/api/os-sync?from=YYYY-MM-DD&to=YYYY-MM-DD
//        GET https://htd-pms.vercel.app/api/os-sync?phones=9876543210,9811122233
//      with the header  Authorization: Bearer <OS_SYNC_KEY>
// Uses the same FIREBASE_SERVICE_ACCOUNT variable as the daily cron.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { timingSafeEqual } from "node:crypto";

function getDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    const sa = JSON.parse(raw.trim().replace(/^'|'$/g, ""));
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const istKey = (d) => IST.format(d);
const addDays = (n) => istKey(new Date(Date.now() + n * 86400000));
const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOT_BOOKED = new Set(["Cancelled", "NoShow", "No-Show"]);

function authorised(req) {
  const key = process.env.OS_SYNC_KEY || "";
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!key || key.length < 16 || !got) return false;
  const a = Buffer.from(key), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!process.env.OS_SYNC_KEY) return res.status(503).json({ error: "OS_SYNC_KEY is not set in Vercel yet" });
  if (!authorised(req)) return res.status(401).json({ error: "unauthorised" });

  try {
    const db = getDb();
    const clinicsSnap = await db.collection("clinics").get();
    const clinicName = {};
    clinicsSnap.forEach((d) => { const c = d.data(); if (!c.archived) clinicName[d.id] = c.name || ""; });

    // ---- Lead / patient lookup by phone ------------------------------------
    if (req.query.phones) {
      const wanted = [...new Set(String(req.query.phones).split(",").map(last10).filter((p) => p.length === 10))].slice(0, 100);
      if (!wanted.length) return res.status(400).json({ error: "phones must be 10-digit numbers, comma separated" });
      const want = new Set(wanted);
      const ps = await db.collection("patients").select("name", "mobile", "whatsappNumber", "createdAt", "status").get();
      const matched = {};
      ps.forEach((d) => {
        const p = d.data();
        for (const ph of [last10(p.mobile), last10(p.whatsappNumber)]) {
          if (want.has(ph) && p.status !== "Archived") (matched[ph] = matched[ph] || []).push({ id: d.id, name: p.name || "", createdAt: p.createdAt || null });
        }
      });
      const ids = [...new Set(Object.values(matched).flat().map((p) => p.id))];
      const apptsBy = {};
      for (let i = 0; i < ids.length; i += 30) {
        const snap = await db.collection("appointments").where("patientId", "in", ids.slice(i, i + 30)).get();
        snap.forEach((d) => { const a = d.data(); (apptsBy[a.patientId] = apptsBy[a.patientId] || []).push(a); });
      }
      const today = addDays(0);
      const results = wanted.map((ph) => {
        const pts = matched[ph] || [];
        if (!pts.length) return { phone: ph, isPatient: false };
        const appts = pts.flatMap((p) => apptsBy[p.id] || []);
        const done = appts.filter((a) => a.status === "Completed").map((a) => a.date).sort();
        const next = appts.filter((a) => a.date >= today && !NOT_BOOKED.has(a.status) && a.status !== "Completed")
          .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))[0];
        return {
          phone: ph, isPatient: true, name: pts[0].name, registeredAt: pts[0].createdAt,
          visits: done.length, firstVisit: done[0] || null, lastVisit: done[done.length - 1] || null,
          nextAppointment: next ? { date: next.date, time: next.startTime, clinic: clinicName[next.clinicId] || "", doctor: next.doctor || "", treatment: next.treatmentType || "" } : null,
        };
      });
      return res.status(200).json({ ok: true, results });
    }

    // ---- Booked appointments in a date range --------------------------------
    const from = DATE_RE.test(req.query.from || "") ? req.query.from : addDays(0);
    const to = DATE_RE.test(req.query.to || "") ? req.query.to : addDays(30);
    if (from > to) return res.status(400).json({ error: "from must be on or before to" });
    const snap = await db.collection("appointments").where("date", ">=", from).where("date", "<=", to).get();
    const appointments = [];
    snap.forEach((d) => {
      const a = d.data();
      if (NOT_BOOKED.has(a.status)) return;
      appointments.push({
        id: d.id, date: a.date, time: a.startTime || "", durationMinutes: Number(a.durationMinutes) || 30,
        clinicId: a.clinicId || "", clinic: clinicName[a.clinicId] || "", chair: a.chair || "", doctor: a.doctor || "",
        status: a.status || "Scheduled", treatment: a.treatmentType || "", video: !!a.videoConsult,
        patientName: a.patientName || "",
      });
    });
    appointments.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
    return res.status(200).json({ ok: true, from, to, clinics: clinicName, count: appointments.length, appointments });
  } catch (e) {
    console.error("[os-sync]", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
