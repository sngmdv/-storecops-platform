'use strict';

/**
 * Email Template Engine — branded HTML templates for all transactional emails.
 *
 * Provides consistent, professional email templates for:
 *   - Welcome / onboarding
 *   - Invoice / payment receipt
 *   - Trial expiry warning
 *   - Subscription renewal
 *   - Plan upgrade/downgrade confirmation
 *   - Churn risk alert (admin)
 *   - SEO report delivery
 *   - Competitor alert
 *   - Password reset
 *   - 2FA enabled/disabled
 *
 * All templates use inline CSS for maximum email client compatibility.
 * Brand colors: #667eea (primary), #764ba2 (accent), #1a1a2e (text).
 */

const BRAND = {
  primary: '#667eea',
  accent: '#764ba2',
  text: '#1a1a2e',
  muted: '#666666',
  light: '#f8f9fa',
  border: '#e2e8f0',
  success: '#38a169',
  warning: '#d69e2e',
  danger: '#e53e3e',
  fontFamily: '-apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif',
};

function layout(title, content, { footer = '', preheader = '', } = {},) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:${BRAND.fontFamily};background:#f0f2f5;">
  ${preheader ? `<div style="display:none;font-size:1px;color:#f0f2f5;line-height:1px;">${preheader}</div>` : ''}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:20px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:linear-gradient(135deg,${BRAND.primary},${BRAND.accent});padding:30px;border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="color:white;margin:0;font-size:24px;font-weight:700;">${title}</h1>
            <p style="color:rgba(255,255,255,0.7);margin:8px 0 0;font-size:13px;">Storecops Growth Platform</p>
          </td>
        </tr>
        <tr>
          <td style="padding:30px;background:white;border-radius:0 0 12px 12px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 30px;text-align:center;">
            <p style="font-size:12px;color:${BRAND.muted};margin:0;">
              ${footer || `&copy; ${new Date().getFullYear()} Storecops. All rights reserved.`}
              <br/>Need help? <a href="{{support_url}}" style="color:${BRAND.primary};">Contact support</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(text, url, { color = BRAND.primary, } = {},) {
  return `<p style="text-align:center;margin:25px 0;">
    <a href="${url}" style="background:${color};color:white;padding:12px 30px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">${text}</a>
  </p>`;
}

function infoBox(text, { borderColor = BRAND.primary, } = {},) {
  return `<div style="background:${BRAND.light};padding:15px 20px;border-radius:8px;border-left:4px solid ${borderColor};margin:15px 0;">
    <p style="font-size:14px;color:${BRAND.text};margin:0;">${text}</p>
  </div>`;
}

function statRow(label, value, { color = BRAND.text, } = {},) {
  return `<tr>
    <td style="padding:8px 0;font-size:14px;color:${BRAND.muted};border-bottom:1px solid ${BRAND.border};">${label}</td>
    <td style="padding:8px 0;font-size:14px;color:${color};font-weight:600;text-align:right;border-bottom:1px solid ${BRAND.border};">${value}</td>
  </tr>`;
}

