import { render, } from 'preact';
import { useEffect, useState, } from 'preact/hooks';
import { callApi, selectedId, } from './api.js';

/**
 * Inventory + competitor card on the Shopify product page.
 *
 * Answers the two questions a merchant has while looking at a product:
 * "will this run out?" and "am I priced above the competition?"
 */

export default async () => {
  render(<Extension />, document.body,);
};

/** Stock status -> badge tone. */
const STATUS_TONE = {
  STOCKOUT: 'critical',
  STOCKOUT_RISK: 'warning',
  REORDER_SOON: 'caution',
};

const STATUS_LABEL = {
  STOCKOUT: 'Out of stock',
  STOCKOUT_RISK: 'Stockout risk',
  REORDER_SOON: 'Reorder soon',
  HEALTHY: 'Healthy',
};

function Extension() {
  const productId = selectedId();
  const [state, setState] = useState({ loading: true, },);

  useEffect(() => {
    let cancelled = false;

    if (!productId) {
      setState({ loading: false, error: 'No product in context.', },);
      return () => {};
    }

    callApi(`/ext/shop/product/${encodeURIComponent(productId,)}/insights`,)
      .then((data,) => {
        if (!cancelled) setState({ loading: false, data, },);
      },)
      .catch((error,) => {
        if (!cancelled) setState({ loading: false, error: error.message, },);
      },);

    return () => {
      cancelled = true;
    };
  }, [productId,],);

  if (state.loading) {
    return (
      <s-admin-block heading="Storecops">
        <s-spinner accessibilityLabel="Loading product intelligence" />
      </s-admin-block>
    );
  }

  if (state.error || !state.data?.found) {
    return (
      <s-admin-block heading="Storecops">
        <s-text>
          {state.error || 'No Storecops data for this product yet.'}
        </s-text>
      </s-admin-block>
    );
  }

  const data = state.data;

  return (
    <s-admin-block heading="Storecops">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone={STATUS_TONE[data.status] || 'success'}>
            {STATUS_LABEL[data.status] || data.status}
          </s-badge>
          <s-text>{data.units_per_day}/day over {data.window_days} days</s-text>
        </s-stack>

        <s-text>
          On hand: {data.stock_on_hand} unit(s) · {data.units_sold} sold
        </s-text>

        <s-text>
          {data.days_until_stockout === null
            ? 'No stockout projected (no recent sales).'
            : `Projected stockout in ${data.days_until_stockout} day(s) (${data.lead_time_days}-day lead time).`}
        </s-text>

        {data.suggested_reorder_qty > 0 && (
          <s-text>
            Suggested reorder: {data.suggested_reorder_qty} unit(s)
          </s-text>
        )}

        <s-divider />

        {data.has_competitor_data ? (
          <s-text>
            Cheapest competitor price: ${data.competitor_price}
            {data.competitor_name ? ` (${data.competitor_name})` : ''}
          </s-text>
        ) : (
          <s-text>No competitor pricing tracked for this product.</s-text>
        )}
      </s-stack>
    </s-admin-block>
  );
}
