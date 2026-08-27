"use strict";

/**
 * Composition root.
 *
 * Builds the storage layer once and injects it into every engine,
 * then exposes a single platform object with the cross-layer
 * operations the API routes use. Layer 6 (growth & maturity loop) is
 * not a separate module — it is this wiring: execution feeds events
 * back into the data layer, attribution audits decisions, and report
 * snapshots make the whole loop observable.
 */

const config = require("./config/config");
const { createStore } = require("./storage/store");
const { createSqliteStore } = require("./storage/sqliteStore");
const { EventEmitter } = require("node:events");

// Layer 1
const { createCustomerProfiles } = require("./layers/data/customerProfile");
const { createEventTracker } = require("./layers/data/eventTracker");
const { createCompetitorIngestor } = require("./layers/data/competitorIngestor");
const { createExternalSignals } = require("./layers/data/externalSignals");
const { createSentimentCollector } = require("./layers/data/sentimentCollector");
const { createInventoryLedger } = require("./layers/data/inventoryLedger");
const { createSearchConsole } = require("./layers/data/searchConsole");

// Layer 2
const { createRecommendationEngine } = require("./layers/intelligence/recommendationEngine");
const { createChurnScoringEngine } = require("./layers/intelligence/churnScoring");
const { createChannelOptimizer } = require("./layers/intelligence/channelOptimizer");
const { createInventoryIntelligence } = require("./layers/intelligence/inventoryIntelligence");
const { createSeoAuditEngine } = require("./layers/intelligence/seoAuditEngine");
const { createTrendIntelligence } = require("./layers/intelligence/trendIntelligence");
const { createCompetitorIntelligence } = require("./layers/intelligence/competitorIntelligence");
const { createDemandForecastEngine } = require("./layers/intelligence/demandForecast");
const { createBrandSentimentEngine } = require("./layers/intelligence/brandSentiment");
const { createProductInsights } = require("./layers/intelligence/productInsights");
const { createSeoGrowth } = require("./layers/intelligence/seoGrowth");
const { createSeoAutoFix } = require("./layers/intelligence/seoAutoFix");
const { createDeepAudit } = require("./layers/intelligence/deepAudit");
const { createRetentionEngine } = require("./layers/intelligence/retentionEngine");
const { createRevenueIntelligence } = require("./layers/intelligence/revenueIntelligence");
const adminIntelligence = require("./layers/intelligence/adminIntelligence");
const paymentEngine = require("./layers/intelligence/paymentEngine");
const { createDefectionDetector } = require("./layers/intelligence/defectionDetector");
const { createSeasonalAlerts } = require("./layers/intelligence/seasonalAlerts");
const { createAdIntelligence } = require("./layers/intelligence/adIntelligence");
const { createCompetitorScraper } = require("./layers/intelligence/competitorScraper");
const { createMetaAdLibrary } = require("./layers/intelligence/metaAdLibrary");

// Layer 3
const { createRulesEngine } = require("./layers/decision/rulesEngine");
const { createPersonalizationEngine } = require("./layers/decision/personalization");
const { createDynamicPricingEngine } = require("./layers/decision/dynamicPricing");
const { createOrchestrator } = require("./layers/decision/orchestrator");
const { createSegmentationEngine } = require("./layers/decision/segmentation");
const { createCampaignGenerator } = require("./layers/decision/campaignGenerator");
const { createCampaignLifecycle } = require("./layers/decision/campaignLifecycle");
const { createSendTimeOptimizer } = require("./layers/decision/sendTimeOptimizer");

// Layer 4
const { createProviderRegistry } = require("./layers/execution/providers");
const { createWebsiteBot } = require("./layers/execution/websiteBot");
const { createExecutionService } = require("./layers/execution/executionService");
const { createRetargetingService } = require("./layers/execution/retargeting");
const { createPurchaseOrderGenerator } = require("./layers/execution/purchaseOrders");
const { createConsentService } = require("./layers/execution/consentService");
const { createBillingService } = require("./layers/execution/billingService");
const { createMonitoringService } = require("./layers/execution/monitoringService");

// Layer 5
const { createAttributionEngine } = require("./layers/reporting/attribution");
const { createReportingService } = require("./layers/reporting/reportingService");
const { createLiveOrders } = require("./layers/reporting/liveOrders");

// Security & Administration
const { createAuditLog, createRbac } = require("./server/security");
const { createAuthService } = require("./server/auth");
const { createStoreAudit } = require("./server/storeAudit");
const { createIntegrations } = require("./server/integrations");
const { createOauthConnectors } = require("./server/oauthConnectors");
const { createDemoSeeder } = require("./server/demoSeed");
const { createSecretRotationService } = require("./server/secretRotation");
const { createEmailService } = require("./layers/execution/emailService");
const { createPdfService } = require("./layers/execution/pdfService");
const { createNotificationService } = require("./layers/execution/notificationService");
const { createEmailTemplates } = require("./layers/execution/emailTemplates");
const { createActivityLog } = require("./server/activityLog");
const { createTwoFactorAuth } = require("./server/twoFactorAuth");
const { createDataExportService } = require("./server/dataExport");
const { createOnboardingService } = require("./server/onboardingService");
const { createWebhookRetryQueue } = require("./server/webhookRetryQueue");
const { createTieredRateLimiter } = require("./server/tieredRateLimiter");
const { createDemoSimulator } = require("./server/demoSimulator");
const { collectAll } = require("./layers/data/signalCollectors");

