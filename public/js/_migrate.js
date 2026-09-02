const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'app.js');
let code = fs.readFileSync(file, 'utf8');
const original = code;

// Helper: replace within a line range
function replaceInRange(startLine, endLine, replacements) {
  const lines = code.split('\n');
  for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
    for (const [from, to] of replacements) {
      lines[i] = lines[i].split(from).join(to);
    }
  }
  code = lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 1. renderAutomations (lines 1488-1540)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(1488, 1540, [
  [`<div class="grid grid-2">`, `<div class="b-header"><div><h2>Automations</h2><p>Manage automation rules and queued actions</p></div></div>\n      <div class="b-grid-2">`],
  [`<div class="card">`, `<div class="b-card">`],
  [`<span class="pill pill-cyan">`, `<span class="b-badge cyan">`],
  [`class="muted"`, `style="color:var(--muted)"`],
  [`<div class="card-title-row">`, `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">`],
  [`<div class="alert-item amber">`, `<div class="b-list-item" style="animation-delay:0.05s;border-left:3px solid var(--amber);padding:12px 16px;background:rgba(245,158,11,0.05);border-radius:var(--radius-sm)">`],
  [`<div class="empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
]);

// ═══════════════════════════════════════════════════════════════════
// 2. renderMessages (lines 1543-1668)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(1543, 1668, [
  [`<span class="pill pill-green">`, `<span class="b-badge green">`],
  [`<span class="pill pill-amber">`, `<span class="b-badge amber">`],
  [`<span class="pill pill-cyan">`, `<span class="b-badge cyan">`],
  [`<span class="pill pill-red">`, `<span class="b-badge red">`],
  [`<span class="pill pill-violet">`, `<span class="b-badge purple">`],
  [`class="muted"`, `style="color:var(--muted)"`],
  [`<div class="grid grid-2">`, `<div class="b-header"><div><h2>Messages</h2><p>Delivery status, channels, and message history</p></div></div>\n      <div class="b-grid-2">`],
  [`<div class="grid grid-3 section-gap">`, `<div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="grid grid-2 section-gap">`, `<div class="b-grid-2" style="margin-bottom:24px">`],
  [`<div class="card"`, `<div class="b-card"`],
  [`<div class="card-title-row">`, `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">`],
  [`<div class="card section-gap">`, `<div class="b-card" style="margin-bottom:24px">`],
  [`<div class="empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
  [`class="a-table"`, `class="b-table"`],
]);

// ═══════════════════════════════════════════════════════════════════
// 3. renderBrandKeywords (lines 2193-2270ish)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(2193, 2270, [
  [`<div class="card">`, `<div class="b-header"><div><h2>Brand Keywords</h2><p>Monitor brand mentions, sentiment, and search visibility</p></div></div>\n      <div class="b-card">`],
  [`<span class="pill pill-cyan"`, `<span class="b-badge cyan"`],
  [`class="muted"`, `style="color:var(--muted)"`],
]);

// ═══════════════════════════════════════════════════════════════════
// 4. renderReports (lines 2554-2594)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(2554, 2594, [
  [`<div class="grid grid-4">`, `<div class="b-header"><div><h2>Reports</h2><p>ROI, attribution, maturity, and weekly digest</p></div></div>\n      <div class="b-grid-4" style="margin-bottom:24px">`],
  [`<div class="grid grid-2 section-gap">`, `<div class="b-grid-2" style="margin-bottom:24px">`],
  [`<div class="card"><h3>ROI</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.05s"><h3>ROI</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<div class="card"><h3>Attributed revenue</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.1s"><h3>Attributed revenue</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Maturity</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.15s"><h3>Maturity</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Sentiment</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.2s"><h3>Sentiment</h3><div class="b-stat-value">`],
]);

// For renderReports chart cards, use line-specific approach
const reportLines = code.split('\n');
for (let i = 2573; i <= 2583; i++) {
  if (reportLines[i]) {
    reportLines[i] = reportLines[i]
      .replace(/<div class="card"><h3>\$\{icon\("dollar"\)\}/, '<div class="b-card" style="animation-delay:0.25s"><h3>${icon("dollar")}')
      .replace(/<div class="card"><h3>\$\{icon\("clipboard"\)\}/, '<div class="b-card" style="animation-delay:0.3s"><h3>${icon("clipboard")}')
      .replace(/<div class="card"><h3>/g, '<div class="b-card"><h3>');
  }
}
code = reportLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 5. renderSettings (lines 2597-2678)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(2597, 2678, [
  [`<div class="grid grid-2">`, `<div class="b-header"><div><h2>Settings</h2><p>Connection, GDPR, and platform connectors</p></div></div>\n      <div class="b-grid-2">`],
  [`<div class="card"><h3>Connection</h3>`, `<div class="b-card"><h3>Connection</h3>`],
  [`<div class="card"><h3>GDPR`, `<div class="b-card"><h3>GDPR`],
  [`class="muted"`, `style="color:var(--muted)"`],
  [`<div class="card section-gap"><h3>${icon("plug")}`, `<div class="b-card" style="margin-bottom:24px"><h3>${icon("plug")}`],
  [`<div class="card section-gap"><h3>Platform architecture</h3>`, `<div class="b-card" style="margin-bottom:24px"><h3>Platform architecture</h3>`],
  [`<div id="gdpr-result" class="section-gap"></div>`, `<div id="gdpr-result" style="margin-bottom:24px"></div>`],
]);

// Handle the nested grid grid-2 inside settings connectors section
const settingsLines = code.split('\n');
for (let i = 2620; i <= 2640; i++) {
  if (settingsLines[i]) {
    settingsLines[i] = settingsLines[i]
      .replace(/<div class="grid grid-2">/g, '<div class="b-grid-2">');
  }
}
code = settingsLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 6. renderConnect (lines 2703-2883)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(2703, 2883, [
  [`<div class="card"><h3>Connection status</h3>`, `<div class="b-header"><div><h2>Connect Store</h2><p>Connect your store platform to start syncing data</p></div></div>\n      <div class="b-card"><h3>Connection status</h3>`],
  [`<div id="connect-result" class="section-gap"></div>`, `<div id="connect-result" style="margin-bottom:24px"></div>`],
  [`<div class="grid grid-2 section-gap">`, `<div class="b-grid-2" style="margin-bottom:24px">`],
  [`class="muted"`, `style="color:var(--muted)"`],
  [`<div class="alert-item green">`, `<div class="b-list-item" style="animation-delay:0.05s;border-left:3px solid var(--green);padding:12px 16px;background:rgba(8,144,108,0.05);border-radius:var(--radius-sm)">`],
  [`<div class="alert-item red">`, `<div class="b-list-item" style="animation-delay:0.05s;border-left:3px solid var(--red);padding:12px 16px;background:rgba(239,68,68,0.05);border-radius:var(--radius-sm)">`],
  [`<div class="alert-item">`, `<div class="b-list-item" style="animation-delay:0.05s">`],
]);

// Handle connect's inner cards
const connectLines = code.split('\n');
for (let i = 2727; i <= 2786; i++) {
  if (connectLines[i]) {
    connectLines[i] = connectLines[i]
      .replace(/<div class="card"><h3>/g, '<div class="b-card"><h3>')
      .replace(/<div class="alert-item amber"/g, '<div class="b-list-item" style="animation-delay:0.05s;border-left:3px solid var(--amber);padding:12px 16px;background:rgba(245,158,11,0.05);border-radius:var(--radius-sm)"');
  }
}
code = connectLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 7. renderOnboarding (lines 2888-3033)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(2888, 3033, [
  [`<div class="grid grid-3 section-gap" style="margin-bottom:24px">`, `<div class="b-header"><div><h2>Onboarding</h2><p>Set up your store and unlock the full power of Storecops</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card" style="text-align:center;padding:24px">`, `<div class="b-card" style="text-align:center;padding:24px;animation-delay:0.05s">`],
  [`<div class="kpi-value">`, `<div class="b-stat-value">`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<span class="pill pill-green">`, `<span class="b-badge green">`],
  [`<span class="pill pill-gray">`, `<span class="b-badge gray">`],
  [`<p class="muted" style="margin-bottom:16px">Follow`, `<p style="color:var(--muted);margin-bottom:16px">Follow`],
]);

// Handle onboarding inner cards with animation delays
const onboardLines = code.split('\n');
for (let i = 2910; i <= 2970; i++) {
  if (onboardLines[i]) {
    // The "⚡" card
    if (onboardLines[i].includes('font-size:48px;margin-bottom:8px">⚡')) {
      onboardLines[i] = onboardLines[i].replace(/<div class="card" style="text-align:center;padding:24px">/, '<div class="b-card" style="text-align:center;padding:24px;animation-delay:0.1s">');
    }
    // The "💰" card
    if (onboardLines[i].includes('font-size:48px;margin-bottom:8px">💰')) {
      onboardLines[i] = onboardLines[i].replace(/<div class="card" style="text-align:center;padding:24px">/, '<div class="b-card" style="text-align:center;padding:24px;animation-delay:0.15s">');
    }
    // The wizard card
    if (onboardLines[i].includes('Setup Wizard')) {
      onboardLines[i] = onboardLines[i].replace(/<div class="card">/, '<div class="b-card" style="animation-delay:0.2s">');
    }
  }
}
code = onboardLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 8. renderRecommendations (lines 3397-3446)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3397, 3446, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Recommendations</h2><p>Product recommendation placements and analytics</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Products tracked</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.05s"><h3>Products tracked</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Recommendation clicks</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>Recommendation clicks</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Products analyzed</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Products analyzed</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<div class="card section-gap">`, `<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">`],
  [`<div class="card-title-row">`, `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">`],
  [`<span class="pill ${p.active ? 'pill-green' : 'pill-gray'}">`, `<span class="b-badge ${p.active ? 'green' : 'gray'}">`],
  [`class="a-table"`, `class="b-table"`],
]);

// Handle the second section-gap card for recommendations table
const recoLines = code.split('\n');
for (let i = 3427; i <= 3446; i++) {
  if (recoLines[i]) {
    recoLines[i] = recoLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">');
  }
}
code = recoLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 9. renderDefections (lines 3564-3591)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3564, 3591, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Defection Alerts</h2><p>High-value customers lost and recovery attempts</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Defection alerts</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.05s"><h3>Defection alerts</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Revenue at risk</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>Revenue at risk</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Recovery attempts</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.15s"><h3>Recovery attempts</h3><div class="b-stat-value">`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<div class="card section-gap">`, `<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">`],
  [`<div class="card-title-row">`, `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">`],
  [`<div class="empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
]);

// ═══════════════════════════════════════════════════════════════════
// 10. renderMilestones (lines 3594-3659)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3594, 3659, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Milestones</h2><p>Achievements and platform milestones</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Milestones achieved</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.05s"><h3>Milestones achieved</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Progress</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.1s"><h3>Progress</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Next milestone</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Next milestone</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<span class="pill pill-green">`, `<span class="b-badge green">`],
  [`<span class="pill pill-gray">`, `<span class="b-badge gray">`],
  [`<div class="empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
]);

// Handle milestones section-gap cards
const mileLines = code.split('\n');
for (let i = 3606; i <= 3644; i++) {
  if (mileLines[i]) {
    mileLines[i] = mileLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">');
  }
}
code = mileLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 11. renderPriceHistory (lines 3662-3728)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3662, 3728, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Price History</h2><p>Track competitor price changes and your price position</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Tracked competitors</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.05s"><h3>Tracked competitors</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Price changes detected</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>Price changes detected</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Your price position</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Your price position</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`class="a-table"`, `class="b-table"`],
  [`<div class="empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
]);

