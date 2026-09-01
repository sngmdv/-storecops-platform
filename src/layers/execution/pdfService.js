'use strict';

/**
 * Branded PDF Report Generator.
 *
 * Takes a deep audit report and generates a professional, well-structured
 * PDF with:
 *   - Storecops branding (logo area, colors, footer)
 *   - Overall health score with grade
 *   - Category breakdown (SEO, Performance, Security, Crawlability, AI)
 *   - Detailed findings with pass/warn/fail indicators
 *   - Top issues with priority and recommendations
 *   - Storecops pricing plans in the footer to drive conversions
 */

const PDFDocument = require('pdfkit',);

// Brand colors
const COLORS = {
  primary: '#667eea',
  primaryDark: '#5a67d8',
  accent: '#764ba2',
  success: '#38a169',
  warning: '#d69e2e',
  danger: '#e53e3e',
  text: '#1a1a2e',
  textLight: '#4a5568',
  textMuted: '#718096',
  bgLight: '#f7fafc',
  border: '#e2e8f0',
  white: '#ffffff',
};

function createPdfService({ config, },) {
  const publicUrl = config?.publicUrl || 'https://storecops.com';

  /**
   * Generate a branded PDF report from a deep audit result.
   * Returns a Buffer.
   */
  function generateReportPdf(report,) {
    return new Promise((resolve, reject,) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, },);
      const chunks = [];

      doc.on('data', (chunk,) => chunks.push(chunk,),);
      doc.on('end', () => resolve(Buffer.concat(chunks,),),);
      doc.on('error', reject,);

      // ── Header ────────────────────────────────────────────────────
      drawHeader(doc, report,);

      // ── Overall Score ─────────────────────────────────────────────
      drawOverallScore(doc, report,);

      // ── Category Breakdown ────────────────────────────────────────
      drawCategoryBreakdown(doc, report,);

      // ── AI Readiness ──────────────────────────────────────────────
      drawAiReadiness(doc, report,);

      // ── Top Issues ────────────────────────────────────────────────
      drawTopIssues(doc, report,);

      // ── Detailed Findings ─────────────────────────────────────────
      drawDetailedFindings(doc, report,);

      // ── Pricing Plans (conversion footer) ─────────────────────────
      drawPricingPlans(doc, report,);

      // ── Footer on every page ──────────────────────────────────────
      drawFooters(doc,);

      doc.end();
    },);
  }

  function drawHeader(doc, report,) {
    // Gradient-like header bar
    doc.rect(0, 0, 595, 100,).fill(COLORS.primary,);

    // Storecops branding
    doc.fontSize(24,).font('Helvetica-Bold',).fillColor(COLORS.white,);
    doc.text('STORECOPS', 50, 25,);
    doc.fontSize(10,).font('Helvetica',).fillColor('#c4b5fd',);
    doc.text('Growth Platform', 50, 52,);

    // Report title
    doc.fontSize(11,).font('Helvetica',).fillColor(COLORS.white,);
    doc.text('Store Health Audit Report', 300, 30, { width: 250, align: 'right', },);
    doc.fontSize(9,).fillColor('#c4b5fd',);
    doc.text(new Date(report.audited_at,).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    },), 300, 48, { width: 250, align: 'right', },);

    // Store URL
    doc.fontSize(10,).fillColor(COLORS.white,);
    doc.text(report.url, 300, 65, { width: 250, align: 'right', link: report.url, },);

    doc.moveDown(5,);
  }

  function drawOverallScore(doc, report,) {
    const y = doc.y + 10;
    const scoreColor = report.overall_score >= 70 ? COLORS.success
      : report.overall_score >= 50 ? COLORS.warning : COLORS.danger;

    // Score circle area
    doc.fontSize(48,).font('Helvetica-Bold',).fillColor(scoreColor,);
    doc.text(`${report.overall_score}`, 50, y, { width: 150, align: 'center', },);
    doc.fontSize(14,).font('Helvetica',).fillColor(COLORS.textLight,);
    doc.text('/ 100', 50, y + 55, { width: 150, align: 'center', },);

    // Grade badge
    doc.fontSize(36,).font('Helvetica-Bold',).fillColor(scoreColor,);
    doc.text(`Grade: ${report.grade}`, 220, y + 10, { width: 200, },);

    // Summary
    doc.fontSize(10,).font('Helvetica',).fillColor(COLORS.textLight,);
    doc.text(
      `${report.passed_checks} of ${report.total_checks} checks passed`,
      220, y + 55, { width: 300, },
    );

    doc.moveDown(5,);
    doc.y = y + 90;
  }

  function drawCategoryBreakdown(doc, report,) {
    sectionTitle(doc, 'Health Score Breakdown',);

    const categories = [
      { name: 'SEO', key: 'seo', icon: '🔍', },
      { name: 'Performance', key: 'performance', icon: '⚡', },
      { name: 'Security', key: 'security', icon: '🔒', },
      { name: 'Crawlability', key: 'crawlability', icon: '🕷', },
      { name: 'AI Readiness', key: 'ai', icon: '🤖', },
    ];

    for (const cat of categories) {
      const score = cat.key === 'ai'
        ? report.ai_readiness?.score || 0
        : report.categories[cat.key]?.score || 0;
      const barColor = score >= 70 ? COLORS.success : score >= 50 ? COLORS.warning : COLORS.danger;

      doc.fontSize(11,).font('Helvetica-Bold',).fillColor(COLORS.text,);
      doc.text(`${cat.name}`, 60, doc.y + 2,);
      doc.fontSize(11,).font('Helvetica',).fillColor(COLORS.textLight,);
      doc.text(`${score}%`, 450, doc.y - 13, { width: 80, align: 'right', },);

      // Progress bar
      const barY = doc.y + 2;
      doc.rect(180, barY, 250, 10,).fill(COLORS.bgLight,);
      doc.rect(180, barY, Math.max(2, 250 * score / 100,), 10,).fill(barColor,);

      doc.y = barY + 18;
    }

    doc.moveDown(1,);
  }

  function drawAiReadiness(doc, report,) {
    sectionTitle(doc, 'AI Search Visibility',);

    const ai = report.ai_readiness;
    if (!ai) return;

    doc.fontSize(10,).font('Helvetica',).fillColor(COLORS.textLight,);
    doc.text(
      'How visible your store is to AI search engines like ChatGPT, Perplexity, and Google AI Overviews.',
      60, doc.y, { width: 470, },
    );
    doc.moveDown(1,);

    for (const signal of (ai.signals || [])) {
      const statusIcon = signal.status === 'pass' ? '✓' : signal.status === 'warn' ? '!' : '✗';
      const statusColor = signal.status === 'pass' ? COLORS.success
        : signal.status === 'warn' ? COLORS.warning : COLORS.danger;

      doc.fontSize(10,).font('Helvetica-Bold',).fillColor(statusColor,);
      doc.text(statusIcon, 60, doc.y, { continued: true, },);
      doc.font('Helvetica',).fillColor(COLORS.text,);
      doc.text(` ${signal.signal.replace(/_/g, ' ',)}`, { continued: true, },);
      doc.fillColor(COLORS.textMuted,);
      doc.text(` — ${signal.detail}`, { width: 400, },);
    }

    doc.moveDown(1,);
  }

  function drawTopIssues(doc, report,) {
    sectionTitle(doc, 'Top Issues to Fix',);

    if (!report.top_issues || report.top_issues.length === 0) {
      doc.fontSize(11,).font('Helvetica',).fillColor(COLORS.success,);
      doc.text('No critical issues found! Your store is in good shape.', 60,);
      doc.moveDown(1,);
      return;
    }

    for (let i = 0; i < report.top_issues.length; i++) {
      const issue = report.top_issues[i];
      const priorityColor = issue.weight >= 20 ? COLORS.danger
        : issue.weight >= 10 ? COLORS.warning : COLORS.textMuted;

      doc.fontSize(10,).font('Helvetica-Bold',).fillColor(priorityColor,);
      doc.text(`${i + 1}.`, 60, doc.y, { continued: true, },);
      doc.font('Helvetica',).fillColor(COLORS.text,);
      doc.text(` [${issue.category}] ${issue.label}`, { continued: true, },);
      doc.fillColor(COLORS.textMuted,).fontSize(9,);
      doc.text(` (priority: ${issue.weight >= 20 ? 'HIGH' : issue.weight >= 10 ? 'MEDIUM' : 'LOW'})`,);
    }

    doc.moveDown(1,);
  }

  function drawDetailedFindings(doc, report,) {
    sectionTitle(doc, 'Detailed Findings',);

    const sections = [
      { title: 'SEO Analysis', checks: report.categories?.seo?.checks || [], },
      { title: 'Performance', checks: report.categories?.performance?.checks || [], },
      { title: 'Security', checks: report.categories?.security?.checks || [], },
      { title: 'Crawlability', checks: report.categories?.crawlability?.checks || [], },
    ];

    for (const section of sections) {
      doc.fontSize(12,).font('Helvetica-Bold',).fillColor(COLORS.primary,);
      doc.text(section.title, 60, doc.y + 5,);
      doc.moveDown(0.5,);

      for (const check of section.checks) {
        const icon = check.pass ? '✓' : '✗';
        const color = check.pass ? COLORS.success : COLORS.danger;

        doc.fontSize(10,).font('Helvetica',).fillColor(color,);
        doc.text(`  ${icon}`, 60, doc.y, { continued: true, },);
        doc.fillColor(check.pass ? COLORS.text : COLORS.danger,);
        doc.text(` ${check.label}`, { width: 400, },);
      }
      doc.moveDown(0.5,);

      // Page break if needed
      if (doc.y > 700) doc.addPage();
    }
  }

  function drawPricingPlans(doc, report,) {
    // Page break before pricing
    doc.addPage();

    // Pricing header
    doc.rect(0, 0, 595, 80,).fill(COLORS.primary,);
    doc.fontSize(22,).font('Helvetica-Bold',).fillColor(COLORS.white,);
    doc.text('Ready to Grow Your Store?', 50, 25, { width: 495, align: 'center', },);
    doc.fontSize(11,).font('Helvetica',).fillColor('#c4b5fd',);
    doc.text('Your store has potential. Storecops gives you the tools to unlock it.', 50, 55, {
      width: 495, align: 'center',
    },);

    doc.y = 110;

    const plans = [
      {
        name: 'Starter',
        price: '$29/mo',
        features: [
          'Weekly SEO audits & monitoring',
          'Basic competitor tracking (3 competitors)',
          'Cart recovery emails (up to 500/mo)',
          'Store health dashboard',
          'Email support',
        ],
        cta: 'Start Growing Today',
      },
      {
        name: 'Growth',
        price: '$79/mo',
        features: [
          'Everything in Starter, plus:',
          'Unlimited competitor tracking',
          'WhatsApp + Email automation',
          'AI search optimization (ChatGPT, Perplexity)',
          'Dynamic pricing engine',
          'Demand forecasting',
          'Priority support',
        ],
        cta: 'Scale Your Store',
        highlighted: true,
      },
      {
        name: 'Enterprise',
        price: '$199/mo',
        features: [
          'Everything in Growth, plus:',
          'Multi-store management',
          'Custom AI models & recommendations',
          'Dedicated account manager',
          'API access & webhooks',
          'White-label reports',
          'SLA guarantee',
        ],
        cta: 'Talk to Sales',
      },
    ];

    const colWidth = 155;
    const startX = 45;

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const x = startX + i * (colWidth + 15);
      const y = doc.y;

      // Card background
      if (plan.highlighted) {
        doc.rect(x, y, colWidth, 380,).fill(COLORS.primary,);
      } else {
        doc.rect(x, y, colWidth, 380,).fill(COLORS.bgLight,);
      }

      const textColor = plan.highlighted ? COLORS.white : COLORS.text;

      // Plan name
      doc.fontSize(14,).font('Helvetica-Bold',).fillColor(textColor,);
      doc.text(plan.name, x + 15, y + 20, { width: colWidth - 30, },);

      // Price
      doc.fontSize(24,).font('Helvetica-Bold',).fillColor(textColor,);
      doc.text(plan.price, x + 15, y + 45, { width: colWidth - 30, },);

      // Features
      doc.fontSize(9,).font('Helvetica',).fillColor(plan.highlighted ? '#e2e8f0' : COLORS.textLight,);
      let featureY = y + 85;
      for (const feature of plan.features) {
        doc.text(`• ${feature}`, x + 15, featureY, { width: colWidth - 30, lineGap: 3, },);
        featureY += 22;
      }

      // CTA
      const ctaY = y + 330;
      if (plan.highlighted) {
        doc.rect(x + 15, ctaY, colWidth - 30, 30,).fill(COLORS.white,);
        doc.fontSize(10,).font('Helvetica-Bold',).fillColor(COLORS.primary,);
      } else {
        doc.rect(x + 15, ctaY, colWidth - 30, 30,).fill(COLORS.primary,);
        doc.fontSize(10,).font('Helvetica-Bold',).fillColor(COLORS.white,);
      }
      doc.text(plan.cta, x + 15, ctaY + 9, { width: colWidth - 30, align: 'center', },);
    }

    doc.y += 420;

    // Urgency text
    doc.fontSize(11,).font('Helvetica-Bold',).fillColor(COLORS.primary,);
    doc.text('Limited Time: 14-Day Free Trial on All Plans', 50, doc.y, {
      width: 495, align: 'center',
    },);
    doc.fontSize(10,).font('Helvetica',).fillColor(COLORS.textLight,);
    doc.text(`Sign up at ${publicUrl} — No credit card required.`, 50, doc.y + 18, {
      width: 495, align: 'center',
    },);
  }

  function drawFooters(doc,) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i,);

      // Footer bar
      doc.rect(0, 810, 595, 32,).fill(COLORS.text,);
      doc.fontSize(8,).font('Helvetica',).fillColor(COLORS.white,);
      doc.text('STORECOPS', 50, 818, { continued: true, },);
      doc.font('Helvetica',).fillColor('#a0aec0',);
      doc.text('  |  AI-Powered E-Commerce Growth Platform', { continued: true, },);
      doc.text(`  |  ${publicUrl}`, { continued: true, },);
      doc.text('  |  Page ' + (i + 1) + ' of ' + range.count, {
        width: 200, align: 'right',
      },);
    }
  }

  function sectionTitle(doc, title,) {
    doc.fontSize(14,).font('Helvetica-Bold',).fillColor(COLORS.primary,);
    doc.text(title, 50, doc.y + 10,);
    doc.moveTo(50, doc.y + 2,).lineTo(545, doc.y + 2,).strokeColor(COLORS.border,).stroke();
    doc.moveDown(0.5,);
  }

  return { generateReportPdf, };
}

module.exports = { createPdfService, };