function createPlatform(overrides = {}) {
  // Each platform gets its own config copy so instances never mutate
  // shared state (matters when several run side by side, e.g. tests).
  const cfg = overrides.config || {
    ...config,
    providers: { ...config.providers },
    intelligence: { ...config.intelligence },
    security: { ...config.security },
  };
  // SQLite by default so data survives restarts; tests pass an
  // in-memory store (or STORAGE=memory) for speed.
  const store =
    overrides.store ||
    (cfg.storage === "sqlite" ? createSqliteStore(cfg.sqlitePath) : createStore());

  // Layer 1
  const customerProfiles = createCustomerProfiles({ store });

  // Consent service must be created early — eventTracker depends on it
  // for consent-aware behavioral tracking (Task 32).
  const consentService = createConsentService({ store });

  const eventTracker = createEventTracker({ store, customerProfiles, consentService });
  const competitorIngestor = createCompetitorIngestor({ store });
  const externalSignals = createExternalSignals({ store });
  const sentimentCollector = createSentimentCollector({ store });
  const inventoryLedger = createInventoryLedger({ store });
  const searchConsole = createSearchConsole({ store });

  // Live broadcast channel: purchases are pushed to SSE subscribers.
  const live = new EventEmitter();
  live.setMaxListeners(0);

  // Every sale decrements stock and is broadcast in real time.
  eventTracker.onEvent(async (event) => {
    if (inventoryLedger.SALE_EVENTS.has(event.event_type)) {
      await inventoryLedger.onSale(event);
      live.emit("purchase", {
        store_id: event.store_id,
        event_type: event.event_type,
        customer: event.customer_id || event.email || null,
        items: event.items || [],
        total: event.total ?? null,
        at: event.timestamp,
      });
    }
  });

  // Layer 2
  const recommendationEngine = createRecommendationEngine({ store });
  const churnScoring = createChurnScoringEngine({ store, config: cfg });
  const channelOptimizer = createChannelOptimizer({ store });
  const inventoryIntelligence = createInventoryIntelligence({ store });
  const seoAuditEngine = createSeoAuditEngine({ store });
  const trendIntelligence = createTrendIntelligence({ store });
  const competitorIntelligence = createCompetitorIntelligence({ store, competitorIngestor });
  const demandForecastEngine = createDemandForecastEngine({ store, config: cfg });
  const brandSentiment = createBrandSentimentEngine({ store, sentimentCollector });
  const productInsights = createProductInsights({ store, inventoryIntelligence, inventoryLedger });
  const seoGrowth = createSeoGrowth({ store, searchConsole });
  const seoAutoFix = createSeoAutoFix({ store, seoGrowth });
  const deepAudit = createDeepAudit({ store, config: cfg });
  const retentionEngine = createRetentionEngine({ store, config: cfg });
  const revenueIntelligence = createRevenueIntelligence({ store, config: cfg });
  // adminIntelligence is a plain object (no factory), functions take store data directly
  const defectionDetector = createDefectionDetector({ store });
  const seasonalAlerts = createSeasonalAlerts();
  const adIntelligence = createAdIntelligence({ store });
  const competitorScraper = createCompetitorScraper({ store, competitorIngestor });
  const metaAdLibrary = createMetaAdLibrary({ config: cfg, adIntelligence });

  // Layer 3
  const rulesEngine = createRulesEngine({ store });
  const personalization = createPersonalizationEngine({ store, recommendationEngine });
  const dynamicPricing = createDynamicPricingEngine({
    store,
    competitorIngestor,
    inventoryIntelligence,
    demandForecastEngine,
  });
  const orchestrator = createOrchestrator({ store, rulesEngine, churnScoring, brandSentiment });
  const segmentation = createSegmentationEngine({ store });
  const campaignGenerator = createCampaignGenerator({ store, trendIntelligence, seasonalAlerts });
  // Notification center must exist before campaignLifecycle (for launch notifications).
  const notificationService = createNotificationService({ store });
  const sendTimeOptimizer = createSendTimeOptimizer({ store });

  // Layer 4
  const providerRegistry = overrides.providerRegistry || createProviderRegistry(cfg, store);
  const websiteBot = createWebsiteBot({ recommendationEngine, competitorIngestor });

  // Billing & Entitlements (Tasks 41-45)
  const billingService = createBillingService({ store, config: cfg });

  // Monitoring & Alerting (Task 65)
  const monitoringService = createMonitoringService({ store, config: cfg });

  const executionService = createExecutionService({
    store,
    orchestrator,
    personalization,
    channelOptimizer,
    providerRegistry,
    consentService,
    billingService,
  });

  // Campaign lifecycle depends on executionService + orchestrator + notificationService.
  const campaignLifecycle = createCampaignLifecycle({ store, orchestrator, executionService, notificationService });
  const retargeting = createRetargetingService({ store });
  const purchaseOrders = createPurchaseOrderGenerator({ store, productInsights });

  // Layer 5
  const attribution = createAttributionEngine({ store });
  const liveOrders = createLiveOrders({ store });
  const reporting = createReportingService({
    store,
    churnScoring,
    brandSentiment,
    channelOptimizer,
    attribution,
    config: cfg,
  });

  // Security & Administration
  const auditLog = createAuditLog({ store });
  const rbac = createRbac({ store, auditLog });
  const auth = createAuthService({ store, config: cfg, auditLog });
  const siteAudit = createStoreAudit({ store, config: cfg });

  const platform = {
    config: cfg,
    store,
    live,

    // Layer 1
    customerProfiles,
    eventTracker,
    competitorIngestor,
    externalSignals,
    sentimentCollector,
    inventoryLedger,
    searchConsole,

    // Layer 2
    recommendationEngine,
    churnScoring,
    channelOptimizer,
    inventoryIntelligence,
    seoAuditEngine,
    trendIntelligence,
    competitorIntelligence,
    demandForecastEngine,
    brandSentiment,
    productInsights,
    seoGrowth,
    seoAutoFix,
    deepAudit,
    retentionEngine,
    revenueIntelligence,
    adminIntelligence,
    paymentEngine,
    defectionDetector,
    seasonalAlerts,
    adIntelligence,
    competitorScraper,
    metaAdLibrary,

    // Layer 3
    rulesEngine,
    personalization,
    dynamicPricing,
    orchestrator,
    segmentation,
    campaignGenerator,
    notificationService,
    campaignLifecycle,
    sendTimeOptimizer,

    // Layer 4
    providerRegistry,
    websiteBot,
    executionService,
    retargeting,
    purchaseOrders,
    consentService,
    billingService,
    monitoringService,

    // Layer 5
    attribution,
    liveOrders,
    reporting,

    // Security & Administration
    auditLog,
    rbac,
    auth,
    siteAudit,

    /**
     * Real-time pipeline: ingest an event and immediately let the
     * decision layer react to high-priority ones.
     */
    async trackAndReact(event) {
      const tracked = await eventTracker.track(event);
      if (!tracked.accepted) return tracked;

      let decision = null;
      if (tracked.high_priority) {
        const logged = await store.events.findById(tracked.event_id);
        decision = await orchestrator.handleEvent(logged);
      }

      return { ...tracked, decision };
    },

    /**
     * One full automation cycle for a store: scan, execute, attribute.
     * This is the heartbeat of the growth loop.
     */
    async runGrowthCycle(store_id) {
      const scan = await orchestrator.scanStore(store_id);
      const execution = await executionService.processStore(store_id);
      const attributionReport = await attribution.attributeStore(store_id);
      const report = await reporting.storeReport(store_id);

      return { scan, execution, attribution: attributionReport, report };
    },
  };

  // Demo seeder needs the fully assembled platform.
  platform.demoSeed = createDemoSeeder(platform);
  // Store connections (snippet/CSV/webhook/Shopify/Woo) as well.
  platform.integrations = createIntegrations({ platform });
  // One-click platform connect (OAuth handshakes + pending connections).
  platform.oauth = createOauthConnectors({ platform });
  // Secret rotation & revocation (Task 27)
  platform.secretRotation = createSecretRotationService({ store, auditLog });
  // Task ob9: Pluggable email service (console/resend/smtp).
  platform.emailService = createEmailService({ config: cfg });
  // Branded PDF report generator for deep audits.
  platform.pdfService = createPdfService({ config: cfg });
  // Notification center — already created above (needed by campaignLifecycle).
  platform.notificationService = notificationService;
  // Branded email templates for all transactional emails.
  platform.emailTemplates = createEmailTemplates({ config: cfg });
  // Enhanced activity log — business-level audit trail.
  platform.activityLog = createActivityLog({ store });
  // Two-factor authentication (TOTP).
  platform.twoFactorAuth = createTwoFactorAuth({ store });
  // Full store data export (GDPR compliance).
  platform.dataExport = createDataExportService({ store });
  // Onboarding wizard — guided merchant setup.
  platform.onboarding = createOnboardingService({ store });
  // Webhook retry queue — reliable outbound delivery.
  platform.webhookQueue = createWebhookRetryQueue({ store, notificationService: platform.notificationService });
  // Per-plan tiered rate limiter.
  platform.tieredRateLimiter = createTieredRateLimiter({ platform });
  // Live demo simulator — generates realistic events when no real credentials exist.
  platform.demoSimulator = createDemoSimulator(platform);
  // External signal collectors — fetches trending data from Google Trends, Reddit, etc.
  platform.signalCollectors = { collectAll: (storeId, keywords) => collectAll(storeId, keywords, externalSignals) };

  return platform;
}

module.exports = { createPlatform };
