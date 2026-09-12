import { render, } from 'preact';
import { useEffect, useState, } from 'preact/hooks';
import { callApi, selectedId, } from './api.js';

/**
 * "Send win-back" admin action on the customer page.
 *
 * Opens a modal so the merchant can pick a channel, optionally add an
 * offer, and send a personalised win-back without leaving the admin.
 */

export default async () => {
  render(<Extension />, document.body,);
};

/** Close the action modal if the runtime exposes a closer. */
function closeModal() {
  globalThis.shopify?.close?.();
}

function Extension() {
  const customerId = selectedId();
  const [insights, setInsights] = useState(null,);
  const [channel, setChannel] = useState('email',);
  const [offer, setOffer] = useState('',);
  const [sending, setSending] = useState(false,);
  const [result, setResult] = useState(null,);

  useEffect(() => {
    if (!customerId) return () => {};
    callApi(`/ext/shop/customer/${encodeURIComponent(customerId,)}/insights`,)
      .then(setInsights,)
      .catch(() => setInsights(null,),);
    return () => {};
  }, [customerId,],);

  async function send() {
    setSending(true,);
    setResult(null,);
    try {
      const body = { channel, };
      if (offer.trim()) body.offer = offer.trim();
      const sent = await callApi(
        `/ext/shop/customer/${encodeURIComponent(customerId,)}/winback`,
        { method: 'POST', body, },
      );
      setResult(sent,);
    } catch (error) {
      setResult({ ok: false, error: error.message, },);
    } finally {
      setSending(false,);
    }
  }

  // Reachability drives which channels are even offerable.
  const canEmail = insights?.has_email !== false;
  const canWhatsApp = insights?.has_phone === true;

  return (
    <s-admin-action heading="Send win-back">
      <s-stack direction="block" gap="base">
        {insights?.found && (
          <s-text>
            {insights.risk_band} churn risk ({insights.churn_score}/100) · $
            {insights.lifetime_value} lifetime value
          </s-text>
        )}

        {!insights?.found && (
          <s-banner tone="warning">
            No Storecops history for this customer yet — a win-back may not
            be effective.
          </s-banner>
        )}

        <s-select
          label="Channel"
          value={channel}
          onChange={(event,) => setChannel(event.target.value,)}
        >
          <s-option value="email" disabled={!canEmail}>
            Email
          </s-option>
          <s-option value="whatsapp" disabled={!canWhatsApp}>
            WhatsApp
          </s-option>
        </s-select>

        <s-text-field
          label="Offer (optional)"
          value={offer}
          placeholder="e.g. 15% off your next order"
          onInput={(event,) => setOffer(event.target.value,)}
        />

        {result && (
          <s-banner tone={result.ok ? 'success' : 'critical'}>
            {result.ok
              ? 'Win-back message sent.'
              : result.reason || result.error || 'Win-back was not sent.'}
          </s-banner>
        )}

        <s-button
          slot="primary-action"
          onClick={send}
          disabled={sending || result?.ok}
        >
          {sending ? 'Sending…' : 'Send win-back'}
        </s-button>

        <s-button slot="secondary-actions" onClick={closeModal}>
          {result?.ok ? 'Done' : 'Cancel'}
        </s-button>
      </s-stack>
    </s-admin-action>
  );
}
