import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "./db.js";
import { decrypt, equal } from "./security.js";
import { extraPlatform } from "./bridge-types.js";
import type { BridgeNetwork } from "./bridge-network.js";
import type { BridgeConnectors } from "./bridge-connectors.js";
import type { TeamsPersonal } from "./teams-personal.js";
export async function registerBridgeRoutes(
  app: FastifyInstance,
  bridgeNetwork: BridgeNetwork,
  networkConnectors: BridgeConnectors,
  teamsPersonal: TeamsPersonal,
) {
  app.get("/api/bridge-network", async () => bridgeNetwork.view());
  app.put("/api/bridge-network/connections/:platform", async (req) =>
    networkConnectors.configure(
      extraPlatform.parse((req.params as any).platform),
      req.body,
    ),
  );
  app.delete("/api/bridge-network/connections/:platform", async (req) =>
    networkConnectors.disconnect(
      extraPlatform.parse((req.params as any).platform),
    ),
  );
  app.post("/api/bridge-network/connections/:platform/check", async (req) =>
    networkConnectors.checkConnection(
      extraPlatform.parse((req.params as any).platform),
    ),
  );
  app.post("/api/bridge-network/connections/:platform/webhook", async (req) =>
    networkConnectors.installWebhook(
      extraPlatform.parse((req.params as any).platform),
    ),
  );
  app.post("/api/bridge-network/rooms/:id/members", async (req) =>
    bridgeNetwork.add(z.uuid().parse((req.params as any).id), req.body),
  );
  app.patch("/api/bridge-network/members/:id", async (req) =>
    bridgeNetwork.update(z.uuid().parse((req.params as any).id), req.body),
  );
  app.delete("/api/bridge-network/members/:id", async (req) =>
    bridgeNetwork.remove(z.uuid().parse((req.params as any).id)),
  );
  app.get("/api/bridge-network/rooms/:id/history", async (req) =>
    bridgeNetwork.history(z.uuid().parse((req.params as any).id)),
  );
  app.post('/api/bridge-network/teams/chats/refresh',async()=>networkConnectors.refreshTeamsDirectory());
  app.get('/api/bridge-network/teams/state',async()=>teamsPersonal.browserState());
  app.post('/api/bridge-network/teams/attach-brave',async()=>teamsPersonal.attachVpsBrave());
  app.post("/api/bridge-network/teams/open", async () => teamsPersonal.open());
  app.get("/api/bridge-network/teams/screen", async () =>
    teamsPersonal.snapshot(),
  );
  app.post("/api/bridge-network/teams/action", async (req) =>
    teamsPersonal.action(req.body),
  );
  app.post("/api/bridge-network/teams/close", async () =>
    teamsPersonal.close(),
  );
  // Public ingress is isolated from the admin API. POST callbacks require provider HMAC signatures.
  await app.register(async (hooks) => {
    hooks.removeContentTypeParser("application/json");
    hooks.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );
    hooks.post(
      "/relay-hooks/:platform",
      { bodyLimit: 262144 },
      async (req, reply) => {
        const platform = z
          .enum(["viber", "whatsapp"])
          .parse((req.params as any).platform);
        if (typeof req.body !== "string")
          return reply.code(400).send({ error: "JSON required" });
        await networkConnectors.webhook(
          platform,
          req.body,
          req.headers[
            platform === "viber"
              ? "x-viber-content-signature"
              : "x-hub-signature-256"
          ] as string | undefined,
        );
        return { ok: true };
      },
    );
  });
  app.get("/relay-hooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>,
      c = await networkConnectors.config("whatsapp");
    if (
      !c ||
      q["hub.mode"] !== "subscribe" ||
      !q["hub.verify_token"] ||
      !equal(q["hub.verify_token"], c.config.verifyToken)
    )
      return reply.code(403).send({ error: "Verification failed" });
    return reply
      .type("text/plain")
      .send(z.string().max(512).parse(q["hub.challenge"]));
  });
  app.get("/relay-media/:token/:name", async (req, reply) => {
    const token = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse((req.params as any).token);
    const row = (
      await query(
        "SELECT * FROM bridge_media WHERE token=$1 AND expires_at>now()",
        [token],
      )
    ).rows[0];
    if (!row) return reply.code(404).send({ error: "File expired" });
    return reply
      .type(
        /^image\/(?:jpeg|png|gif)$/.test(row.mime)
          ? row.mime
          : "application/octet-stream",
      )
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(row.name),
      )
      .send(Buffer.from(decrypt(row.payload_cipher), "base64"));
  });
}