function createEmailTemplates({ config, } = {},) {
  const publicUrl = config?.publicUrl || 'http://localhost:4000';
  const supportUrl = `${publicUrl}/support`;

  return {
    /** Welcome email on signup. */
    welcome({ name, storeName, storeId, },) {
      const displayName = name || 'there';
      const store = storeName || storeId || 'your store';
      return layout(
        'Welcome to Storecops!',
        `<p style="font-size:16px;">Hi ${displayName},</p>
        <p style="font-size:16px;">Your store <strong>${store}</strong> is now connected to Storecops — the AI-powered growth platform for e-commerce brands.</p>
        <h3 style="color:${BRAND.primary};">Here's what you can do right now:</h3>
        <ul style="font-size:14px;line-height:2;">
          <li>View live orders and stock levels in real time</li>
          <li>Get AI-powered product and pricing recommendations</li>
          <li>Set up automated cart recovery campaigns</li>
          <li>Track competitor pricing and market trends</li>
          <li>Run a full SEO audit of your store</li>
        </ul>
        ${button('Open Your Dashboard', `${publicUrl}/app`,)}`,
        { preheader: `Welcome to Storecops, ${displayName}!`, },
      );
    },

    /** Invoice / payment receipt. */
    invoice({ customerName, invoiceNumber, amount, currency, date, planName, gstAmount, status, },) {
      const curr = (currency || 'USD').toUpperCase();
      const symbol = curr === 'INR' ? '₹' : '$';
      const fmtAmount = `${symbol}${Number(amount || 0,).toFixed(2,)}`;
      return layout(
        status === 'refunded' ? 'Refund Processed' : 'Payment Receipt',
        `<p style="font-size:16px;">Hi ${customerName || 'there'},</p>
        <p style="font-size:16px;">${status === 'refunded' ? 'A refund has been processed for your account.' : 'Thank you for your payment.'} Here are the details:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
          ${statRow('Invoice Number', `#${invoiceNumber || 'N/A'}`,)}
          ${statRow('Date', date || new Date().toISOString().split('T',)[0],)}
          ${statRow('Plan', planName || 'Growth',)}
          ${statRow('Amount', fmtAmount, { color: BRAND.success, },)}
          ${gstAmount ? statRow('GST (18%)', `${symbol}${Number(gstAmount,).toFixed(2,)}`,) : ''}
          ${statRow('Status', status || 'Paid', { color: BRAND.success, },)}
        </table>
        ${infoBox(status === 'refunded' ? 'The refund will appear in your account within 5-7 business days.' : 'Your subscription is active. You can manage billing from your dashboard.',)}
        ${button('View Billing Details', `${publicUrl}/app#/settings`,)}`,
        { preheader: `Invoice #${invoiceNumber} — ${fmtAmount}`, },
      );
    },

    /** Trial expiry warning. */
    trialExpiry({ name, storeName, daysLeft, planName, },) {
      const displayName = name || 'there';
      const urgency = daysLeft <= 1 ? 'today' : `in ${daysLeft} days`;
      return layout(
        'Your Trial Is Expiring Soon',
        `<p style="font-size:16px;">Hi ${displayName},</p>
        <p style="font-size:16px;">Your Storecops trial for <strong>${storeName || 'your store'}</strong> expires <strong>${urgency}</strong>.</p>
        ${infoBox(`Don't lose access to your growth data, automations, and competitor intelligence. Upgrade to <strong>${planName || 'Growth'}</strong> to keep growing.`, { borderColor: BRAND.warning, },)}
        <h3 style="color:${BRAND.primary};">What you'll keep:</h3>
        <ul style="font-size:14px;line-height:2;">
          <li>Real-time order monitoring & inventory tracking</li>
          <li>AI-powered recommendations & churn scoring</li>
          <li>Competitor price monitoring</li>
          <li>Automated campaigns & cart recovery</li>
          <li>Full SEO audit & auto-fix</li>
        </ul>
        ${button('Upgrade Now', `${publicUrl}/app#/settings`, { color: BRAND.accent, },)}`,
        { preheader: `Your trial expires ${urgency}. Upgrade to keep growing!`, },
      );
    },

    /** Subscription renewal confirmation. */
    subscriptionRenewal({ name, storeName, planName, amount, currency, nextBillingDate, },) {
      const curr = (currency || 'USD').toUpperCase();
      const symbol = curr === 'INR' ? '₹' : '$';
      return layout(
        'Subscription Renewed',
        `<p style="font-size:16px;">Hi ${name || 'there'},</p>
        <p style="font-size:16px;">Your <strong>${planName || 'Growth'}</strong> plan for <strong>${storeName || 'your store'}</strong> has been renewed.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
          ${statRow('Plan', planName || 'Growth',)}
          ${statRow('Amount', `${symbol}${Number(amount || 0,).toFixed(2,)}`,)}
          ${statRow('Next Billing', nextBillingDate || 'N/A',)}
        </table>
        ${infoBox('Your subscription is active. You can change plans or cancel anytime from your dashboard.',)}
        ${button('Manage Subscription', `${publicUrl}/app#/settings`,)}`,
        { preheader: 'Your subscription has been renewed successfully.', },
      );
    },

    /** Plan change confirmation. */
    planChange({ name, storeName, fromPlan, toPlan, effectiveDate, },) {
      return layout(
        'Plan Changed',
        `<p style="font-size:16px;">Hi ${name || 'there'},</p>
        <p style="font-size:16px;">Your plan for <strong>${storeName || 'your store'}</strong> has been changed:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
          ${statRow('From', fromPlan || 'Free',)}
          ${statRow('To', toPlan || 'Growth', { color: BRAND.success, },)}
          ${statRow('Effective', effectiveDate || 'Immediately',)}
        </table>
        ${button('View Your Plan', `${publicUrl}/app#/settings`,)}`,
        { preheader: `Your plan has been changed from ${fromPlan} to ${toPlan}.`, },
      );
    },

    /** SEO report delivery. */
    seoReport({ storeUrl, score, grade, topIssues, },) {
      const scoreColor = score >= 70 ? BRAND.success : score >= 50 ? BRAND.warning : BRAND.danger;
      return layout(
        'Your Store Health Report',
        `<p style="font-size:16px;">We've analyzed <strong>${storeUrl}</strong>:</p>
        <div style="text-align:center;margin:30px 0;">
          <div style="font-size:48px;font-weight:bold;color:${scoreColor};">${score}<span style="font-size:24px;">/100</span></div>
          <div style="font-size:14px;color:${BRAND.muted};">Grade: <strong>${grade}</strong></div>
        </div>
        ${topIssues?.length ? `<h3 style="color:${BRAND.primary};">Top Issues Found:</h3>
        <ul style="font-size:14px;line-height:2;">${topIssues.map((i,) => `<li>${typeof i === 'string' ? i : i.title || i.message}</li>`,).join('',)}</ul>` : ''}
        ${infoBox('Storecops can fix all of these issues automatically with one click.', { borderColor: BRAND.success, },)}
        ${button('View Full Report', `${publicUrl}/app#/seo`,)}`,
        { preheader: `Store health score: ${score}/100 — Grade: ${grade}`, },
      );
    },

    /** Competitor alert. */
    competitorAlert({ storeName, competitorName, changeType, details, },) {
      return layout(
        'Competitor Alert',
        `<p style="font-size:16px;">Hi from <strong>${storeName || 'Storecops'}</strong>,</p>
        <p style="font-size:16px;">A competitor has made a move:</p>
        ${infoBox(`<strong>${competitorName || 'Competitor'}</strong>: ${changeType || 'price change'}<br/>${details || ''}`, { borderColor: BRAND.warning, },)}
        ${button('View Competitor Radar', `${publicUrl}/app#/competitors`,)}`,
        { preheader: `${competitorName} has made a move — check it out.`, },
      );
    },

    /** Password reset. */
    passwordReset({ name, resetUrl, expiresIn, },) {
      return layout(
        'Reset Your Password',
        `<p style="font-size:16px;">Hi ${name || 'there'},</p>
        <p style="font-size:16px;">We received a request to reset your password. Click below to create a new one:</p>
        ${button('Reset Password', resetUrl || '#',)}
        ${infoBox(`This link expires in ${expiresIn || '1 hour'}. If you didn't request this, you can safely ignore this email.`, { borderColor: BRAND.muted, },)}`,
        { preheader: 'Reset your Storecops password.', },
      );
    },

    /** 2FA enabled confirmation. */
    twoFactorEnabled({ name, },) {
      return layout(
        'Two-Factor Authentication Enabled',
        `<p style="font-size:16px;">Hi ${name || 'there'},</p>
        <p style="font-size:16px;">Two-factor authentication has been enabled on your Storecops account.</p>
        ${infoBox('Your account is now more secure. You\'ll need your authenticator app when logging in.', { borderColor: BRAND.success, },)}
        <p style="font-size:13px;color:${BRAND.muted};">If you didn't enable this, contact support immediately.</p>`,
        { preheader: '2FA has been enabled on your account.', },
      );
    },

    /** Data export ready. */
    dataExportReady({ name, storeName, recordCount, },) {
      return layout(
        'Your Data Export Is Ready',
        `<p style="font-size:16px;">Hi ${name || 'there'},</p>
        <p style="font-size:16px;">Your data export for <strong>${storeName || 'your store'}</strong> is ready for download.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
          ${statRow('Total Records', String(recordCount || 0,),)}
          ${statRow('Format', 'JSON',)}
        </table>
        ${button('Download Export', `${publicUrl}/app#/settings`,)}`,
        { preheader: `Your data export (${recordCount || 0} records) is ready.`, },
      );
    },
  };
}

module.exports = { createEmailTemplates, BRAND, layout, button, infoBox, };
