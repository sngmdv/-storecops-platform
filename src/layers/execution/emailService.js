'use strict';

/**
 * Pluggable Email Adapter
 *
 * Sends transactional emails (welcome, onboarding, alerts).
 * Ships with a "console" provider for dev/test and a "resend"
 * provider for production. Swap via EMAIL_PROVIDER env var.
 *
 * Adding a new provider (SendGrid, SES, etc.) is one function:
 *   providers.sendgrid = async ({ to, subject, html }) => { ... }
 */

const crypto = require('crypto',);

/** Mask an email for safe logging: show first char + domain initial. */
function maskEmail(email,) {
  if (!email || typeof email !== 'string') return '***';
  const [local, domain,] = email.split('@',);
  if (!domain) return '***';
  return `${local.charAt(0,)}***@${domain.charAt(0,)}***`;
}

const PROVIDERS = {
  /**
   * Console provider: logs the email to stdout. Default in dev/test.
   */
  console: async ({ to, subject, html, from, attachments, },) => {
    const recipients = Array.isArray(to,) ? to.join(', ',) : to;
    console.log(`[EMAIL] to=${maskEmail(recipients,)} subject="${(subject || '').slice(0, 60,)}" from=${from || 'noreply@storecops.com'}`,);
    if (attachments?.length) console.log(`[EMAIL] attachments: ${attachments.length} file(s) (${attachments.map((a,) => a.filename,).join(', ',)})`,);
    if (process.env.DEBUG_EMAIL) console.log(`[EMAIL] body: ${(html || '').slice(0, 200,)}...`,);
    return { delivered: true, provider: 'console', to: recipients, subject, attachments: attachments?.length || 0, };
  },

  /**
   * Resend provider: sends via the Resend API (https://resend.com).
   * Requires RESEND_API_KEY env var.
   */
  resend: async ({ to, subject, html, from, attachments, },) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not configured.',);

    const sender = from || process.env.EMAIL_FROM || 'noreply@storecops.com';
    const payload = { from, to: Array.isArray(to,) ? to : [to,], subject, html, };

    // Resend supports base64 attachments
    if (attachments?.length) {
      payload.attachments = attachments.map((a,) => ({
        filename: a.filename,
        content: a.content.toString('base64',),
      }),);
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload,),
      signal: AbortSignal.timeout(15000,),
    },);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}),);
      throw new Error(`Resend API error (${res.status}): ${JSON.stringify(body,)}`,);
    }

    const data = await res.json();
    return { delivered: true, provider: 'resend', id: data.id, to, subject, attachments: attachments?.length || 0, };
  },

  /**
   * SMTP provider: sends via SMTP using Node's built-in net/tls modules.
   * Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS env vars.
   * Optional: SMTP_SECURE=true for TLS on connect (port 465).
   */
  smtp: async ({ to, subject, html, from, },) => {
    const net = require('net',);
    const tls = require('tls',);

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = process.env.SMTP_SECURE === 'true';

    if (!host) throw new Error('SMTP_HOST is not configured.',);
    if (!user || !pass) throw new Error('SMTP_USER and SMTP_PASS are required.',);

    const recipients = Array.isArray(to,) ? to : [to,];
    const sender = from || process.env.EMAIL_FROM || 'noreply@storecops.com';

    /**
     * Minimal SMTP client — sends one email and closes.
     */
    function smtpSend() {
      return new Promise((resolve, reject,) => {
        const socket = secure
          ? tls.connect({ host, port: port || 465, },)
          : net.createConnection({ host, port, },);

        let buffer = '';
        let step = 0;
        let rejected = false;

        const commands = [
          `EHLO storecops.local`,
          secure ? null : `STARTTLS`,
          `MAIL FROM:<${sender}>`,
          ...recipients.map((r) => `RCPT TO:<${r}>`),
          `DATA`,
          `From: ${sender}`,
          `To: ${recipients.join(', ')}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset=UTF-8`,
          ``,
          html || '',
          `.`,
          `QUIT`,
        ].filter(Boolean,);

        function sendNext() {
          if (step < commands.length) {
            socket.write(commands[step] + '\r\n',);
            step++;
          }
        }

        socket.setEncoding('ascii',);
        socket.setTimeout(15000,);

        socket.on('connect', () => { /* wait for banner */ },);

        socket.on('data', (data,) => {
          buffer += data;
          const lines = buffer.split('\r\n',);
          buffer = lines.pop(); /* keep incomplete line */

          for (const line of lines) {
            const code = parseInt(line.slice(0, 3,), 10,);

            if (code >= 400 && !rejected) {
              rejected = true;
              socket.end();
              reject(new Error(`SMTP error ${code}: ${line}`,),);
              return;
            }

            if (line.startsWith('220 ') || line.startsWith('250 ') || line.startsWith('354 ') || line.match(/^2\d{2}-/)) {
              if (step === 0) {
                /* banner received, check for STARTTLS needed */
                sendNext();
              } else if (line.match(/^2\d{2}\s/) || line.match(/^2\d{2}-.*\r?\n2\d{2}\s/)) {
                /* multiline reply complete */
                sendNext();
              }
            }
          }
        },);

        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('SMTP connection timed out.',),);
        },);

        socket.on('error', (err,) => {
          reject(err,);
        },);

        socket.on('end', () => {
          if (!rejected) resolve({ delivered: true, provider: 'smtp', to: recipients, subject, });
        },);

        sendNext();
      },);
    }

    await smtpSend();
    return { delivered: true, provider: 'smtp', to: recipients, subject, };
  },
};

