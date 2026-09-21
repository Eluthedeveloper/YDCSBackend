import { Router, Response } from 'express';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';

const router = Router();

// Dedicated limiter so the contact form can't be used to spam the SMTP inbox.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages, please try again later.' },
});

// Logo lives at asset/Logo.png relative to the project root.
// Sent as a CID inline attachment so it renders reliably across email clients.
const LOGO_PATH = path.join(process.cwd(), 'asset', 'Logo.png');
const LOGO_CID = 'company-logo';
const LOGO_EXISTS = fs.existsSync(LOGO_PATH);

if (!LOGO_EXISTS) {
  console.warn(
    `[contact] Logo not found at ${LOGO_PATH}. Emails will send without the logo. ` +
    `Make sure asset/Logo.png exists relative to the directory the server is started from.`
  );
}

// Build the attachments array only when the logo file actually exists,
// so a missing file doesn't reference a broken cid in the HTML.
function logoAttachments() {
  if (!LOGO_EXISTS) return [];
  return [
    {
      filename: 'Logo.png',
      path: LOGO_PATH,
      cid: LOGO_CID,
      contentType: 'image/png',
      contentDisposition: 'inline' as const,
    },
  ];
}

// Only reference the cid in the HTML if the logo actually exists,
// otherwise a dangling cid: reference shows as a broken image.
function logoImgTag() {
  if (!LOGO_EXISTS) return '';
  return `<img src="cid:${LOGO_CID}" alt="" width="160" style="display:block; max-width:160px; height:auto; margin-bottom:16px;" />`;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Escape basic HTML to avoid markup injection from user input
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Shared modern email shell — gradient header, card body, clean footer
function emailShell(opts: {
  headerTitle: string;
  headerSubtitle?: string;
  bodyHtml: string;
  footerText: string;
}): string {
  const { headerTitle, headerSubtitle, bodyHtml, footerText } = opts;
  return `
  <div style="margin:0; padding:32px 16px; background-color:#f4f5f7; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(20,20,43,0.08);">

      <div style="background:linear-gradient(135deg,#6a11cb 0%,#2575fc 100%); padding:36px 32px; text-align:left;">
        ${logoImgTag()}
        <p style="margin:0 0 4px; color:rgba(255,255,255,0.95); font-size:13px; font-weight:600; letter-spacing:0.3px; text-transform:uppercase;">
          Ethiopian Evangelical Church Mekane Yesus
        </p>
        <p style="margin:0 0 18px; color:rgba(255,255,255,0.8); font-size:12px; letter-spacing:0.2px;">
          Yemisrach Dimts Communication Service
        </p>
        <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:700; letter-spacing:0.2px;">
          ${headerTitle}
        </h1>
        ${headerSubtitle ? `<p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:14px;">${headerSubtitle}</p>` : ''}
      </div>

      <div style="padding:32px;">
        ${bodyHtml}
      </div>

      <div style="padding:20px 32px; background:#fafafa; border-top:1px solid #eef0f3;">
        <p style="margin:0; font-size:12px; color:#9aa0a6; line-height:1.6;">${footerText}</p>
      </div>
    </div>
  </div>`;
}

function infoRow(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:10px 0; width:120px; vertical-align:top; font-size:13px; font-weight:600; color:#6a11cb; text-transform:uppercase; letter-spacing:0.4px;">
        ${label}
      </td>
      <td style="padding:10px 0; font-size:15px; color:#2b2d34; vertical-align:top;">
        ${value}
      </td>
    </tr>`;
}

router.post('/', contactLimiter, async (req, res: Response) => {
  const { name, email, phone, subject, message, lang } = req.body;

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Optional phone validation — allow digits, spaces, +, -, ()
  const phoneRegex = /^[0-9+\-()\s]{7,20}$/;
  if (phone && !phoneRegex.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = phone ? escapeHtml(phone) : '';
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br />');

  const CONTACT_PHONE = process.env.CONTACT_PHONE || '+251 XXX XXX XXX';

  try {
    // --- Admin notification email ---
    const adminBody = `
      <table style="width:100%; border-collapse:collapse;">
        ${infoRow('Name', safeName)}
        ${infoRow('Email', `<a href="mailto:${safeEmail}" style="color:#2575fc; text-decoration:none;">${safeEmail}</a>`)}
        ${safePhone ? infoRow('Phone', `<a href="tel:${safePhone}" style="color:#2575fc; text-decoration:none;">${safePhone}</a>`) : ''}
        ${infoRow('Subject', safeSubject)}
      </table>
      <div style="margin-top:20px; padding:18px 20px; background:#f7f8fc; border-left:4px solid #6a11cb; border-radius:8px;">
        <p style="margin:0 0 6px; font-size:12px; font-weight:600; color:#6a11cb; text-transform:uppercase; letter-spacing:0.4px;">Message</p>
        <p style="margin:0; font-size:15px; color:#3a3d45; line-height:1.6;">${safeMessage}</p>
      </div>`;

    await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'YDCS Radio'}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: process.env.CONTACT_RECEIVER || process.env.SMTP_USER,
      replyTo: email,
      subject: `[Contact Form] ${subject}`,
      html: emailShell({
        headerTitle: 'New Contact Form Message',
        headerSubtitle: 'Someone reached out through the YDCS Radio website',
        bodyHtml: adminBody,
        footerText: 'Sent from the YDCS Radio contact form.',
      }),
      attachments: logoAttachments(),
    });

    // --- Confirmation email translations ---
    const confirmEmail: Record<
      string,
      { subject: string; greeting: string; subtitle: string; body: string; footer: string; callUs: string }
    > = {
      en: {
        subject: 'Your message has been received - EECMY-YDCS',
        greeting: 'Thank you for contacting us!',
        subtitle: "We've received your message",
        body: 'Your message has been received. We will get back to you as soon as possible.',
        footer: 'This is an automated reply from YDCS Radio.',
        callUs: 'Prefer to talk? Call us at',
      },
      am: {
        subject: 'መልእክትዎ ተቀብለናል - YDCS Radio',
        greeting: 'ስለ ግንኙነትዎ እናመሰግናለን!',
        subtitle: 'መልእክትዎን ተቀብለናል',
        body: 'መልእክትዎ ተቀብለናል። በቅርቡ እንመልስልዎታለን።',
        footer: 'ይህ ከYDCS Radio የተላከ ራስ-ተሰጥኦ መልእክት ነው።',
        callUs: 'በስልክ ማነጋገር ይፈልጋሉ? ይደውሉልን',
      },
      om: {
        subject: 'Xalayaan keessan nu qaqqabeera - Sagalee Missirachoo',
        greeting: 'waan nu qunnamataniif Galatoomaa!',
        subtitle: 'Ergaan keessan nu qaqqabeera',
        body: 'Xalayaan keessan nu bira gaheera. Yeroo dhiyootti isiniif deebisna!',
        footer: "Kun Sagalee Missiraachoo irraa ergamee of-ergaa ta'uu dha.",
        callUs: 'Bilbila fedhitanii? Nutti bilbilaa',
      },
    };

    const c = confirmEmail[lang as string] || confirmEmail.en;

    const userBody = `
      <p style="margin:0 0 18px; font-size:15px; color:#3a3d45;">Dear ${safeName},</p>
      <p style="margin:0 0 22px; font-size:15px; color:#3a3d45; line-height:1.6;">${c.body}</p>

      <table style="width:100%; border-collapse:collapse; margin-bottom:22px;">
        ${infoRow('Subject', safeSubject)}
      </table>

      <div style="padding:18px 20px; background:#f7f8fc; border-left:4px solid #2575fc; border-radius:8px; margin-bottom:22px;">
        <p style="margin:0 0 6px; font-size:12px; font-weight:600; color:#2575fc; text-transform:uppercase; letter-spacing:0.4px;">Your Message</p>
        <p style="margin:0; font-size:15px; color:#3a3d45; line-height:1.6;">${safeMessage}</p>
      </div>

      <div style="text-align:center; padding:16px; background:linear-gradient(135deg,#6a11cb 0%,#2575fc 100%); border-radius:10px;">
        <p style="margin:0; font-size:13px; color:rgba(255,255,255,0.85);">${c.callUs}</p>
        <a href="tel:${CONTACT_PHONE.replace(/\s/g, '')}" style="display:inline-block; margin-top:6px; font-size:18px; font-weight:700; color:#ffffff; text-decoration:none; letter-spacing:0.5px;">
          📞 ${CONTACT_PHONE}
        </a>
      </div>`;

    await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'YDCS Radio'}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: c.subject,
      html: emailShell({
        headerTitle: c.greeting,
        headerSubtitle: c.subtitle,
        bodyHtml: userBody,
        footerText: `${c.footer} · ${CONTACT_PHONE}`,
      }),
      attachments: logoAttachments(),
    });

    res.json({ success: true, message: 'Your message has been sent. We will contact you soon.' });
  } catch (error) {
    console.error('Contact form email error:', error);
    res.status(500).json({ error: 'Failed to send message. Please try again later.' });
  }
});

export default router;