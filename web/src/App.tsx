import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clearToken, fetchMe, getToken } from './api';
import { DashboardPage } from './pages/Dashboard';
import { ItemDetailPage } from './pages/ItemDetail';
import { ItemsPage } from './pages/Items';
import { LoginPage } from './pages/Login';

function Layout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  function logout() {
    clearToken();
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  return (
    <div>
      <header
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          padding: 8,
          borderBottom: '1px solid #999',
        }}
      >
        <strong>Newtonite Ops</strong>
        <Link to="/">Dashboard</Link>
        <Link to="/items">Items</Link>
        <span style={{ marginLeft: 'auto' }}>
          {me.data ? `${me.data.name} (${me.data.email})` : ''}
        </span>
        <button onClick={logout}>Log out</button>
      </header>
      <main style={{ padding: 16 }}>
        <Outlet />
      </main>
    </div>
  );
}

function ProtectedLayout() {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Layout />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/items" element={<ItemsPage />} />
        <Route path="/items/:id" element={<ItemDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
