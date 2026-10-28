/**
 * Weather condition icons, drawn here rather than taken from the system emoji font.
 *
 * Emoji are the OS's: on Windows "☁️" is a pale white cloud that reads as an empty box on a light
 * card, and every platform draws them differently. These are one flat set, legible on light and
 * dark, and usable both in HTML and nested inside an SVG chart (pass x / y).
 *
 * Keys are services/weatherCodes.js iconFor(): sun-d, sun-n, partly-d, partly-n, cloud, fog,
 * drizzle, rain, showers, snow, storm.
 */
const SUN = '#f59e0b';
const MOON = '#94a3b8';
const CLOUD = '#cbd5e1';
const CLOUD_EDGE = '#64748b';
const DARK_CLOUD = '#64748b';
const RAIN = '#2563eb';
const BOLT = '#facc15';

function Sun({ cx = 12, cy = 12, r = 4.6, rays = true }: { cx?: number; cy?: number; r?: number; rays?: boolean }) {
  return (
    <g>
      {rays && Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return (
          <line key={i} x1={cx + Math.cos(a) * (r + 2)} y1={cy + Math.sin(a) * (r + 2)}
            x2={cx + Math.cos(a) * (r + 4.2)} y2={cy + Math.sin(a) * (r + 4.2)}
            stroke={SUN} strokeWidth={1.8} strokeLinecap="round" />
        );
      })}
      <circle cx={cx} cy={cy} r={r} fill={SUN} />
    </g>
  );
}

function Moon({ cx = 12, cy = 11 }: { cx?: number; cy?: number }) {
  return <path d={`M${cx + 3.5},${cy - 6} a6.5,6.5 0 1,0 3.5,10.5 a5,5 0 1,1 -3.5,-10.5 z`} fill={MOON} />;
}

/** A cloud whose base sits on y = base, centred on cx. */
function Cloud({ cx = 12, base = 17, s = 1, dark = false }: { cx?: number; base?: number; s?: number; dark?: boolean }) {
  const fill = dark ? DARK_CLOUD : CLOUD;
  const d = `M${cx - 7 * s},${base} h${14 * s} a${3.6 * s},${3.6 * s} 0 0,0 ${-0.6 * s},${-7.1 * s}` +
    ` a${4.8 * s},${4.8 * s} 0 0,0 ${-9 * s},${-1.2 * s} a${3.4 * s},${3.4 * s} 0 0,0 ${-4.4 * s},${8.3 * s} z`;
  return <path d={d} fill={fill} stroke={CLOUD_EDGE} strokeWidth={1.1} strokeLinejoin="round" />;
}

function Drops({ y = 18.5, count = 3, long = true }: { y?: number; count?: number; long?: boolean }) {
  const xs = count === 2 ? [9.5, 14.5] : [7.5, 12, 16.5];
  return (
    <g stroke={RAIN} strokeWidth={1.8} strokeLinecap="round">
      {xs.map((x) => <line key={x} x1={x} y1={y} x2={x - 1.2} y2={y + (long ? 4 : 1.6)} />)}
    </g>
  );
}

function Glyph({ icon }: { icon: string }) {
  switch (icon) {
    case 'sun-d':
      return <Sun />;
    case 'sun-n':
      return <Moon />;
    case 'partly-d':
      return <><Sun cx={9} cy={8.5} r={3.8} /><Cloud cx={13.5} base={19.5} s={0.85} /></>;
    case 'partly-n':
      return <><Moon cx={8.5} cy={8} /><Cloud cx={13.5} base={19.5} s={0.85} /></>;
    case 'cloud':
      return <><Cloud cx={9.5} base={13.5} s={0.6} /><Cloud cx={13} base={19} s={0.95} /></>;
    case 'fog':
      return (
        <>
          <Cloud cx={12} base={12.5} s={0.8} />
          <g stroke={CLOUD_EDGE} strokeWidth={1.7} strokeLinecap="round">
            <line x1={4} y1={15.5} x2={20} y2={15.5} />
            <line x1={6} y1={18.5} x2={18} y2={18.5} />
            <line x1={8} y1={21.5} x2={16} y2={21.5} />
          </g>
        </>
      );
    case 'drizzle':
      return <><Cloud base={15} /><Drops y={17.5} long={false} /></>;
    case 'rain':
      return <><Cloud base={15} dark /><Drops y={17} /></>;
    case 'showers':
      return <><Sun cx={8} cy={7} r={3.4} /><Cloud cx={13} base={15.5} s={0.9} /><Drops y={17.5} count={2} /></>;
    case 'snow':
      return (
        <>
          <Cloud base={15} />
          <g fill="#60a5fa">
            <circle cx={8} cy={19} r={1.3} /><circle cx={12} cy={21} r={1.3} /><circle cx={16} cy={19} r={1.3} />
          </g>
        </>
      );
    case 'storm':
      return (
        <>
          <Cloud base={14.5} dark />
          <path d="M12.5,14.5 L9.5,19.5 H12 L10.5,23.5 L15.5,17.5 H13 L14.5,14.5 Z" fill={BOLT} stroke="#a16207" strokeWidth={0.6} strokeLinejoin="round" />
        </>
      );
    default:
      return <circle cx={12} cy={12} r={1.6} fill={CLOUD_EDGE} />;
  }
}

/** A weather icon. In HTML give `size`; inside an SVG also give `x` / `y` (top-left). */
export function WeatherIcon({ icon, size = 24, x, y, title }: {
  icon: string | null | undefined; size?: number; x?: number; y?: number; title?: string;
}) {
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title ?? icon ?? 'weather'}
      style={x == null ? { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 } : undefined}>
      {title && <title>{title}</title>}
      <Glyph icon={icon ?? ''} />
    </svg>
  );
}
