import { type ReactNode } from "react";
import type { NukeReplayClient } from "./client";
export interface NukeReplayProviderProps {
    client: NukeReplayClient;
    children: ReactNode;
    enabled?: boolean;
    launcher?: boolean;
    shortcut?: boolean;
}
export declare function NukeReplayProvider({ client, children, enabled, launcher, shortcut, }: NukeReplayProviderProps): import("react").JSX.Element;
export declare function useNukeReplay(): NukeReplayClient;
//# sourceMappingURL=react.d.ts.map