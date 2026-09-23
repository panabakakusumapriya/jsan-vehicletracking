import { registerWebModule, NativeModule } from 'expo';

import { VtsTrackerModuleEvents } from './VtsTracker.types';

// VtsTrackerModule is not available on the web platform.
class VtsTrackerModule extends NativeModule<VtsTrackerModuleEvents> {}

export default registerWebModule(VtsTrackerModule, 'VtsTrackerModule');
