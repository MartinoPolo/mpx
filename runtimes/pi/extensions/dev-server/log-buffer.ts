import { StringDecoder } from "node:string_decoder";

export type LogStream = "stdout" | "stderr";

export interface LogEntry {
    readonly run: number;
    readonly stream: LogStream;
    readonly text: string;
}

interface StreamState {
    decoder: StringDecoder;
    partial: string;
    pendingCr: boolean;
}

const TERMINAL_CONTROLS = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001bP[\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_])/g;

export function stripTerminalControls(text: string): string {
    return text.replace(TERMINAL_CONTROLS, "");
}

export class RollingLogBuffer {
    readonly #maxCharacters: number;
    #run = 0;
    #entries: LogEntry[] = [];
    #size = 0;
    #states: Record<LogStream, StreamState> = this.createStates();

    constructor(options: { maxCharacters?: number } = {}) {
        this.#maxCharacters = Math.max(1, options.maxCharacters ?? 100_000);
    }

    beginRun(run: number): void {
        this.flush();
        this.#run = run;
        this.#states = this.createStates();
    }

    write(stream: LogStream, chunk: Uint8Array): void {
        const state = this.#states[stream];
        this.consume(stream, state.decoder.write(chunk));
    }

    flush(): void {
        for (const stream of ["stdout", "stderr"] as const) {
            const state = this.#states[stream];
            this.consume(stream, state.decoder.end());
            if (state.pendingCr) {
                this.emit(stream, state.partial);
                state.partial = "";
                state.pendingCr = false;
            } else if (state.partial !== "") {
                this.emit(stream, state.partial);
                state.partial = "";
            }
        }
    }

    entries(): readonly LogEntry[] {
        return this.#entries.map((entry) => Object.freeze({ ...entry }));
    }

    present(options: { maxCharacters?: number; maxLines?: number } = {}): string {
        const maxLines = Math.max(1, options.maxLines ?? 200);
        const maxCharacters = Math.max(1, options.maxCharacters ?? 20_000);
        let text = this.#entries.slice(-maxLines).map((entry) => stripTerminalControls(entry.text)).join("\n");
        if (text.length > maxCharacters) {
            text = maxCharacters === 1 ? "…" : `…${text.slice(-(maxCharacters - 1))}`;
        }
        return text;
    }

    private createStates(): Record<LogStream, StreamState> {
        return {
            stdout: { decoder: new StringDecoder("utf8"), partial: "", pendingCr: false },
            stderr: { decoder: new StringDecoder("utf8"), partial: "", pendingCr: false }
        };
    }

    private consume(stream: LogStream, text: string): void {
        const state = this.#states[stream];
        for (const character of text) {
            if (state.pendingCr) {
                state.pendingCr = false;
                if (character === "\n") {
                    this.emit(stream, state.partial);
                    state.partial = "";
                    continue;
                }
                // A bare carriage return rewrites the current progress frame.
                state.partial = "";
            }
            if (character === "\r") state.pendingCr = true;
            else if (character === "\n") {
                this.emit(stream, state.partial);
                state.partial = "";
            } else {
                state.partial += character;
                if (state.partial.length > this.#maxCharacters) {
                    state.partial = state.partial.slice(-this.#maxCharacters);
                }
            }
        }
    }

    private emit(stream: LogStream, text: string): void {
        if (text === "") return;
        const boundedText = text.length > this.#maxCharacters ? text.slice(-this.#maxCharacters) : text;
        const entry = Object.freeze({ run: this.#run, stream, text: boundedText });
        this.#entries.push(entry);
        this.#size += boundedText.length;
        while (this.#size > this.#maxCharacters) {
            const removed = this.#entries.shift()!;
            this.#size -= removed.text.length;
        }
    }
}
