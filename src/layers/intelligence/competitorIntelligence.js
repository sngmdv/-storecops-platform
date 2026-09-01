'use strict';

/**
 * Layer 2 — Competitor Intelligence Engine.
 *
 * Diffs consecutive competitor snapshots to detect price changes,
 * promotions, catalog additions/removals and stockouts, then converts
 * findings into prioritized alerts.
 */

function createCompetitorIntelligence({ store, competitorIngestor, },) {
  /** Diff two snapshots of the same competitor. */
  function diffSnapshots(previous, latest,) {
    const changes = {
      competitor: latest.competitor,
      price_drops: [],
      price_increases: [],
      new_products: [],
      removed_products: [],
      stockouts: [],
      possible_promotions: [],
    };

    const prevById = new Map((previous?.products || []).map((p,) => [p.id, p,],),);
    const latestById = new Map(latest.products.map((p,) => [p.id, p,],),);

    for (const [id, current,] of latestById) {
      const before = prevById.get(id,);

      if (!before) {
        changes.new_products.push({ product_id: id, name: current.name, price: current.price, },);
        continue;
      }

      if (current.price < before.price) {
        const dropPct = ((before.price - current.price) / before.price) * 100;
        changes.price_drops.push({
          product_id: id,
          name: current.name,
          from: before.price,
          to: current.price,
          change_pct: Number(dropPct.toFixed(1,),),
        },);

        // A drop of 15%+ is very likely a promotion.
        if (dropPct >= 15) {
          changes.possible_promotions.push({
            product_id: id,
            name: current.name,
            estimated_discount_pct: Number(dropPct.toFixed(1,),),
          },);
        }
      } else if (current.price > before.price) {
        changes.price_increases.push({
          product_id: id,
          name: current.name,
          from: before.price,
          to: current.price,
        },);
      }

      if (before.in_stock && !current.in_stock) {
        changes.stockouts.push({ product_id: id, name: current.name, },);
      }

      // Explicit promotion/bundle signals captured by the ingestor (4.4).
      if (current.promotion && current.promotion !== before.promotion) {
        changes.possible_promotions.push({
          product_id: id,
          name: current.name,
          detected_offer: current.promotion,
        },);
      }
    }

    for (const [id, before,] of prevById) {
      if (!latestById.has(id,)) {
        changes.removed_products.push({ product_id: id, name: before.name, },);
      }
    }

    return changes;
  }

  /** Priority: promotions and big price drops demand fastest response. */
  function prioritize(changes,) {
    const alerts = [];

    for (const promo of changes.possible_promotions) {
      alerts.push({
        type: 'COMPETITOR_PROMOTION',
        priority: 'HIGH',
        message: promo.detected_offer
          ? `${changes.competitor} is running "${promo.detected_offer}" on ${promo.name}`
          : `${changes.competitor} is likely running a promotion (${promo.estimated_discount_pct}% off ${promo.name})`,
        detail: promo,
      },);
    }

    for (const drop of changes.price_drops) {
      alerts.push({
        type: 'PRICE_DROP',
        priority: drop.change_pct >= 10 ? 'HIGH' : 'MEDIUM',
        message: `${changes.competitor} cut ${drop.name} price by ${drop.change_pct}%`,
        detail: drop,
      },);
    }

    for (const stockout of changes.stockouts) {
      alerts.push({
        type: 'COMPETITOR_STOCKOUT',
        priority: 'MEDIUM',
        message: `${stockout.name} is out of stock at ${changes.competitor} — capture their demand`,
        detail: stockout,
      },);
    }

    for (const added of changes.new_products) {
      alerts.push({
        type: 'CATALOG_ADDITION',
        priority: 'LOW',
        message: `${changes.competitor} added ${added.name}`,
        detail: added,
      },);
    }

    for (const removed of changes.removed_products) {
      alerts.push({
        type: 'CATALOG_REMOVAL',
        priority: 'LOW',
        message: `${changes.competitor} removed ${removed.name}`,
        detail: removed,
      },);
    }

    const order = { HIGH: 0, MEDIUM: 1, LOW: 2, };
    return alerts.sort((a, b,) => order[a.priority] - order[b.priority],);
  }

  return {
    diffSnapshots,
    prioritize,

    /** Analyze one competitor using the last two stored snapshots. */
    async analyzeCompetitor(store_id, competitor,) {
      const { previous, latest, } = await competitorIngestor.snapshotPair(store_id, competitor,);

      if (!latest) {
        return { competitor, status: 'NO_DATA', changes: null, alerts: [], };
      }
      if (!previous || previous._id === latest._id) {
        return { competitor, status: 'BASELINE_ONLY', changes: null, alerts: [], };
      }

      const changes = diffSnapshots(previous, latest,);
      return {
        competitor,
        status: 'ANALYZED',
        changes,
        alerts: prioritize(changes,),
        compared: { from: previous.captured_at, to: latest.captured_at, },
      };
    },

    /** Full competitive landscape for a store. */
    async analyzeStore(store_id,) {
      const snapshots = await competitorIngestor.latestSnapshots(store_id,);
      const results = [];

      for (const snapshot of snapshots) {
        results.push(await this.analyzeCompetitor(store_id, snapshot.competitor,),);
      }

      return {
        store_id,
        analyzed_at: new Date().toISOString(),
        competitors: results,
        high_priority_alerts: results.flatMap((r,) => r.alerts,).filter((a,) => a.priority === 'HIGH',),
      };
    },

    /**
     * Monthly competitive landscape report (9.7): positioning, price
     * posture and activity summary per competitor.
     */
    async landscapeReport(store_id,) {
      const snapshots = await competitorIngestor.latestSnapshots(store_id,);
      const analysis = await this.analyzeStore(store_id,);

      const competitors = snapshots.map((snapshot,) => {
        const prices = snapshot.products.map((p,) => p.price,).filter((p,) => Number.isFinite(p,),);
        const avgPrice = prices.length
          ? Number((prices.reduce((a, b,) => a + b, 0,) / prices.length).toFixed(2,),)
          : null;
        const competitorAnalysis = analysis.competitors.find(
          (c,) => c.competitor === snapshot.competitor,
        );

        return {
          competitor: snapshot.competitor,
          catalog_size: snapshot.products.length,
          avg_price: avgPrice,
          in_stock_rate: snapshot.products.length
            ? Number(
              (
                snapshot.products.filter((p,) => p.in_stock,).length / snapshot.products.length
              ).toFixed(2,),
            )
            : null,
          active_promotions: snapshot.products.filter((p,) => p.promotion,).length,
          recent_alerts: competitorAnalysis?.alerts?.length ?? 0,
          last_seen: snapshot.captured_at,
        };
      },);

      // Simple attention-share estimate: alerts are a proxy for activity.
      const totalAlerts = competitors.reduce((sum, c,) => sum + c.recent_alerts, 0,) || 1;
      for (const competitor of competitors) {
        competitor.activity_share_pct = Math.round((competitor.recent_alerts / totalAlerts) * 100,);
      }

      return {
        store_id,
        period: 'monthly',
        competitors: competitors.sort((a, b,) => b.recent_alerts - a.recent_alerts,),
        total_high_priority_alerts: analysis.high_priority_alerts.length,
        positioning_summary:
          competitors.length === 0
            ? 'No competitors tracked yet.'
            : `Tracking ${competitors.length} competitor(s); most active: ${competitors[0].competitor}.`,
        generated_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createCompetitorIntelligence, };
