import { AdminRoute } from "./components/Admin";
import { DashboardRoute } from "./components/Dashboard";
import { OverlayRoute } from "./components/Overlay";

// 저장된 테마를 모든 라우트에서 초기 적용 (오버레이는 라이트 오버라이드 대상이 아니라 영향 없음)
document.documentElement.dataset.theme = localStorage.getItem("chat-theme") === "light" ? "light" : "dark";

export function App() {
  const route = window.location.pathname;

  if (route.startsWith("/admin")) {
    return <AdminRoute />;
  }

  if (route.startsWith("/dashboard")) {
    return <DashboardRoute />;
  }

  return <OverlayRoute />;
}
