import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#0f172a',
    background: '#f1f5f9',
    tint: '#2563eb',
    icon: '#64748b',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#2563eb',
  },
  dark: {
    text: '#f1f5f9',
    background: '#0f172a',
    tint: '#3b82f6',
    icon: '#94a3b8',
    tabIconDefault: '#64748b',
    tabIconSelected: '#3b82f6',
  },
};

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
