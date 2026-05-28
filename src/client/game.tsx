// Modecule dashboard entry point.
//
// Keep this file deliberately thin: it loads global styles and mounts
// the App component into the DOM. All dashboard logic and JSX lives
// under src/client/app/.

import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
