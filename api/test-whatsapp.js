// Vercel Serverless Function used ONLY by the "Test Connection" button in
// Communication Settings -> Configure WhatsApp Business API. It never sends a
// WhatsApp message.
//
// With WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID set, it reads your number's
// details from Meta (display number, verified name, quality rating) - a
// read-only call that confirms the token and Phone Number ID are right.
// Otherwise it falls back to the old Interakt check below.

import { activeBackend, testMeta } from "./_lib/whatsapp.js";

// (Old Interakt check, used only while Interakt is still the active backend:)
//
// It just confirms the Secret Key set in Vercel's environment
// variables (INTERAKT_API_KEY) actually authenticates with Interakt.
//
// How: it calls Interakt's Contacts Retrieval API
// (POST /v1/public/apis/users/?offset=0&limit=1) with the same Basic-Auth
// header used for sending. That endpoint is documented to authenticate the
// same way as the message-send endpoint, and asking for a single contact
// (limit=1) is a lightweight, side-effect-free way to confirm the key
// works — it never creates, sends, or modifies anything.
//
// Setup: same INTERAKT_API_KEY environment variable as api/send-whatsapp.js
// — nothing extra to configure.

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (activeBackend() === "meta") {
    const r = await testMeta();
    return res.status(200).json({ ...r, backend: "meta" });
  }

  if (!process.env.INTERAKT_API_KEY) {
    return res.status(200).json({
      success: false,
      configured: false,
      error: "WhatsApp isn't configured on the server yet. Add WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID in Vercel -> Project -> Settings -> Environment Variables, then redeploy."
    });
  }

  try {
    // Interakt's Get Users API requires a `filters` array in the body -
    // an empty body is rejected with "filters field is required" before
    // it even gets to checking the key. This filter (created_at_utc
    // after year 2000) matches essentially every contact that could
    // exist, so it succeeds regardless of how many contacts you
    // actually have - including zero, which still returns 200 with an
    // empty list. Nothing is created, sent, or modified by this call.
    const response = await fetch("https://api.interakt.ai/v1/public/apis/users/?offset=0&limit=1", {
      method: "POST",
      headers: {
        Authorization: `Basic ${process.env.INTERAKT_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filters: [
          { trait: "created_at_utc", op: "gt", val: "2000-01-01T00:00:00.000Z" }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
      return res.status(200).json({ success: false, configured: true, error: "Interakt rejected this Secret Key (authentication failed). Double-check the key in Vercel matches Interakt: Settings -> Developer Settings -> Secret Key." });
    }
    if (response.status === 429) {
      return res.status(200).json({ success: false, configured: true, error: "Interakt rate limit reached — please wait a moment and try again." });
    }
    if (!response.ok) {
      return res.status(200).json({ success: false, configured: true, error: (data && (data.message || data.error)) || ("Interakt returned HTTP " + response.status) });
    }
    return res.status(200).json({ success: true, configured: true, backend: "interakt" });
  } catch (err) {
    return res.status(200).json({ success: false, configured: true, error: err.message || "Network error reaching Interakt" });
  }
}
