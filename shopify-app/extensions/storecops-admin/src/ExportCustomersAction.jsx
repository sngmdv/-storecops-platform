import { render, } from 'preact';
import { useState, } from 'preact/hooks';
import { callApi, } from './api.js';

/**
 * Bulk "Export customers" action on the customer list.
 *
 * Pulls the store's customer list (optionally filtered to at-risk
 * customers) and hands it to the browser as a file, so a merchant can
 * take it into their own tooling.
 */

export default async () => {
  render(<Extension />, document.body,);
};

/** Trigger a client-side download for generated text content. */
function download(filename, content, contentType,) {
  const blob = new Blob([content,], { type: contentType, },);
  const url = URL.createObjectURL(blob,);
  const link = document.createElement('a',);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link,);
  link.click();
  document.body.removeChild(link,);
  URL.revokeObjectURL(url,);
}

function Extension() {
  const [format, setFormat] = useState('csv',);
  const [minChurn, setMinChurn] = useState('',);
  const [busy, setBusy] = useState(false,);
  const [result, setResult] = useState(null,);

  async function run() {
    setBusy(true,);
    setResult(null,);
    try {
      const body = { format, };
      if (minChurn.trim() !== '') body.min_churn_score = Number(minChurn,);

      const exported = await callApi('/ext/shop/customers/export', {
        method: 'POST',
        body,
      },);

      const content = exported.format === 'csv'
        ? exported.content
        : JSON.stringify(exported.customers, null, 2,);
      const contentType = exported.format === 'csv'
        ? 'text/csv'
        : 'application/json';

      download(exported.filename, content, contentType,);
      setResult({ ok: true, count: exported.count, },);
    } catch (error) {
      setResult({ ok: false, error: error.message, },);
    } finally {
      setBusy(false,);
    }
  }

  return (
    <s-admin-action heading="Export customers">
      <s-stack direction="block" gap="base">
        <s-text>
          Exports this store's customer list with purchase counts, lifetime
          value and recency.
        </s-text>

        <s-select
          label="Format"
          value={format}
          onChange={(event,) => setFormat(event.target.value,)}
        >
          <s-option value="csv">CSV</s-option>
          <s-option value="json">JSON</s-option>
        </s-select>

        <s-number-field
          label="Minimum churn score (optional)"
          value={minChurn}
          placeholder="e.g. 45"
          onInput={(event,) => setMinChurn(event.target.value,)}
        />

        {result && (
          <s-banner tone={result.ok ? 'success' : 'critical'}>
            {result.ok
              ? `Exported ${result.count} customer(s).`
              : result.error || 'Export failed.'}
          </s-banner>
        )}

        <s-button slot="primary-action" onClick={run} disabled={busy}>
          {busy ? 'Exporting…' : 'Export'}
        </s-button>

        <s-button slot="secondary-actions" onClick={() => globalThis.shopify?.close?.()}>
          {result?.ok ? 'Done' : 'Cancel'}
        </s-button>
      </s-stack>
    </s-admin-action>
  );
}
