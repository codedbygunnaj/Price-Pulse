import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import './styles.css';

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:4000';
const api = async (path, opts) => {
  const r = await fetch(`${API_URL}${path}`, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
};
const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');
const stockLabel = (v) => (v === true ? 'In stock' : v === false ? 'Out of stock' : 'Unknown');
const stockClass = (v) => (v === true ? 'in' : v === false ? 'out' : 'unk');

function App() {
  const [tracked, setTracked] = useState([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [toast, setToast] = useState(null);
  const reqId = useRef(0);

  const selected = tracked.find((p) => String(p.id) === String(selectedId)) || null;
  const say = (text, kind = 'info') => setToast({ text, kind });

  const loadTracked = async () => setTracked(await api('/api/tracked-products'));
  const loadDetail = async (id) => {
    const [h, l] = await Promise.all([api(`/api/tracked-products/${id}/history`), api(`/api/tracked-products/${id}/logs`)]);
    setHistory(h); setLogs(l);
  };

  useEffect(() => {
    loadTracked().catch((e) => say(e.message, 'error'));
    api('/api/catalog/status').then(setCatalog).catch(() => {});
  }, []);

  // debounced search; ignore stale responses
  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const my = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/products/search?q=${encodeURIComponent(query)}`);
        if (my === reqId.current) setResults(r);
      } catch (e) {
        if (my === reqId.current) { setResults([]); say(e.message, 'error'); }
      } finally {
        if (my === reqId.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const choose = async (p) => {
    setSelectedId(p.id); setHistory([]); setLogs([]);
    try { await loadDetail(p.id); } catch (e) { say(e.message, 'error'); }
  };

  const track = async (p) => {
    try {
      const x = await api('/api/tracked-products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id }) });
      await loadTracked(); setQ(''); setResults([]);
      await choose(x);
      say(`Now tracking ${x.name}. Refresh to get its first price.`, 'ok');
    } catch (e) { say(e.message, 'error'); }
  };

  const refresh = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api(`/api/scraper/run/${selected.id}`, { method: 'POST' });
      await Promise.all([loadTracked(), loadDetail(selected.id)]);
      r.status === 'success' ? say(`Price updated: ${money(r.price)}`, 'ok') : say(`Scrape failed: ${r.error}`, 'error');
    } catch (e) { say(e.message, 'error'); } finally { setBusy(false); }
  };

  const runAll = async () => {
    setBusy(true);
    try {
      const r = await api('/api/scraper/run', { method: 'POST' });
      const ok = r.results.filter((x) => x.status === 'success').length;
      await loadTracked(); if (selectedId) await loadDetail(selectedId);
      say(`${ok} of ${r.results.length} updated${ok < r.results.length ? ' — check scrape activity for failures' : ''}`, ok === r.results.length ? 'ok' : 'error');
    } catch (e) { say(e.message, 'error'); } finally { setBusy(false); }
  };

  const chart = [...history].reverse().map((x) => ({ ...x, price: Number(x.price), time: new Date(x.scraped_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }));
  const delta = history.length > 1 ? Number(history[0].price) - Number(history[1].price) : null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">₹</span><div><h1>PricePulse</h1><p>Price and stock tracker for INE Store</p></div></div>
        <div className="top-right">
          {catalog && <span className={`chip ${catalog.complete ? 'ok' : 'warn'}`} title={catalog.complete ? 'Full INE catalog loaded' : 'Some catalog pages failed to load. Search may miss products.'}>
            <span className="chip-dot" /> Catalog {catalog.loaded}{catalog.total ? ` / ${catalog.total}` : ''}
          </span>}
          <button className="btn primary top-action" onClick={runAll} disabled={busy || !tracked.length}>
            <span>{busy ? 'Working…' : 'Refresh all'}</span>
            {!busy && <span className="btn-icon">↻</span>}
          </button>
        </div>
      </header>

      <section className="search">
        <div className="section-title">
          <div>
            <label htmlFor="s">Find a product</label>
            <p>Search the INE catalog by product name, SKU or ID.</p>
          </div>
          <span className="search-hint">1000+ products</span>
        </div>
        <div className="search-box">
          <span className="search-icon">⌕</span>
          <input id="s" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SKU or ID — e.g. Copperpot Smart Ring, COP-10419" autoComplete="off" />
          {q && <button className="x" aria-label="Clear search" onClick={() => { setQ(''); setResults([]); }}>×</button>}
        </div>
        {q.trim() && (
          <div className="results">
            {searching ? <div className="note">Searching…</div>
              : results.length ? <>
                <div className="note">{results.length} product{results.length !== 1 ? 's' : ''} found</div>
                {results.map((p) => {
                  const exists = tracked.some((x) => String(x.id) === String(p.id));
                  return (
                    <div className="result" key={p.id}>
                      <div><strong>{p.name}</strong><small>{p.brand || '—'} · {p.sku || 'no SKU'} · ID {p.id}</small></div>
                      <button className="btn" disabled={exists} onClick={() => track(p)}>{exists ? 'Tracked' : 'Track'}</button>
                    </div>);
                })}</>
              : <div className="note">No product matches “{q}”. Try the SKU or a shorter name.</div>}
          </div>
        )}
      </section>

      <div className="grid">
        <aside className="panel list">
          <div className="panel-head"><h2>Tracked</h2><span className="count">{tracked.length}</span></div>
          {tracked.map((p) => (
            <button key={p.id} className={`item ${String(selectedId) === String(p.id) ? 'active' : ''}`} onClick={() => choose(p)}>
              <span className="item-name">{p.name}</span>
              <span className="item-price">{money(p.current_price)}</span>
              <span className="item-sub">{p.last_scraped_at ? `Checked ${when(p.last_scraped_at)}` : 'Not checked yet'}</span>
              <span className={`dot ${stockClass(p.current_stock)}`}>{stockLabel(p.current_stock)}</span>
            </button>
          ))}
          {!tracked.length && <div className="empty"><strong>Nothing tracked yet</strong><p>Search for a product above and press Track.</p></div>}
        </aside>

        <section className="panel detail">
          {selected ? <>
            <div className="detail-head">
              <div>
                <small>{selected.brand || 'INE Store'}{selected.sku ? ` · ${selected.sku}` : ''} · ID {selected.id}</small>
                <h2>{selected.name}</h2>
                <a href={selected.url} target="_blank" rel="noreferrer">Open on INE Store</a>
              </div>
              <button className="btn primary" onClick={refresh} disabled={busy}>{busy ? 'Checking…' : 'Refresh price'}</button>
            </div>

            <div className="price-row">
              <div className="price">
                <span className="label">Latest observed price</span>
                <b>{money(selected.current_price)}</b>
                {delta != null && delta !== 0 && <span className={`delta ${delta < 0 ? 'down' : 'up'}`}>{delta < 0 ? '▼' : '▲'} {money(Math.abs(delta))} since last check</span>}
                <small>{selected.last_scraped_at ? `Observed ${when(selected.last_scraped_at)}` : 'No price yet'}</small>
              </div>
              <div className="facts">
                <div><span className="label">Availability</span><span className={`pill ${stockClass(selected.current_stock)}`}>{stockLabel(selected.current_stock)}</span></div>
                <div><span className="label">Checks</span><b>{history.length}</b></div>
              </div>
            </div>

            <div className="chart">
              <div className="subhead">
                <div>
                  <h3>Price history</h3>
                  <p>Recent observed prices from scheduled or manual checks.</p>
                </div>
                <span className="live-badge">● Tracking</span>
              </div>
              {chart.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={chart} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke="#e3e8ef" vertical={false} />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} tickFormatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} width={70} />
                    <Tooltip formatter={(v) => [money(v), 'Price']} />
                    <Line type="monotone" dataKey="price" stroke="#0b5fff" strokeWidth={2.5} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <div className="empty"><strong>No prices recorded</strong><p>Press “Refresh price” to fetch the first one.</p></div>}
            </div>

            <div className="freshness-note">
              <span className="info-icon">i</span>
              <span>This is the latest observed store price. A price can change on the INE Store before the next check.</span>
            </div>

            <div className="two">
              <div>
                <h3>Recent checks</h3>
                {history.slice(0, 8).map((h, i) => (
                  <div className="row" key={i}><div><b>{money(h.price)}</b><small>{when(h.scraped_at)}</small></div><span className={`pill ${stockClass(h.stock)}`}>{stockLabel(h.stock)}</span></div>
                ))}
                {!history.length && <p className="muted">None yet.</p>}
              </div>
              <div>
                <h3>Scrape activity</h3>
                {logs.slice(0, 8).map((l, i) => (
                  <div className="row" key={i} title={l.error_message || ''}>
                    <div><b className={`st ${String(l.status).toLowerCase()}`}>{l.status}</b><small>{when(l.attempted_at)}{l.error_message ? ` · ${l.error_message.slice(0, 60)}` : ''}</small></div>
                    <span className="muted">{l.attempts || 1}× · {l.duration_ms ? `${(l.duration_ms / 1000).toFixed(1)}s` : ''}</span>
                  </div>
                ))}
                {!logs.length && <p className="muted">None yet.</p>}
              </div>
            </div>
          </> : <div className="empty big"><strong>Select a tracked product</strong><p>Its price, stock and history will show here.</p></div>}
        </section>
      </div>

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}<button aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);