// Handle price history section-gap cards
const priceLines = code.split('\n');
for (let i = 3679; i <= 3716; i++) {
  if (priceLines[i]) {
    priceLines[i] = priceLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">');
  }
}
code = priceLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 12. renderMarkdowns (lines 3731-3762)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3731, 3762, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Markdowns</h2><p>Slow-moving inventory and markdown suggestions</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Slow-moving products</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.05s"><h3>Slow-moving products</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Recommended markdown</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.15s"><h3>Recommended markdown</h3><div class="b-stat-value">`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`class="a-table"`, `class="b-table"`],
  [`<span class="pill pill-amber">`, `<span class="b-badge amber">`],
  [`<div class="a-empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
]);

// Handle markdowns section-gap card
const mdLines = code.split('\n');
for (let i = 3742; i <= 3762; i++) {
  if (mdLines[i]) {
    mdLines[i] = mdLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">');
  }
}
code = mdLines.join('\n');

// Handle the duplicate slow-moving card at line 3739
const mdLines2 = code.split('\n');
for (let i = 3738; i <= 3739; i++) {
  if (mdLines2[i] && mdLines2[i].includes('<div class="card"><h3>Slow-moving products</h3><div class="kpi-value')) {
    mdLines2[i] = mdLines2[i].replace(/<div class="card"><h3>Slow-moving products/, '<div class="b-card" style="animation-delay:0.1s"><h3>Slow-moving products');
  }
}
code = mdLines2.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 13. renderTemplates (lines 3765-3834)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3765, 3834, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Templates</h2><p>Email and WhatsApp message templates</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Total templates</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.05s"><h3>Total templates</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Active templates</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>Active templates</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Total sent</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.15s"><h3>Total sent</h3><div class="b-stat-value">`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<span class="pill ${t.active ? 'pill-green' : 'pill-gray'}">`, `<span class="b-badge ${t.active ? 'green' : 'gray'}">`],
  [`class="muted"`, `style="color:var(--muted)"`],
]);

