// Re-export the native module. On web, it will be resolved to VtsTrackerModule.web.ts
// and on native platforms to VtsTrackerModule.ts
export { default } from './src/VtsTrackerModule';
export * from './src/VtsTracker.types';
