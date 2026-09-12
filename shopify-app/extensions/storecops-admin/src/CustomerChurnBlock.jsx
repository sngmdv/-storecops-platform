import { render, } from 'preact';
import { useEffect, useState, } from 'preact/hooks';
import { callApi, selectedId, } from './api.js';

/**
 * Churn-risk card on the Shopify customer page.
 *
 * Shows the score, lifetime value and recency for the customer being
 * viewed, and offers a one-click win-back when one is worth sending.
 * Rendered inside the admin next to the merchant's own data, so the
 * insight arrives without a context switch.
 */

export default async () => {
  render(<Extension />, document.body,);
};

/** Risk band -> the badge tone the admin already uses for severity. */
const BAND_TONE = {
  CRITICAL: 'critical',
  HIGH: 'warning',
  MEDIUM: 'caution',
};

function Extension() {
  const customerId = selectedId();
  const [state, setState] = useState({ loading: true, },);
  const [sending, setSending] = useState(false,);
  const [notice, setNotice] = useState(null,);

  useEffect(() => {
    let cancelled = false;

    if (!customerId) {
      setState({ loading: false, error: 'No customer in context.', },);
      return () => {};
    }

    callApi(`/ext/shop/customer/${encodeURIComponent(customerId,)}/insights`,)
      .then((data,) => {
        if (!cancelled) setState({ loading: false, data, },);
      },)
      .catch((error,) => {
        if (!cancelled) setState({ loading: false, error: error.message, },);
      },);

    return () => {
      cancelled = true;
    };
  }, [customerId,],);

  async function sendWinback() {
    setSending(true,);
    setNotice(null,);
    try {
      const result = await callApi(
        `/ext/shop/customer/${encodeURIComponent(customerId,)}/winback`,
        { method: 'POST', body: { channel: 'email', }, },
      );
      setNotice(
        result.ok
          ? 'Win-back message sent.'
          : result.reason || 'Win-back was not sent.',
      );
    } catch (error) {
      setNotice(error.message,);
    } finally {
      setSending(false,);
    }
  }

  if (state.loading) {
    return (
      <s-admin-block heading="Storecops">
        <s-spinner accessibilityLabel="Loading customer intelligence" />
      </s-admin-block>
    );
  }

  if (state.error || !state.data?.found) {
    return (
      <s-admin-block heading="Storecops">
        <s-text>
          {state.error || 'No Storecops history for this customer yet.'}
        </s-text>
      </s-admin-block>
    );
  }

  const data = state.data;
  const recency = data.days_since_purchase === null
    ? 'never purchased'
    : `${data.days_since_purchase} day(s) ago`;

  return (
    <s-admin-block heading="Storecops">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone={BAND_TONE[data.risk_band] || 'base'}>
            {data.risk_band} churn risk
          </s-badge>
          <s-text>{data.churn_score}/100</s-text>
        </s-stack>

        <s-text>
          Lifetime value: ${data.lifetime_value} across {data.purchases} order(s)
        </s-text>
        <s-text>Last purchase: {recency}</s-text>

        {data.revenue_at_risk > 0 && (
          <s-text>Revenue at risk: ${data.revenue_at_risk}</s-text>
        )}

        {data.winback_eligible ? (
          <s-button onClick={sendWinback} disabled={sending}>
            {sending ? 'Sending…' : 'Send win-back'}
          </s-button>
        ) : (
          <s-text>No win-back needed right now.</s-text>
        )}

        {notice && <s-banner tone="info">{notice}</s-banner>}
      </s-stack>
    </s-admin-block>
  );
}
