import {
  LayoutDashboard, Microscope, Radar, KeyRound, Swords, Clapperboard, PenLine, ImageIcon, ScanSearch, Scissors,
  Send, Workflow, CalendarDays, LineChart, FlaskConical, Bot, FolderOpen, Settings,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; description: string };

/** Navigation grouped by the creator's workflow stage. */
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: "", items: [{ href: "/overview", label: "Overview", icon: LayoutDashboard, description: "Performance and next best actions" }] },
  {
    group: "Plan",
    items: [
      { href: "/research", label: "AI Research", icon: Microscope, description: "Niche research, ideas, personas and briefs" },
      { href: "/trends", label: "Trend Radar", icon: Radar, description: "Trending content with momentum and alerts" },
      { href: "/keywords", label: "Keyword Explorer", icon: KeyRound, description: "Keywords, clusters and competition" },
      { href: "/competitors", label: "Competitor Intelligence", icon: Swords, description: "Public channel patterns and gaps" },
    ],
  },
  {
    group: "Create",
    items: [
      { href: "/studio", label: "Content Studio", icon: Clapperboard, description: "Projects and the content pipeline" },
      { href: "/scripts", label: "AI Script Writer", icon: PenLine, description: "Scripts, hooks and captions" },
      { href: "/thumbnails", label: "Thumbnail Lab", icon: ImageIcon, description: "Concepts and readability analysis" },
      { href: "/analyzer", label: "Video Analyzer", icon: ScanSearch, description: "Pre-publish video assessment" },
      { href: "/clips", label: "Clip Studio", icon: Scissors, description: "Turn long videos into captioned short clips" },
    ],
  },
  {
    group: "Ship",
    items: [
      { href: "/publishing", label: "Publishing Center", icon: Send, description: "Schedule and publish to platforms" },
      { href: "/automation", label: "Automation Workflows", icon: Workflow, description: "Scheduled and event-driven automations" },
      { href: "/calendar", label: "Content Calendar", icon: CalendarDays, description: "Plan and reschedule posts" },
    ],
  },
  {
    group: "Learn",
    items: [
      { href: "/analytics", label: "Analytics", icon: LineChart, description: "Verified platform metrics" },
      { href: "/experiments", label: "Experiments", icon: FlaskConical, description: "Title, thumbnail and hook tests" },
      { href: "/agents", label: "AI Agents", icon: Bot, description: "Reusable AI assistants" },
    ],
  },
  {
    group: "Library",
    items: [
      { href: "/media", label: "Media Library", icon: FolderOpen, description: "Uploads and generated assets" },
      { href: "/settings", label: "Settings", icon: Settings, description: "Profile, connections and integrations" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);
