// Vercel Serverless Function — keeps your Interakt Secret Key hidden on the
// server. Your app calls THIS endpoint (/api/send-whatsapp), never Interakt
// directly, so the key is never visible to anyone viewing your website or
// inspecting network requests in the browser.
//
// Setup (one-time):
// 1. In Vercel, open your project -> Settings -> Environment Variables.
// 2. Add a variable named INTERAKT_API_KEY with your Interakt Secret Key
//    (find it in Interakt: Settings -> Developer Settings -> Secret Key).
// 3. Redeploy the project so the variable takes effect.
//
// This function only ever sends a message when called with a phoneNumber.
// It never runs on its own and never fires from a page load — only from an
// explicit action in the PMS. Test Connection does NOT call this file at
// all; see api/test-whatsapp.js for that.

function sanitizeInteraktPhone(raw) {
  // Interakt's documented format: digits only, no leading country code and
  // no leading "0". Patients' numbers in the PMS are sometimes entered with
  // a leading 0, a +91, spaces, or dashes — strip all of that down to the
  // bare national number Interakt expects.
  let digits = String(raw || "").replace(/[^\d]/g, "");
  // Strip a leading country code (91) if present alongside a full 10-digit
  // Indian mobile number (12 digits total: 91 + 10).
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  // Strip any remaining leading zeros.
  digits = digits.replace(/^0+/, "");
  return digits;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.INTERAKT_API_KEY) {
    return res.status(500).json({
      error: "INTERAKT_API_KEY is not set on the server. Add it in Vercel -> Project -> Settings -> Environment Variables, then redeploy."
    });
  }

  const { countryCode, phoneNumber, message, templateName, languageCode, headerValues, bodyValues, callbackData } = req.body || {};

  const cleanPhone = sanitizeInteraktPhone(phoneNumber);
  if (!cleanPhone) {
    return res.status(400).json({ error: "A valid phoneNumber is required" });
  }
  if (!templateName && (!message || !String(message).trim())) {
    return res.status(400).json({ error: "Provide either a templateName or a message" });
  }

  try {
    // IMPORTANT: Interakt's own documentation for this endpoint
    // (https://api.interakt.ai/v1/public/message/) explicitly lists
    // "Supported Values: Template" for the `type` field — it does not
    // document a freeform/plain-text send through this same endpoint.
    // The "Text" path below is kept only so a template-less send doesn't
    // hard-fail outright (some Interakt accounts do accept it in
    // practice for messages within an open 24-hour customer session),
    // but it is NOT verified against Interakt's documentation the way
    // the Template path is. For anything automated (appointment
    // confirmations/reminders), always pass a templateName so the send
    // goes through the documented, reliable path.
    const payload = templateName
      ? {
          countryCode: countryCode || "+91",
          phoneNumber: cleanPhone,
          type: "Template",
          ...(callbackData ? { callbackData } : {}),
          template: {
            name: templateName,
            languageCode: languageCode || "en",
            ...(headerValues && headerValues.length ? { headerValues } : {}),
            bodyValues: bodyValues || []
          }
        }
      : {
          countryCode: countryCode || "+91",
          phoneNumber: cleanPhone,
          type: "Text",
          text: { preview_url: false, body: message || "" }
        };

    const response = await fetch("https://api.interakt.ai/v1/public/message/", {
      method: "POST",
      headers: {
        Authorization: `Basic ${process.env.INTERAKT_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 429) {
      return res.status(429).json({ error: "Interakt rate limit reached — please wait a moment and try again." });
    }
    if (!response.ok) {
      const baseMsg = (data && (data.message || data.error)) || ("Interakt request failed (HTTP " + response.status + ")");
      const hint = !templateName ? " (Interakt's API only documents support for Template-type messages — if this keeps failing, use an approved template instead of a plain message.)" : "";
      return res.status(response.status).json({ error: baseMsg + hint });
    }
    return res.status(200).json({ success: true, id: data && data.id, data });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Network error calling Interakt" });
  }
}