// Handle templates section-gap card
const tmplLines = code.split('\n');
for (let i = 3776; i <= 3802; i++) {
  if (tmplLines[i]) {
    tmplLines[i] = tmplLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">');
  }
}
code = tmplLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 14. renderChannels (lines 3979-4068)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(3979, 4068, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Channels</h2><p>Email, WhatsApp, and push notification configuration</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Email channel</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.05s"><h3>Email channel</h3><div class="b-stat-value`],
  [`<div class="card"><h3>WhatsApp channel</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>WhatsApp channel</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Push notifications</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Push notifications</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<div class="grid grid-2 section-gap">`, `<div class="b-grid-2" style="margin-bottom:24px">`],
  [`class="muted"`, `style="color:var(--muted)"`],
]);

// Handle channels inner cards
const chanLines = code.split('\n');
for (let i = 3989; i <= 4037; i++) {
  if (chanLines[i]) {
    chanLines[i] = chanLines[i]
      .replace(/<div class="card">/g, '<div class="b-card">');
  }
}
code = chanLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 15. renderCac (lines 4328-4438)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(4328, 4438, [
  [`<div class="grid grid-4">`, `<div class="b-header"><div><h2>CAC Tracking</h2><p>Customer acquisition cost and LTV analysis</p></div></div>\n      <div class="b-grid-4" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Overall CAC</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.05s"><h3>Overall CAC</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Total Spend</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.1s"><h3>Total Spend</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Customers Acquired</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Customers Acquired</h3><div class="b-stat-value`],
  [`<div class="card"><h3>LTV:CAC Ratio</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.2s"><h3>LTV:CAC Ratio</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<div class="grid grid-2 section-gap">`, `<div class="b-grid-2" style="margin-bottom:24px">`],
  [`class="muted"`, `style="color:var(--muted)"`],
  [`<div class="empty">`, `<div style="text-align:center;padding:24px;color:var(--muted)">`],
]);

