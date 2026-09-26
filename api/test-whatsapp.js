// Vercel Serverless Function used ONLY by the "Test Connection" button in
// Communication Settings -> Configure Interakt. It never sends a WhatsApp
// message — it just confirms the Secret Key set in Vercel's environment
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

  if (!process.env.INTERAKT_API_KEY) {
    return res.status(200).json({
      success: false,
      configured: false,
      error: "INTERAKT_API_KEY is not set on the server yet. Add it in Vercel -> Project -> Settings -> Environment Variables, then redeploy."
    });
  }

  try {
    const response = await fetch("https://api.interakt.ai/v1/public/apis/users/?offset=0&limit=1", {
      method: "POST",
      headers: {
        Authorization: `Basic ${process.env.INTERAKT_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
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
    return res.status(200).json({ success: true, configured: true });
  } catch (err) {
    return res.status(200).json({ success: false, configured: true, error: err.message || "Network error reaching Interakt" });
  }
}
