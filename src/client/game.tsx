import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useDashboard } from './hooks/useDashboard';

export const App = () => {
  const { loading, queueLength, highRiskCount, topViolationTypes, items, claim, takeAction, bulkAction } = useDashboard();

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <header className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
          <h1 className="text-2xl font-semibold">Smart Intelligent Queue</h1>
          <p className="text-sm text-slate-600">Automated mod queue prioritization and one-click actions.</p>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <span className="px-3 py-1 bg-slate-200 rounded-full">Queue: {queueLength}</span>
            <span className="px-3 py-1 bg-rose-100 text-rose-700 rounded-full">High risk: {highRiskCount}</span>
          </div>
        </header>

        <section className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
          <div className="flex flex-wrap gap-2 mb-3">
            <button className="px-3 py-2 rounded-md bg-emerald-600 text-white" onClick={() => bulkAction('approve')}>
              Bulk Smart Approve
            </button>
            <button className="px-3 py-2 rounded-md bg-rose-600 text-white" onClick={() => bulkAction('remove')}>
              Bulk Smart Remove
            </button>
          </div>
          <h2 className="text-sm font-semibold mb-2">Top Violations</h2>
          <div className="flex flex-wrap gap-2">
            {topViolationTypes.map((item) => (
              <span key={item.name} className="px-2 py-1 bg-amber-100 text-amber-900 rounded-full text-xs">
                {item.name}: {item.count}
              </span>
            ))}
            {topViolationTypes.length === 0 && <span className="text-xs text-slate-500">No violations yet.</span>}
          </div>
        </section>

        <section className="space-y-3">
          {loading && <div className="text-sm text-slate-600">Loading queue...</div>}
          {items.map((item) => (
            <article key={item.itemId} className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-500">u/{item.authorName} • {item.contentKind}</p>
                  <p className="font-medium">Risk: {(item.riskScore * 100).toFixed(0)}%</p>
                  <p className="text-sm mt-1">{item.explanation}</p>
                </div>
                <div className="flex gap-2">
                  <button className="px-2 py-1 text-xs rounded bg-slate-200" onClick={() => claim(item.itemId)}>
                    Claim
                  </button>
                  <button className="px-2 py-1 text-xs rounded bg-emerald-600 text-white" onClick={() => takeAction(item.itemId, 'approve')}>
                    Approve
                  </button>
                  <button className="px-2 py-1 text-xs rounded bg-rose-600 text-white" onClick={() => takeAction(item.itemId, 'remove')}>
                    Remove
                  </button>
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
