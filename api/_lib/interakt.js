// Shared Interakt-sending logic. Filenames/folders starting with "_" are
// not treated as routes by Vercel, so this file is never itself reachable
// as a URL - it only exists to be imported by api/send-whatsapp.js (the
// manual, user-triggered sends) and api/cron-daily.js (the automated
// 9 AM check), so both send through the exact same, single implementation
// rather than two copies that could quietly drift apart.

export function sanitizeInteraktPhone(raw) {
  // Interakt's documented format: digits only, no leading country code and
  // no leading "0". Patients' numbers in the PMS are sometimes entered with
  // a leading 0, a +91, spaces, or dashes - strip all of that down to the
  // bare national number Interakt expects.
  let digits = String(raw || "").replace(/[^\d]/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  digits = digits.replace(/^0+/, "");
  return digits;
}

// Sends one Template-type WhatsApp message via Interakt. Returns
// {success:true, id, data} or {success:false, error, status}. Never
// throws - callers (especially the cron job, looping over many patients)
// can check `.success` and move on to the next one rather than needing
// try/catch around every call.
export async function sendInteraktTemplate({ countryCode, phoneNumber, templateName, languageCode, headerValues, bodyValues, callbackData }) {
  if (!process.env.INTERAKT_API_KEY) {
    return { success: false, status: 500, error: "INTERAKT_API_KEY is not set on the server." };
  }
  const cleanPhone = sanitizeInteraktPhone(phoneNumber);
  if (!cleanPhone) {
    return { success: false, status: 400, error: "A valid phoneNumber is required" };
  }
  if (!templateName) {
    return { success: false, status: 400, error: "templateName is required" };
  }
  const payload = {
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
  };
  try {
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
      return { success: false, status: 429, error: "Interakt rate limit reached" };
    }
    if (!response.ok) {
      const baseMsg = (data && (data.message || data.error)) || ("Interakt request failed (HTTP " + response.status + ")");
      return { success: false, status: response.status, error: baseMsg };
    }
    return { success: true, id: data && data.id, data };
  } catch (err) {
    return { success: false, status: 500, error: err.message || "Network error calling Interakt" };
  }
}

// A plain-text send, kept for send-whatsapp.js's existing template-less
// fallback path (not used by the cron job, which always sends Template
// type since that's what's officially documented and reliable).
export async function sendInteraktText({ countryCode, phoneNumber, message }) {
  if (!process.env.INTERAKT_API_KEY) {
    return { success: false, status: 500, error: "INTERAKT_API_KEY is not set on the server." };
  }
  const cleanPhone = sanitizeInteraktPhone(phoneNumber);
  if (!cleanPhone) {
    return { success: false, status: 400, error: "A valid phoneNumber is required" };
  }
  const payload = {
    countryCode: countryCode || "+91",
    phoneNumber: cleanPhone,
    type: "Text",
    text: { preview_url: false, body: message || "" }
  };
  try {
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
      return { success: false, status: 429, error: "Interakt rate limit reached" };
    }
    if (!response.ok) {
      const baseMsg = (data && (data.message || data.error)) || ("Interakt request failed (HTTP " + response.status + ")");
      const hint = " (Interakt's API only documents support for Template-type messages - if this keeps failing, use an approved template instead of a plain message.)";
      return { success: false, status: response.status, error: baseMsg + hint };
    }
    return { success: true, id: data && data.id, data };
  } catch (err) {
    return { success: false, status: 500, error: err.message || "Network error calling Interakt" };
  }
}
