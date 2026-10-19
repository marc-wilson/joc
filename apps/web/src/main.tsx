import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@joc/ui/styles.css';
import './app.css';
import App from './App.tsx';
import { GitHubPage } from './GitHub.tsx';
import { HistoryPage } from './History.tsx';
import { InboxPage } from './Inbox.tsx';
import { LinkPage } from './Link.tsx';
import { AuthGate } from './SignIn.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const pages = new Map([
  ['/github', GitHubPage],
  ['/history', HistoryPage],
  ['/inbox', InboxPage],
  ['/link', LinkPage],
]);
const Page = pages.get(location.pathname) ?? App;

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <Page />
    </AuthGate>
  </StrictMode>,
);
