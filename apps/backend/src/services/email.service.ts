import nodemailer, {
  Transporter,
  SendMailOptions,
} from "nodemailer";

import { env } from "../config/env.js";
import { logError, logInfo } from "../utils/logger.js";

let transporter: Transporter | null = null;

const SAFE_SMTP_CODES = new Set([
  "EAUTH", "EENVELOPE", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "ETLS", "EMESSAGE", "EDNS",
]);

function smtpErrorDetails(error: unknown) {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rawCode = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  const code = SAFE_SMTP_CODES.has(rawCode) ? rawCode : "ESMTP";
  const responseCode = typeof candidate.responseCode === "number" ? candidate.responseCode : undefined;
  return { code, ...(responseCode === undefined ? {} : { responseCode }) };
}

class EmailTransportError extends Error {
  readonly code: string;
  readonly responseCode: number | undefined;

  constructor(details: ReturnType<typeof smtpErrorDetails>) {
    super("The email could not be accepted by the configured SMTP server.");
    this.name = "EmailTransportError";
    this.code = details.code;
    this.responseCode = details.responseCode;
  }
}

async function sendEmail(emailType: string, mail: SendMailOptions): Promise<void> {
  logInfo("email_smtp_attempt", { emailType });
  try {
    const result = await getTransporter().sendMail(mail);
    const acceptedCount = result.accepted?.length ?? 0;
    const rejectedCount = result.rejected?.length ?? 0;
    if (acceptedCount === 0 || rejectedCount > 0) {
      throw new EmailTransportError({ code: "EENVELOPE" });
    }
    const responseCode = /^([1-5][0-9]{2})\b/.exec(result.response ?? "")?.[1];
    logInfo("email_smtp_accepted", {
      emailType,
      acceptedCount,
      responseCode: responseCode ? Number(responseCode) : undefined,
    });
  } catch (error) {
    const details = smtpErrorDetails(error);
    logError("email_smtp_failed", { emailType, ...details });
    throw error instanceof EmailTransportError ? error : new EmailTransportError(details);
  }
}

export async function sendApplicantVerificationEmail(input: { recipientEmail: string; recipientName: string; actionLink: string }): Promise<void> {
  const recipientName = escapeHtml(input.recipientName);
  const actionLink = escapeHtml(input.actionLink);
  await sendEmail("applicant_verification", {
    from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL },
    to: input.recipientEmail,
    subject: "Verify your IDMC applicant account",
    text: `Dear ${input.recipientName},\n\nConfirm your email address to activate your IDMC Applicant Portal account: ${input.actionLink}\n\nAfter confirmation, this browser will open your applicant account automatically.\n\nIDMC Admissions`,
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#35111c"><div style="max-width:620px;margin:24px auto;padding:24px;border-top:6px solid #68172a;background:#fff"><h2 style="color:#68172a">Verify your applicant account</h2><p>Dear ${recipientName},</p><p>Confirm your email address to activate your IDMC Applicant Portal account.</p><p><a href="${actionLink}" style="display:inline-block;padding:12px 18px;background:#68172a;color:#fff;text-decoration:none">Verify email address</a></p><p>After confirmation, this browser will open your applicant account automatically.</p><p>If you did not start this registration, you can ignore this message.</p><p>IDMC Admissions</p></div></body></html>`,
  });
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE,

      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASSWORD,
      },

      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }

  return transporter;
}

export interface WelcomeEmailInput {
  recipientEmail: string;
  recipientName: string;
  userNumber: string;
  username: string;
  setupPasswordUrl: string;
}

export async function sendAccountPasswordRecoveryEmail(input: { recipientEmail: string; recipientName: string; recoveryUrl: string }): Promise<void> {
  const recipientName = escapeHtml(input.recipientName);
  const recoveryUrl = escapeHtml(input.recoveryUrl);
  await sendEmail("password_recovery", {
    from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL }, to: input.recipientEmail,
    subject: "Reset your IDMC account password",
    text: `Dear ${input.recipientName},\n\nA password reset was requested for your IDMC account. Use this secure, time-limited link to choose a new password: ${input.recoveryUrl}\n\nIf you did not request this, ignore this message.\n\nIDMC ICT Office`,
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#35111c"><div style="max-width:620px;margin:24px auto;padding:24px;border-top:6px solid #68172a;background:#fff"><h2 style="color:#68172a">Reset your IDMC password</h2><p>Dear ${recipientName},</p><p>A password reset was requested for your IDMC account.</p><p><a href="${recoveryUrl}" style="display:inline-block;padding:12px 18px;background:#68172a;color:#fff;text-decoration:none">Choose a new password</a></p><p>This secure link expires. If you did not request a reset, ignore this email.</p><p>IDMC ICT Office</p></div></body></html>`,
  });
}

