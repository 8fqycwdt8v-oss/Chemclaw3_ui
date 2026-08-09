import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AuthGate } from './auth/AuthContext.tsx';
import { App } from './App.tsx';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/* Real URLs, not hashes: the BFF serves the SPA with `sirv(..., { single: true })`, so
        /jobs and /review already resolve to index.html on a cold load and a deep link works
        without a server change. MSAL's redirect also comes back to a real path. */}
    <BrowserRouter>
      <AuthGate>
        <App />
      </AuthGate>
    </BrowserRouter>
  </StrictMode>,
);
