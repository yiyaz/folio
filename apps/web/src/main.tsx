import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './styles.css';
import { App } from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './components/ui';
import { DialogProvider } from './components/dialogs';
import { ErrorBoundary } from './components/ErrorBoundary';

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 15_000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ErrorBoundary>
          <ToastProvider>
            <DialogProvider>
              <AuthProvider>
                <App />
              </AuthProvider>
            </DialogProvider>
          </ToastProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
