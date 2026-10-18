import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@joc/ui/styles.css';
import './app.css';
import App from './App.tsx';
import { AuthGate } from './SignIn.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
