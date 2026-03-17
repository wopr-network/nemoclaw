#!/usr/bin/env node
// WOPR NemoClaw sidecar — exposes /internal/health and /internal/provision
// so nemoclaw-platform can use the same provision contract as paperclip-platform.
//
// Env vars:
//   WOPR_PROVISION_SECRET  — shared secret for auth
//   WOPR_GATEWAY_URL       — WOPR inference gateway base URL (e.g. https://gateway.wopr.bot/v1)
//   PORT                   — sidecar port (default: 3001)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SECRET = process.env.WOPR_PROVISION_SECRET ?? "";
const GATEWAY_URL = process.env.WOPR_GATEWAY_URL ?? "";
const PORT = parseInt(process.env.WOPR_SIDECAR_PORT ?? "3001", 10);
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

function assertSecret(req) {
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice("Bearer ".length).trim() === SECRET;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function isGatewayUp() {
  try {
    const logPath = "/tmp/gateway.log";
    if (!fs.existsSync(logPath)) return false;
    const tail = fs.readFileSync(logPath, "utf8").slice(-4096);
    // openclaw gateway prints "Listening" or "Gateway running" when ready
    return /listening|gateway running|started/i.test(tail);
  } catch {
    return false;
  }
}

function provision(body) {
  const { tenantId, tenantName, gatewayUrl, apiKey, budgetCents } = body;

  if (!tenantId || !tenantName) {
    throw new Error("Missing required fields: tenantId, tenantName");
  }

  const effectiveGateway = gatewayUrl || GATEWAY_URL;
  if (!effectiveGateway) {
    throw new Error("No gateway URL provided and WOPR_GATEWAY_URL not set");
  }

  // Point NemoClaw at WOPR's inference gateway instead of NVIDIA's
  const cfg = readJson(OPENCLAW_CONFIG_PATH);

  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model ??= {};
  cfg.agents.defaults.model.primary = "nvidia/nemotron-3-super-120b-a12b";

  cfg.models ??= {};
  cfg.models.mode = "merge";
  cfg.models.providers ??= {};
  cfg.models.providers["wopr-gateway"] = {
    baseUrl: effectiveGateway,
    apiKey: apiKey ?? "wopr-managed",
    api: "openai-completions",
    models: [
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron 3 Super 120B (via WOPR)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
      },
    ],
  };

  // Set WOPR gateway as the active provider
  cfg.agents.defaults.model.primary = "nvidia/nemotron-3-super-120b-a12b";
  cfg.gateway ??= {};
  cfg.gateway.inferenceProvider = "wopr-gateway";

  // Store tenant metadata for reference
  cfg._wopr = { tenantId, tenantName, budgetCents: budgetCents ?? 0, provisionedAt: new Date().toISOString() };

  writeJson(OPENCLAW_CONFIG_PATH, cfg);

  // Derive a stable tenantEntityId and slug from tenantId
  const tenantSlug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 32);
  const tenantEntityId = `e:${tenantId}`;

  return { tenantEntityId, tenantSlug };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check — no auth required
  if (req.method === "GET" && url.pathname === "/internal/health") {
    const up = isGatewayUp();
    res.writeHead(up ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: up, gateway: up ? "running" : "starting" }));
    return;
  }

  // Provision — auth required
  if (req.method === "POST" && url.pathname === "/internal/provision") {
    if (!assertSecret(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const result = provision(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[wopr-sidecar] listening on :${PORT}`);
});
