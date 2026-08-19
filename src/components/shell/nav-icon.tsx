import {
  BarChart3,
  CalendarDays,
  CreditCard,
  Images,
  LayoutDashboard,
  Send,
  Settings,
  Share2,
} from "lucide-react";

import type { NavKey } from "@/features/workspaces/navigation";

const ICONS: Record<NavKey, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  publish: Send,
  calendar: CalendarDays,
  media: Images,
  accounts: Share2,
  analytics: BarChart3,
  settings: Settings,
  billing: CreditCard,
};

export function NavIcon({ name, className = "h-4 w-4" }: { name: NavKey; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" className={className} />;
}
