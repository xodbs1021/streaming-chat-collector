import type { FastifyInstance } from "fastify";
import { AppState } from "../state";
import type { ChatProvider, ConnectProviderRequest, ProviderDiagnosticLog } from "../../shared/types";

interface ProviderRouteDeps {
  state: AppState;
  providerLogs: ProviderDiagnosticLog[];
  connectProvider: (request: ConnectProviderRequest) => Promise<{ ok: boolean } & Record<string, unknown>>;
  disconnectProvider: (
    provider?: ChatProvider,
    updateStatus?: boolean,
    statusTarget?: Pick<ConnectProviderRequest, "provider" | "sourceMode">
  ) => Promise<void>;
}

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderRouteDeps) {
  const { state, providerLogs, connectProvider, disconnectProvider } = deps;

  app.get("/api/providers/logs", async () => providerLogs);

  app.post<{ Body: ConnectProviderRequest }>("/api/providers/chzzk/connect", async (request, reply) => {
    const result = await connectProvider(request.body ?? { provider: "chzzk", sourceMode: "official" });
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.post("/api/providers/chzzk/disconnect", async () => {
    await disconnectProvider("chzzk", true, { provider: "chzzk", sourceMode: "official" });
    return { ok: true, providerStatus: state.getStatus("chzzk"), providerStatuses: state.getStatuses() };
  });

  app.post<{ Body: ConnectProviderRequest }>("/api/providers/soop/connect", async (request, reply) => {
    const result = await connectProvider(request.body ?? { provider: "soop", sourceMode: "unofficial" });
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.post("/api/providers/soop/disconnect", async () => {
    await disconnectProvider("soop", true, { provider: "soop", sourceMode: "unofficial" });
    return { ok: true, providerStatus: state.getStatus("soop"), providerStatuses: state.getStatuses() };
  });
}
