export const DEV_SERVERS_CHANGED_EVENT = "dev-servers:changed";

export type DevServerState = "starting" | "ready" | "crashed" | "stopped";

export interface DevServerSnapshot {
    readonly id: string;
    readonly state: DevServerState;
    readonly pid: number | null;
    readonly cwd: string;
    readonly command: string;
    readonly ports: readonly number[];
    readonly readyPorts: readonly number[];
    readonly run: number;
    readonly generation: number;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly readyAt: string | null;
    readonly stoppedAt: string | null;
    readonly exitedAt: string | null;
    readonly updatedAt: string;
    readonly exitCode: number | null;
    readonly exitSignal: string | null;
    readonly exitStatus: string | null;
    readonly lastError: string | null;
}