function createEmailService({ config, },) {
  const providerName = config?.providers?.email || 'console';

  return {
    providerName,

    /**
     * Send an email through the configured provider.
     * Supports optional attachments array: [{ filename, content (Buffer) }]
     */
    async send({ to, subject, html, from, attachments, },) {
      if (!to || !subject) throw new Error('to and subject are required.',);
      const provider = PROVIDERS[providerName] || PROVIDERS.console;
      try {
        return await provider({ to, subject, html, from, attachments, },);
      } catch (error) {
        console.error(`[EMAIL] send failed: ${error.message}`,);
        return { delivered: false, error: error.message, to, subject, };
      }
    },

    /**
     * Welcome email sent on signup.
     */
    async sendWelcome({ email, name, storeName, storeId, },) {
      // Use the emailTemplates module for consistent, branded templates
      const { createEmailTemplates, } = require('./emailTemplates',);
      const templates = createEmailTemplates({ config: this.config, },);
      const html = templates.welcome({ name, storeName, storeId, },);
      return this.send({
        to: email,
        subject: `Welcome to Storecops, ${name || 'there'}!`,
        html,
      },);
    },

    /**
     * Onboarding nudge: sent if a store hasn't completed setup within 24h.
     */
    async sendOnboardingNudge({ email, name, storeName, onboardingState, },) {
      const displayName = name || 'there';
      const missing = [];
      if (!onboardingState?.store_connected) missing.push('Connect your store',);
      if (!onboardingState?.tracking_active) missing.push('Activate tracking',);
      if (!onboardingState?.billing_approved) missing.push('Choose a plan',);

      if (!missing.length) return { skipped: true, reason: 'onboarding complete', };

      const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a2e;">
  <h2 style="color: #667eea;">Complete your setup, ${displayName}</h2>
  <p>Your store <strong>${storeName || ''}</strong> is almost ready. Here's what's left:</p>
  <ul style="font-size: 14px; line-height: 2;">
    ${missing.map((m,) => `<li>${m}</li>`,).join('',)}
  </ul>
  <p style="text-align: center; margin: 30px 0;">
    <a href="#" style="background: #667eea; color: white; padding: 12px 30px; border-radius: 8px; text-decoration: none; font-weight: 600;">Finish Setup</a>
  </p>
</body>
</html>`;

      return this.send({
        to: email,
        subject: 'Complete your Storecops setup',
        html,
      },);
    },
  };
}

module.exports = { createEmailService, PROVIDERS, };
