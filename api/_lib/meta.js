// Direct WhatsApp Cloud API (Meta) sending - replaces Interakt.
//
// Your approved templates belong to your WhatsApp Business Account (WABA),
// not to Interakt, so the SAME template names, variables and language codes
// the PMS already uses keep working here unchanged.
//
// Vercel environment variables (Settings -> Environment Variables):
//   WA_ACCESS_TOKEN      Permanent System User access token (Meta Business
//                        Settings -> Users -> System users -> Generate token,
//                        with whatsapp_business_messaging +
//                        whatsapp_business_management permissions)
//   WA_PHONE_NUMBER_ID   "Phone number ID" from Meta App Dashboard ->
//                        WhatsApp -> API Setup (NOT the phone number itself)
//   WA_API_VERSION       optional, defaults to v25.0
//   WA_DEFAULT_COUNTRY   optional, defaults to 91 (used when the PMS sends a
//                        bare 10-digit Indian number)
//
// Same return shape as the old Interakt helper: {success:true, id, data} or
// {success:false, status, error}. Never throws.

import { sanitizeInteraktPhone } from "./interakt.js";

const API_VERSION = () => (process.env.WA_API_VERSION || "v25.0").trim();

export function metaConfigured() {
  return !!(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID);
}

// Meta wants the full international number, digits only, no "+":
// 919876543210. The PMS passes a country code (e.g. "+91") plus a number
// that may contain a leading 0, +91, spaces or dashes.
export function toMetaNumber(countryCode, phoneNumber) {
  const national = sanitizeInteraktPhone(phoneNumber);
  if (!national) return "";
  const cc = String(countryCode || process.env.WA_DEFAULT_COUNTRY || "91").replace(/[^\d]/g, "") || "91";
  // Already carries a country code (e.g. a foreign patient saved as +44...)
  if (national.length > 10 && !national.startsWith("0")) return national;
  return cc + national;
}

// Meta rejects template variables that are empty, or that contain new
// lines, tabs or more than 4 consecutive spaces (error 132018).
function cleanParam(x) {
  let s = x == null ? "" : String(x);
  s = s.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return s || "-";
}

function headerComponent(headerValues) {
  if (!headerValues || !headerValues.length) return null;
  const val = String(headerValues[0] || "").trim();
  if (/^https?:\/\//i.test(val)) {
    const path = val.split("?")[0].toLowerCase();
    if (/\.(jpe?g|png|webp)$/.test(path)) return { type: "header", parameters: [{ type: "image", image: { link: val } }] };
    if (/\.(mp4|3gp)$/.test(path)) return { type: "header", parameters: [{ type: "video", video: { link: val } }] };
    return { type: "header", parameters: [{ type: "document", document: { link: val, filename: decodeURIComponent(path.split("/").pop() || "document.pdf") } }] };
  }
  return { type: "header", parameters: headerValues.map(h => ({ type: "text", text: cleanParam(h) })) };
}

async function postMessage(body) {
  const url = `https://graph.facebook.com/${API_VERSION()}/${process.env.WA_PHONE_NUMBER_ID.trim()}/messages`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const e = (data && data.error) || {};
      const detail = (e.error_data && e.error_data.details) ? " - " + e.error_data.details : "";
      return {
        success: false,
        status: response.status === 429 ? 429 : (response.status || 500),
        code: e.code,
        error: (e.message || ("Meta request failed (HTTP " + response.status + ")")) + detail + (e.code ? " [code " + e.code + "]" : "")
      };
    }
    const id = data && data.messages && data.messages[0] && data.messages[0].id;
    return { success: true, id, data };
  } catch (err) {
    return { success: false, status: 500, error: err.message || "Network error calling Meta WhatsApp API" };
  }
}

export async function sendMetaTemplate({ countryCode, phoneNumber, templateName, languageCode, headerValues, bodyValues }) {
  if (!metaConfigured()) {
    return { success: false, status: 500, error: "WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID are not set on the server." };
  }
  const to = toMetaNumber(countryCode, phoneNumber);
  if (!to) return { success: false, status: 400, error: "A valid phoneNumber is required" };
  if (!templateName) return { success: false, status: 400, error: "templateName is required" };

  const components = [];
  const header = headerComponent(headerValues);
  if (header) components.push(header);
  if (bodyValues && bodyValues.length) {
    components.push({ type: "body", parameters: bodyValues.map(b => ({ type: "text", text: cleanParam(b) })) });
  }

  const build = (lang) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: templateName, language: { code: lang }, ...(components.length ? { components } : {}) }
  });

  const lang = (languageCode || "en").trim();
  let result = await postMessage(build(lang));
  // Templates made in Interakt are usually approved as "en", but some are
  // "en_US". Meta needs the exact code (error 132001 = template not found in
  // that language), so try the other English variant once before failing.
  if (!result.success && result.code === 132001 && (lang === "en" || lang === "en_US")) {
    const retry = await postMessage(build(lang === "en" ? "en_US" : "en"));
    if (retry.success) result = retry;
  }
  return result;
}

// Free-form text. Meta only delivers this inside the 24-hour window after
// the patient last messaged you; outside it, use a template.
export async function sendMetaText({ countryCode, phoneNumber, message }) {
  if (!metaConfigured()) {
    return { success: false, status: 500, error: "WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID are not set on the server." };
  }
  const to = toMetaNumber(countryCode, phoneNumber);
  if (!to) return { success: false, status: 400, error: "A valid phoneNumber is required" };
  const result = await postMessage({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: message || "" } });
  if (!result.success && result.code === 131047) {
    result.error += " (plain text only works within 24 hours of the patient's last message - use an approved template instead)";
  }
  return result;
}

// Side-effect-free check used by Test Connection: reads the number's details.
export async function testMeta() {
  if (!metaConfigured()) return { success: false, configured: false, error: "WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID are not set in Vercel yet." };
  try {
    const url = `https://graph.facebook.com/${API_VERSION()}/${process.env.WA_PHONE_NUMBER_ID.trim()}?fields=display_phone_number,verified_name,quality_rating`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN.trim()}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, configured: true, error: (data.error && data.error.message) || ("Meta returned HTTP " + response.status) };
    }
    return { success: true, configured: true, number: data.display_phone_number, name: data.verified_name, quality: data.quality_rating };
  } catch (err) {
    return { success: false, configured: true, error: err.message || "Network error reaching Meta" };
  }
}
