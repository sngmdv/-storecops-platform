"use strict";

/**
 * Layer 1 — Live Inventory Ledger.
 *
 * Persistent stock levels per product. Registered as an event-tracker
 * listener, so every purchase/checkout automatically decrements stock
 * — the client always sees real levels, not last week's spreadsheet.
 * Oversells are clamped at zero and flagged so the owner notices.
 */

const SALE_EVENTS = new Set(["purchase", "checkout_completed"]);

function createInventoryLedger({ store }) {
  async function findEntry(store_id, product_id) {
    return store.inventory.findOne({ store_id, product_id: String(product_id) });
  }

  return {
    SALE_EVENTS,

    /** Set or update the stock level (and lead time) for a product. */
    async setStock({ store_id, product_id, stock, lead_time_days, name }) {
      if (!store_id || product_id === undefined) {
        throw new Error("store_id and product_id are required.");
      }
      if (typeof stock !== "number" || stock < 0) {
        throw new Error("stock must be a non-negative number.");
      }

      const existing = await findEntry(store_id, product_id);
      if (existing) {
        return store.inventory.update(existing._id, {
          stock,
          lead_time_days: lead_time_days ?? existing.lead_time_days,
          ...(name ? { name } : {}),
          updated_at: new Date().toISOString(),
        });
      }

      return store.inventory.insert({
        store_id,
        product_id: String(product_id),
        stock,
        lead_time_days: lead_time_days ?? 7,
        ...(name ? { name } : {}),
        oversold: 0,
        updated_at: new Date().toISOString(),
      });
    },

    /** Bulk stock import: [{ product_id, stock, lead_time_days }]. */
    async setStockBatch(store_id, items) {
      const results = [];
      for (const item of items || []) {
        results.push(await this.setStock({ store_id, ...item }));
      }
      return results;
    },

    /** Add units to an existing product's stock. */
    async restock({ store_id, product_id, quantity }) {
      const entry = await findEntry(store_id, product_id);
      if (!entry) {
        throw new Error(`No stock entry for product ${product_id}. Use setStock first.`);
      }
      return store.inventory.update(entry._id, {
        stock: entry.stock + (Number(quantity) || 0),
        updated_at: new Date().toISOString(),
      });
    },

    /**
     * Event-tracker listener: decrement stock for every sale.
     * Unknown products are auto-registered at zero so the sale is
     * still visible in the ledger (flagged as oversold).
     */
    async onSale(event) {
      if (!SALE_EVENTS.has(event.event_type)) return;

      const items = event.items || [];
      for (const item of items) {
        const quantity = Number(item.quantity) || 1;
        let entry = await findEntry(event.store_id, item.product_id);

        if (!entry) {
          entry = await store.inventory.insert({
            store_id: event.store_id,
            product_id: String(item.product_id),
            stock: 0,
            lead_time_days: 7,
            oversold: 0,
            updated_at: new Date().toISOString(),
          });
        }

        const newStock = entry.stock - quantity;
        await store.inventory.update(entry._id, {
          stock: Math.max(0, newStock),
          oversold: entry.oversold + (newStock < 0 ? -newStock : 0),
          updated_at: new Date().toISOString(),
        });
      }
    },

    /** Current stock levels for a store. */
    async levels(store_id) {
      const entries = await store.inventory.find({ store_id });
      return entries.sort((a, b) => a.product_id.localeCompare(b.product_id));
    },

    async get(store_id, product_id) {
      return findEntry(store_id, product_id);
    },
  };
}

module.exports = { createInventoryLedger };