export async function sendStudentPortalAccessEmail(input: { recipientEmail: string; recipientName: string; studentNumber: string }): Promise<void> {
  const recipientName = escapeHtml(input.recipientName);
  const studentNumber = escapeHtml(input.studentNumber);
  const loginUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/login.html`;
  await sendEmail("student_account_created", {
    from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL },
    to: input.recipientEmail,
    subject: "Your IDMC Student Portal account is ready",
    text: `Dear ${input.recipientName},\n\nYour IDMC Student Portal account is ready. Sign in using your Student Number as both your login name and temporary password, then choose a new password when prompted.\n\nStudent Number: ${input.studentNumber}\nStudent Portal sign in: ${loginUrl}\n\nIf you have already changed your temporary password, use your current password. If you did not expect this account, contact the IDMC Registry.`,
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#35111c"><div style="max-width:620px;margin:24px auto;padding:24px;border-top:6px solid #68172a;background:#fff"><h2 style="color:#68172a">Student Portal access is ready</h2><p>Dear ${recipientName},</p><p>Your IDMC Student Portal account is ready. Sign in using your Student Number as both your login name and temporary password, then choose a new password when prompted.</p><p>Student Number: <strong>${studentNumber}</strong></p><p><a href="${loginUrl}" style="display:inline-block;padding:12px 18px;background:#68172a;color:#fff;text-decoration:none">Open Student Portal sign in</a></p><p>If you have already changed your temporary password, use your current password. If you did not expect this account, contact the IDMC Registry.</p></div></body></html>`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function verifyEmailConnection(): Promise<void> {
  try {
    await getTransporter().verify();
    logInfo("email_smtp_connection_verified", { host: env.SMTP_HOST, port: env.SMTP_PORT });
  } catch (error) {
    const details = smtpErrorDetails(error);
    logError("email_smtp_connection_failed", details);
    throw new EmailTransportError(details);
  }
}

export async function sendSmtpTestEmail(recipientEmail: string): Promise<void> {
  await sendEmail("smtp_test", {
    from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL },
    to: recipientEmail,
    subject: "IDMC email delivery test",
    text: "This is an authorized test message to verify the IDMC email configuration. No action is required.",
  });
}

export async function sendAdmissionOfferEmail(input: { recipientEmail: string; recipientName: string; offerNumber: string; programmeName: string; expiryDate: string | null }): Promise<void> {
  const recipientName = escapeHtml(input.recipientName);
  const offerNumber = escapeHtml(input.offerNumber);
  const programmeName = escapeHtml(input.programmeName);
  const expiry = input.expiryDate ? new Date(`${input.expiryDate}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC" }) : "as shown in your portal";
  const portalUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/applicant-portal.html`;
  await sendEmail("admission_offer", {
    from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL },
    to: input.recipientEmail,
    subject: "IDMC admission offer available",
    text: `Dear ${input.recipientName},\n\nIDMC has issued admission offer ${input.offerNumber} for ${input.programmeName}. Please sign in to the applicant portal to review and accept it by ${expiry}.\n\n${portalUrl}\n\nRegards,\nIDMC Admissions Office`,
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#35111c"><div style="max-width:620px;margin:24px auto;padding:24px;border-top:6px solid #68172a;background:#fff"><h2 style="color:#68172a">IDMC Admission Offer</h2><p>Dear ${recipientName},</p><p>IDMC has issued an admission offer for <strong>${programmeName}</strong>.</p><p>Offer number: <strong>${offerNumber}</strong><br>Please respond by <strong>${escapeHtml(expiry)}</strong>.</p><p><a href="${portalUrl}" style="display:inline-block;padding:12px 18px;background:#68172a;color:#fff;text-decoration:none">Review offer in applicant portal</a></p><p>Regards,<br>IDMC Admissions Office</p></div></body></html>`
  });
}

