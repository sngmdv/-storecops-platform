'use strict';

/**
 * Layer 1 — Live Inventory Ledger.
 *
 * Persistent stock levels per product. Registered as an event-tracker
 * listener, so every purchase/checkout automatically decrements stock
 * — the client always sees real levels, not last week's spreadsheet.
 * Oversells are clamped at zero and flagged so the owner notices.
 */

const { createKeyedMutex, } = require('../../storage/keyedMutex',);

const SALE_EVENTS = new Set(['purchase', 'checkout_completed',],);

function createInventoryLedger({ store, },) {
  /**
   * Every mutation below is a read-modify-write on one `(store_id, product_id)`
   * row, with an `await` in the middle. Without serialization two concurrent
   * sales of the same product both read the same `stock`, both write the same
   * decremented value, and one sale is lost — or both insert and the product
   * ends up with duplicate ledger rows. The mutex makes the pair atomic with
   * respect to other operations on that key. See src/storage/keyedMutex.js.
   */
  const mutex = createKeyedMutex();
  const keyFor = (store_id, product_id,) => `${store_id}::${String(product_id,)}`;

  async function findEntry(store_id, product_id,) {
    return store.inventory.findOne({ store_id, product_id: String(product_id,), },);
  }

  return {
    SALE_EVENTS,

    /** Set or update the stock level (and lead time) for a product. */
    async setStock({ store_id, product_id, stock, lead_time_days, name, price, handle, },) {
      if (!store_id || product_id === undefined) {
        throw new Error('store_id and product_id are required.',);
      }
      if (typeof stock !== 'number' || stock < 0) {
        throw new Error('stock must be a non-negative number.',);
      }

      // Descriptive fields are optional and only overwritten when
      // supplied, so a stock-only update never wipes a known price or
      // storefront handle. `price` and `handle` are what the storefront
      // recommendation widget needs to render a real product card.
      const descriptive = {
        ...(name ? { name, } : {}),
        ...(Number.isFinite(Number(price,),) ? { price: Number(price,), } : {}),
        ...(handle ? { handle, } : {}),
      };

      return mutex.run(keyFor(store_id, product_id,), async () => {
        const existing = await findEntry(store_id, product_id,);
        if (existing) {
          return store.inventory.update(existing._id, {
            stock,
            lead_time_days: lead_time_days ?? existing.lead_time_days,
            ...descriptive,
            updated_at: new Date().toISOString(),
          },);
        }

        return store.inventory.insert({
          store_id,
          product_id: String(product_id,),
          stock,
          lead_time_days: lead_time_days ?? 7,
          ...descriptive,
          oversold: 0,
          updated_at: new Date().toISOString(),
        },);
      },);
    },

    /** Bulk stock import: [{ product_id, stock, lead_time_days }]. */
    async setStockBatch(store_id, items,) {
      const results = [];
      for (const item of items || []) {
        results.push(await this.setStock({ store_id, ...item, },),);
      }
      return results;
    },

    /** Add units to an existing product's stock. */
    async restock({ store_id, product_id, quantity, },) {
      return mutex.run(keyFor(store_id, product_id,), async () => {
        const entry = await findEntry(store_id, product_id,);
        if (!entry) {
          throw new Error(`No stock entry for product ${product_id}. Use setStock first.`,);
        }
        return store.inventory.update(entry._id, {
          stock: entry.stock + (Number(quantity,) || 0),
          updated_at: new Date().toISOString(),
        },);
      },);
    },

    /**
     * Event-tracker listener: decrement stock for every sale.
     * Unknown products are auto-registered at zero so the sale is
     * still visible in the ledger (flagged as oversold).
     */
    async onSale(event,) {
      if (!SALE_EVENTS.has(event.event_type,)) return;

      const items = event.items || [];
      for (const item of items) {
        const quantity = Number(item.quantity,) || 1;

        // Serialized per product: the find-or-insert and the decrement must
        // not interleave with another sale of the same product.
        await mutex.run(keyFor(event.store_id, item.product_id,), async () => {
          let entry = await findEntry(event.store_id, item.product_id,);

          if (!entry) {
            entry = await store.inventory.insert({
              store_id: event.store_id,
              product_id: String(item.product_id,),
              stock: 0,
              lead_time_days: 7,
              oversold: 0,
              updated_at: new Date().toISOString(),
            },);
          }

          const newStock = entry.stock - quantity;
          await store.inventory.update(entry._id, {
            stock: Math.max(0, newStock,),
            oversold: entry.oversold + (newStock < 0 ? -newStock : 0),
            updated_at: new Date().toISOString(),
          },);
        },);
      }
    },

    /** Current stock levels for a store. */
    async levels(store_id,) {
      const entries = await store.inventory.find({ store_id, },);
      return entries.sort((a, b,) => a.product_id.localeCompare(b.product_id,),);
    },

    async get(store_id, product_id,) {
      return findEntry(store_id, product_id,);
    },
  };
}

module.exports = { createInventoryLedger, };
