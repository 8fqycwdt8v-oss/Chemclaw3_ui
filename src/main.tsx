import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthContext.tsx';
import { ConfigGate } from './ConfigGate.tsx';
import { App } from './App.tsx';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// ConfigGate outside AuthGate: a broken configuration must stop the app *before* an auth provider
// is chosen, not after. See `ConfigGate`'s docstring.
createRoot(container).render(
  <StrictMode>
    <ConfigGate>
      <AuthGate>
        <App />
      </AuthGate>
    </ConfigGate>
  </StrictMode>,
);
