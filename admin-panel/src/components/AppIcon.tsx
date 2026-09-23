const paths = {
  "close": "M6 6l12 12M18 6 6 18",
  "download": "M12 3v12M7 10l5 5 5-5M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4",
  "search": "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",

  "map": "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15",
  "route": "M6 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM9 19h8a4 4 0 0 0 0-8H7a3 3 0 0 1 0-6h8",
  "users": "M15 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM17 4a4 4 0 0 1 0 7M21 21v-3a4 4 0 0 0-3-3.9",
  "report": "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6M8 13h8M8 17h5",
  "vehicle": "M3 16V6h12v10H9M15 9h4l3 4v3h-1M3 16H1M15 16h2M7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  "phone": "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM10 18h4M10 5h4",
  "weather": "M7 17H5a3 3 0 1 1 1-5.8A5 5 0 0 1 16 10a3.5 3.5 0 1 1 1 7H7ZM16 3v2M21 5l-1 1M22 10h-2M9 20v2M14 20v2",
  "hotel": "M3 21V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16M1 21h22M9 21v-5h6v5M7 7h2M15 7h2M7 11h2M15 11h2",
  "parcel": "m12 3 9 5v8l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5M12 13v8M7.5 5.5l9 5v4",
  "coverage": "M3 5l6-2 6 2 6-2v15l-6 3-6-3-6 3V5ZM9 3v6M15 5v4M8 13l3 3 6-7",
  "health": "M2 12h5l3-8 4 16 3-8h5",
  "history": "M3 3v5h5M3 8a9 9 0 1 1-1 7M12 7v5l4 2",
  "folder": "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM3 10h18",
  "upload": "M12 16V3M7 8l5-5 5 5M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4",
  "pin": "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  "grid": "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 9h18M9 9v12",
  "clock": "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6v6l4 2",
  "shield": "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM8 12l3 3 5-6"
} as const;
export type AppIconName = keyof typeof paths;
export function AppIcon({ name, size = 20 }: { name: AppIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function PageIcon({ name }: { name: AppIconName }) {
  return <span className={`page-emblem page-emblem--${name}`}><AppIcon name={name} size={23} /></span>;
}
