import { type ReactNode } from "react";
import type { NukeReplayClient } from "./client";
export interface NukeReplayProviderProps {
    client: NukeReplayClient;
    children: ReactNode;
    launcher?: boolean;
    shortcut?: boolean;
}
export declare function NukeReplayProvider({ client, children, launcher, shortcut, }: NukeReplayProviderProps): import("react").JSX.Element;
export declare function useNukeReplay(): NukeReplayClient;
//# sourceMappingURL=react.d.ts.map