// Email sending for the PMS, through the clinic's own mailbox (SMTP).
//
// Vercel environment variables (Settings -> Environment Variables).
// Option A - clinic domain mailbox, e.g. info@dentalhealingtouch.in:
//   SMTP_HOST   mail.dentalhealingtouch.in
//   SMTP_PORT   465   (optional, default 465; use 587 if your host says so)
//   SMTP_USER   info@dentalhealingtouch.in
//   SMTP_PASS   that mailbox's password
// Option B - a Gmail account:
//   GMAIL_USER          the Gmail address
//   GMAIL_APP_PASSWORD  a 16-letter Google "App password" (not the normal one)
// Optional for both:
//   EMAIL_FROM_NAME     defaults to "Healing Touch Dental"
//
// Never throws - returns {success:true,id} or {success:false,status,error}.

import nodemailer from "nodemailer";

function smtpSettings() {
  const env = process.env;
  if (env.SMTP_USER && env.SMTP_PASS) {
    const port = Number(env.SMTP_PORT || 465) || 465;
    return {
      host: String(env.SMTP_HOST || "").trim() || ("mail." + String(env.SMTP_USER).split("@")[1]),
      port, secure: port === 465,
      user: String(env.SMTP_USER).trim(), pass: String(env.SMTP_PASS),
      kind: "smtp"
    };
  }
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    return {
      host: "smtp.gmail.com", port: 465, secure: true,
      user: String(env.GMAIL_USER).trim(),
      // Google shows app passwords in groups of four ("abcd efgh ijkl mnop").
      pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, ""),
      kind: "gmail"
    };
  }
  return null;
}

export function emailConfigured() {
  return !!smtpSettings();
}

export function emailFrom() {
  const c = smtpSettings();
  return c ? c.user : "";
}

export function emailNotConfiguredError() {
  return "Email isn't set up yet: add SMTP_HOST, SMTP_USER and SMTP_PASS (or GMAIL_USER and GMAIL_APP_PASSWORD) in Vercel -> Project -> Settings -> Environment Variables, then redeploy.";
}

let transporter = null;
function getTransport() {
  if (!transporter) {
    const c = smtpSettings();
    transporter = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure,
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
    });
  }
  return transporter;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Plain text -> simple, readable HTML (keeps line breaks, makes links clickable).
export function textToHtml(text) {
  const body = escapeHtml(text || "")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#14171A;">${body}</div>`;
}

export async function sendEmail({ to, subject, text, html, attachments, replyTo }) {
  if (!emailConfigured()) return { success: false, status: 500, error: emailNotConfiguredError() };
  try {
    const info = await getTransport().sendMail({
      from: { name: (process.env.EMAIL_FROM_NAME || "Healing Touch Dental").trim(), address: emailFrom() },
      to,
      subject: subject || "Healing Touch Dental",
      text: text || "",
      html: html || textToHtml(text || ""),
      replyTo: replyTo || undefined,
      attachments: (attachments || []).map(a => ({
        filename: a.filename || "document.pdf",
        content: Buffer.from(String(a.contentBase64 || ""), "base64"),
        contentType: a.contentType || "application/pdf"
      }))
    });
    return { success: true, id: info && info.messageId };
  } catch (e) {
    let msg = (e && e.message) || "Email could not be sent";
    if (/Invalid login|not accepted|535|EAUTH/i.test(msg + " " + (e && e.code))) {
      msg = (smtpSettings() || {}).kind === "gmail"
        ? "Gmail refused the login. Check GMAIL_USER and GMAIL_APP_PASSWORD in Vercel (it must be a 16-letter App password, not your normal Gmail password)."
        : "The mail server refused the login. Check SMTP_USER and SMTP_PASS in Vercel (the full email address and that mailbox's password).";
    } else if (/Daily user sending limit|550 5\.4\.5|exceeded|rate limit/i.test(msg)) {
      msg = "The mailbox's daily/hourly sending limit has been reached. Try again later.";
    } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET|Greeting never received/i.test(msg + " " + (e && e.code))) {
      msg = "Couldn't connect to the mail server (" + ((smtpSettings() || {}).host || "?") + "). Check SMTP_HOST and SMTP_PORT in Vercel.";
    }
    return { success: false, status: 502, error: msg };
  }
}
