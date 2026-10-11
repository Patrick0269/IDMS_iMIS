#!/usr/bin/env node

// Run from apps/backend with: node --import tsx ./scripts/test-smtp.mjs recipient@example.com
const recipient = process.argv[2]?.trim();
if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
  console.error("Usage: node --import tsx ./scripts/test-smtp.mjs <recipient-email>");
  process.exit(2);
}

try {
  const { verifyEmailConnection, sendSmtpTestEmail } = await import("../src/services/email.service.ts");
  await verifyEmailConnection();
  console.log("SMTP authentication succeeded; sending one test email.");
  await sendSmtpTestEmail(recipient);
  console.log("SMTP accepted the test email. Check Inbox and Spam/Junk for final delivery.");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "SMTP_TEST_FAILED";
  const responseCode = error && typeof error === "object" && "responseCode" in error && typeof error.responseCode === "number"
    ? ` (${error.responseCode})`
    : "";
  console.error(`SMTP test failed: ${code}${responseCode}. No credentials were printed.`);
  process.exitCode = 1;
}