// Handle CAC inner cards
const cacLines = code.split('\n');
for (let i = 4348; i <= 4418; i++) {
  if (cacLines[i]) {
    cacLines[i] = cacLines[i]
      .replace(/<div class="card">/g, '<div class="b-card">')
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">');
  }
}
code = cacLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 16. renderPricing (lines 4441-4555)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(4441, 4555, [
  [`<div class="grid grid-4">`, `<div class="b-header"><div><h2>Dynamic Pricing</h2><p>AI-powered pricing recommendations and guardrails</p></div></div>\n      <div class="b-grid-4" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Products analyzed</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.05s"><h3>Products analyzed</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Price increases</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>Price increases</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Price decreases</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Price decreases</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Hold price</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.2s"><h3>Hold price</h3><div class="b-stat-value">`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<span class="pill pill-green">`, `<span class="b-badge green">`],
  [`<span class="pill pill-amber">`, `<span class="b-badge amber">`],
  [`<span class="pill pill-gray">`, `<span class="b-badge gray">`],
  [`class="muted"`, `style="color:var(--muted)"`],
  [`<div class="grid grid-2 section-gap">`, `<div class="b-grid-2" style="margin-bottom:24px">`],
]);

// Handle pricing inner cards
const prcLines = code.split('\n');
for (let i = 4459; i <= 4543; i++) {
  if (prcLines[i]) {
    prcLines[i] = prcLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">')
      .replace(/<div class="card">/g, '<div class="b-card">')
      .replace(/<span class="pill pill-cyan"/g, '<span class="b-badge cyan"')
      .replace(/<div class="empty"/g, '<div style="text-align:center;padding:24px;color:var(--muted)"');
  }
}
code = prcLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 17. renderFeatures (lines 4558-4590)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(4558, 4590, [
  [`<div class="grid grid-3">`, `<div class="b-header"><div><h2>Features</h2><p>Activate and manage platform features</p></div></div>\n      <div class="b-grid-3" style="margin-bottom:24px">`],
  [`<div class="card"><h3>Total features</h3><div class="kpi-value">`, `<div class="b-card" style="animation-delay:0.05s"><h3>Total features</h3><div class="b-stat-value">`],
  [`<div class="card"><h3>Active features</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.1s"><h3>Active features</h3><div class="b-stat-value`],
  [`<div class="card"><h3>Inactive features</h3><div class="kpi-value`, `<div class="b-card" style="animation-delay:0.15s"><h3>Inactive features</h3><div class="b-stat-value`],
  [`<div class="kpi-sub">`, `<div class="b-stat-label">`],
  [`<span class="pill pill-gray">`, `<span class="b-badge gray">`],
  [`class="muted"`, `style="color:var(--muted)"`],
]);

// Handle features section-gap card
const featLines = code.split('\n');
for (let i = 4569; i <= 4583; i++) {
  if (featLines[i]) {
    featLines[i] = featLines[i]
      .replace(/<div class="card section-gap">/, '<div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">')
      .replace(/<div class="card-title-row">/, '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">');
  }
}
code = featLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 18. renderActivity (lines 4796-4826)
// ═══════════════════════════════════════════════════════════════════
replaceInRange(4796, 4826, [
  [`<div class="card">`, `<div class="b-header"><div><h2>Activity Log</h2><p>Recent activity for your store</p></div></div>\n      <div class="b-card">`],
  [`class="muted"`, `style="color:var(--muted)"`],
]);

// ═══════════════════════════════════════════════════════════════════
// Final sweep: catch any remaining old classes globally
// ═══════════════════════════════════════════════════════════════════
code = code.replace(/class="pill"/g, 'class="b-badge"');
code = code.replace(/class="pill-green"/g, 'class="b-badge green"');
code = code.replace(/class="pill-amber"/g, 'class="b-badge amber"');
code = code.replace(/class="pill-red"/g, 'class="b-badge red"');
code = code.replace(/class="pill-cyan"/g, 'class="b-badge cyan"');
code = code.replace(/class="pill-gray"/g, 'class="b-badge gray"');
code = code.replace(/class="pill-violet"/g, 'class="b-badge purple"');
code = code.replace(/class="pill-coral"/g, 'class="b-badge red"');
code = code.replace(/class="pill-blue"/g, 'class="b-badge blue"');
code = code.replace(/class="pill-purple"/g, 'class="b-badge purple"');

// Replace remaining kpi-value/kpi-sub that weren't caught in targeted replacements
// Only replace in the specific render functions we targeted
const functionRanges = [
  [1488, 1540], [1543, 1668], [2193, 2270], [2554, 2594], [2597, 2678],
  [2703, 2883], [2888, 3033], [3397, 3446], [3564, 3591], [3594, 3659],
  [3662, 3728], [3731, 3762], [3765, 3834], [3979, 4068], [4328, 4438],
  [4441, 4555], [4558, 4590], [4796, 4826],
];

const finalLines = code.split('\n');
for (const [start, end] of functionRanges) {
  for (let i = start - 1; i < Math.min(end, finalLines.length); i++) {
    finalLines[i] = finalLines[i]
      .replace(/class="kpi-value"/g, 'class="b-stat-value"')
      .replace(/class="kpi-sub"/g, 'class="b-stat-label"')
      .replace(/class="a-table"/g, 'class="b-table"');
  }
}
code = finalLines.join('\n');

// Write back
fs.writeFileSync(file, code, 'utf8');

// Count changes
let changes = 0;
const origLines = original.split('\n');
const newLines = code.split('\n');
for (let i = 0; i < Math.max(origLines.length, newLines.length); i++) {
  if (origLines[i] !== newLines[i]) changes++;
}
console.log(`Done. ${changes} lines changed out of ${origLines.length} total.`);
