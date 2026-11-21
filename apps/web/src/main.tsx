import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import './index.css';
import './lib/i18n.ts';
import { AuthProvider, useAuth } from './lib/auth.tsx';
import { useTheme } from './lib/theme.ts';
import { router } from './router.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } },
});

function App() {
  useTheme();
  const auth = useAuth();
  // the router waits for the first session refresh, then re-checks guards
  if (!auth.ready) return <p className="p-6 text-ink-soft">Loading…</p>;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
