// Single entry point for every WhatsApp send in the PMS (staff-triggered
// sends in api/send-whatsapp.js and the 9 AM automation in api/cron-daily.js).
//
// Picks the backend from Vercel's environment variables:
//   - WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID set  -> direct Meta Cloud API
//   - otherwise, INTERAKT_API_KEY set           -> Interakt (old setup)
// So switching over is just adding the two Meta variables and redeploying,
// and rolling back is removing them. Nothing in the app itself changes.

import { sendInteraktTemplate, sendInteraktText } from "./interakt.js";
import { metaConfigured, sendMetaTemplate, sendMetaText, testMeta } from "./meta.js";

export function activeBackend() {
  if (metaConfigured()) return "meta";
  if (process.env.INTERAKT_API_KEY) return "interakt";
  return null;
}

export function notConfiguredError() {
  return "WhatsApp is not configured on the server. Add WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID in Vercel -> Project -> Settings -> Environment Variables, then redeploy.";
}

export async function sendWhatsAppTemplate(opts) {
  const backend = activeBackend();
  if (backend === "meta") return sendMetaTemplate(opts);
  if (backend === "interakt") return sendInteraktTemplate(opts);
  return { success: false, status: 500, error: notConfiguredError() };
}

export async function sendWhatsAppText(opts) {
  const backend = activeBackend();
  if (backend === "meta") return sendMetaText(opts);
  if (backend === "interakt") return sendInteraktText(opts);
  return { success: false, status: 500, error: notConfiguredError() };
}

export { testMeta };
