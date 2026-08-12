export interface PlayerRange {
  min: number;
  max: number;
}

export interface GameCapabilities {
  tvLess: true;
  personalDevices?: boolean;
  dedicatedDisplay?: boolean;
}

export interface GameRuntime {
  command: string;
  args: string[];
  healthPath: string;
}

export interface GameManifest {
  schema: 1;
  id: string;
  name: string;
  description?: string;
  players: PlayerRange;
  capabilities: GameCapabilities;
  runtime: GameRuntime;
}

export interface NexusConfig {
  games: Array<{ path: string }>;
}

export interface InstalledGame {
  root: string;
  manifest: GameManifest;
}

export interface PublicGame {
  id: string;
  name: string;
  description?: string;
  players: PlayerRange;
  capabilities: GameCapabilities;
  status: "configured";
}
