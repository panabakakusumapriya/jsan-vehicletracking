export type VtsLocation = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    speed: number;   // m/s
    heading: number; // degrees
    altitude: number;
  };
  timestamp: number; // epoch ms
};

export type VtsTrackerModuleEvents = {
  onLocation: (location: VtsLocation) => void;
};
