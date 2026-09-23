import { divIcon } from 'leaflet';
import './nearby.css';

type Kind = 'hotel' | 'courier' | 'search' | 'driver' | 'radius';
const paths: Record<Kind, string> = {
  hotel: 'M3 21V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16M1 21h22M9 21v-5h6v5M7 7h2M15 7h2M7 11h2M15 11h2',
  courier: 'm12 3 9 5v8l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5M12 13v8M7.5 5.5l9 5v4',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  driver: 'M5 17H3V9h12v8H9M15 17h2m4 0h1v-5l-3-3h-4M7 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  radius: 'M12 2v3M12 19v3M2 12h3M19 12h3M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM12 9v3l2 2',
};
export function NearbyIcon({ kind, size = 20 }: { kind: Kind; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
const svg = (kind: Kind) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[kind]}"/></svg>`;
export function nearbyPlacePin(kind: 'hotel' | 'courier', label: string, active: boolean) {
  const escaped = label.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return divIcon({ className: `nearby-marker nearby-marker--${kind}${active ? ' is-active' : ''}`,
    html: `<div class="nearby-marker-label">${svg(kind)}<span>${escaped}</span></div>`,
    iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -18],
  });
}
export function nearbyDriverPin() {
  return divIcon({ className: 'nearby-driver-marker', html: svg('driver'), iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -22] });
}
