import './index.css';

import { requestExpandedMode } from '@devvit/web/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

export const Splash = () => {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4">
      <div className="max-w-sm w-full bg-slate-50 border border-slate-200 rounded-xl p-5 text-center">
        <h1 className="text-xl font-semibold text-slate-900">
          Smart Intelligent Queue
        </h1>
        <p className="text-sm text-slate-600 mt-2">
          Open the full moderation dashboard.
        </p>
        <button
          className="mt-4 px-4 py-2 rounded-md bg-orange-600 text-white"
          onClick={(event) => requestExpandedMode(event.nativeEvent, 'game')}
        >
          Open Dashboard
        </button>
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Splash />
  </StrictMode>
);