export async function sendApplicationReceivedEmail(input: { recipientEmail: string; recipientName: string; applicationNumber: string; programmeName: string }): Promise<void> {
  const recipientName = escapeHtml(input.recipientName);
  const applicationNumber = escapeHtml(input.applicationNumber);
  const programmeName = escapeHtml(input.programmeName);
  await sendEmail("application_received", {
    from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL },
    to: input.recipientEmail,
    subject: `IDMC application received · ${input.applicationNumber}`,
    text: `Dear ${input.recipientName},\n\nAdmissions has submitted an application on your behalf. Application number: ${input.applicationNumber}. Programme choice: ${input.programmeName}.\n\nYour application is awaiting Admissions review. Keep this application number for enquiries. You do not need an applicant portal login to have this application recorded.\n\nRegards,\nIDMC Admissions Office`,
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#35111c"><div style="max-width:620px;margin:24px auto;padding:24px;border-top:6px solid #68172a;background:#fff"><h2 style="color:#68172a">Application received</h2><p>Dear ${recipientName},</p><p>Admissions has submitted an application on your behalf. It is now awaiting Admissions review.</p><p>Application number: <strong>${applicationNumber}</strong><br>Programme choice: <strong>${programmeName}</strong></p><p>Keep your application number for enquiries. No applicant portal login was required to record this application.</p><p>Regards,<br>IDMC Admissions Office</p></div></body></html>`
  });
}

export async function sendWelcomeEmail(
  input: WelcomeEmailInput
): Promise<void> {
  const recipientName = escapeHtml(input.recipientName);
  const userNumber = escapeHtml(input.userNumber);
  const username = escapeHtml(input.username);
  const setupPasswordUrl = input.setupPasswordUrl;

  const mail: SendMailOptions = {
    from: {
      name: env.SMTP_FROM_NAME,
      address: env.SMTP_FROM_EMAIL,
    },

    to: input.recipientEmail,

    subject:
      "Welcome to IDMC Integrated Management Information System",

    text: `
Welcome to IDMC Integrated Management Information System.

Dear ${input.recipientName},

Your IDMC system account has been created successfully.

User Number:
${input.userNumber}

Username:
${input.username}

For security, no password is included in this email.

Please use the secure link below to set your password:

${input.setupPasswordUrl}

After setting your password, you can sign in to the IDMC system.

If you did not expect this account, please contact the IDMC system administrator.

Regards,
IDMC System Administration
`,

    html: `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IDMC Welcome</title>
</head>

<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="center" style="padding:30px 15px;">

<table
    width="600"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;"
>

<tr>
<td style="background:#7a0019;color:#ffffff;padding:28px;text-align:center;">

<h1 style="margin:0;font-size:24px;">
IDMC iMIS
</h1>

<p style="margin:8px 0 0;font-size:14px;">
Integrated Management Information System
</p>

</td>
</tr>

<tr>
<td style="padding:35px;">

<h2 style="color:#222;margin-top:0;">
Welcome, ${recipientName}
</h2>

<p style="color:#444;line-height:1.6;">
Your IDMC system account has been created successfully.
</p>

<table
    width="100%"
    cellpadding="10"
    cellspacing="0"
    border="0"
    style="background:#f8f8f8;border:1px solid #e5e5e5;"
>

<tr>
<td>
<strong>User Number</strong>
</td>
<td>
${userNumber}
</td>
</tr>

<tr>
<td>
<strong>Username</strong>
</td>
<td>
${username}
</td>
</tr>

</table>

<p style="color:#444;line-height:1.6;margin-top:25px;">
For your security, your password is not included in this email.
Please use the button below to create your password.
</p>

<p style="text-align:center;margin:30px 0;">

<a
href="${setupPasswordUrl}"
style="
display:inline-block;
background:#7a0019;
color:#ffffff;
text-decoration:none;
padding:14px 25px;
border-radius:5px;
font-weight:bold;
"
>
Set My Password
</a>

</p>

<p style="font-size:13px;color:#777;line-height:1.6;">
If the button does not work, copy and paste the following address into
your browser:
</p>

<p style="font-size:12px;word-break:break-all;color:#555;">
${setupPasswordUrl}
</p>

<p style="font-size:13px;color:#777;line-height:1.6;">
If you did not expect this account, please contact the IDMC system
administrator immediately.
</p>

</td>
</tr>

<tr>
<td style="background:#f7f7f7;padding:20px;text-align:center;">

<p style="margin:0;font-size:12px;color:#777;">
IDMC System Administration
</p>

</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
`,
  };

  await sendEmail("welcome", mail);
}
