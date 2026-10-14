// Vercel Serverless Function — keeps your WhatsApp access token hidden on
// the server. Your app calls THIS endpoint (/api/send-whatsapp), never Meta
// directly, so the token is never visible to anyone viewing your website or
// inspecting network requests in the browser.
//
// Setup (one-time):
// 1. In Vercel, open your project -> Settings -> Environment Variables.
// 2. Add WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID (see api/_lib/meta.js).
// 3. Redeploy the project so the variables take effect.
// (If those two aren't set but the old INTERAKT_API_KEY is, it still sends
// through Interakt - see api/_lib/whatsapp.js.)
//
// This function only ever sends a message when called with a phoneNumber -
// either from an explicit action in the PMS (a staff member tapping Send),
// or from api/cron-daily.js's automated 9 AM check. Test Connection does
// NOT call this file at all; see api/test-whatsapp.js for that.
//
// The actual sending logic lives in api/_lib/whatsapp.js, shared
// with the cron job so both send through one single implementation.

import { activeBackend, notConfiguredError, sendWhatsAppTemplate, sendWhatsAppText } from "./_lib/whatsapp.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!activeBackend()) {
    return res.status(500).json({ error: notConfiguredError() });
  }

  const { countryCode, phoneNumber, message, templateName, languageCode, headerValues, bodyValues, callbackData } = req.body || {};

  if (!templateName && (!message || !String(message).trim())) {
    return res.status(400).json({ error: "Provide either a templateName or a message" });
  }

  const result = templateName
    ? await sendWhatsAppTemplate({ countryCode, phoneNumber, templateName, languageCode, headerValues, bodyValues, callbackData })
    : await sendWhatsAppText({ countryCode, phoneNumber, message });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.status(200).json({ success: true, id: result.id, data: result.data });
}
