import { ProviderError, providerRegistry, type ProviderRole } from "./registry.js";
import { runProviderCommand, type ProviderProcessExecutor, type ProviderProcessRequest } from "./process.js";

export interface ProviderProbeRequest {
  readonly providerId: string;
  readonly role: ProviderRole;
  readonly route?: string;
  readonly cwd?: string;
}

export type ProviderProbeResult =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "unsupported" }>
  | Readonly<{ status: "error"; error: Readonly<{ code: string; message: string; retryable: boolean }> }>;

function probeCommand(request: ProviderProbeRequest): ProviderProcessRequest & { providerId: string } | undefined {
  const descriptor = providerRegistry.get(request.providerId, request.role);
  const common = {
    providerId: request.providerId,
    ...(request.route === undefined ? {} : { route: request.route }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
  };
  switch (descriptor.backend) {
    case "gh": return { ...common, argv: ["gh", "auth", "status"], authExitCodes: [1, 4] };
    case "glab": return { ...common, argv: ["glab", "auth", "status"], authExitCodes: [1] };
    case "kf": return { ...common, argv: ["kf", "issue", "list", "--json"] };
    default: return undefined;
  }
}

export async function probeProvider(request: ProviderProbeRequest, executor: ProviderProcessExecutor): Promise<ProviderProbeResult> {
  const command = probeCommand(request);
  if (command === undefined) return { status: "unsupported" };
  if (request.route === undefined) {
    return { status: "error", error: { code: "PROVIDER_ROUTE_REQUIRED", message: "A configured provider route is required.", retryable: false } };
  }
  try {
    await runProviderCommand(command, executor, output => {
      if (request.providerId === "kanbanflow") {
        const parsed = JSON.parse(output) as unknown;
        if (!Array.isArray(parsed)) throw new Error("array expected");
      }
      return undefined;
    });
    return { status: "ready" };
  } catch (error) {
    if (error instanceof ProviderError) {
      return { status: "error", error: { code: error.code, message: error.message, retryable: error.retryable === true } };
    }
    return { status: "error", error: { code: "COMMAND_FAILURE", message: "The provider probe failed.", retryable: true } };
  }
}
