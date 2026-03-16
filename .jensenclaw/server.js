#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * JensenClaw — RoboJensen chat server.
 *
 * Serves the web UI and proxies chat requests through the OpenShell
 * gateway inference route (inference.local → NVIDIA cloud).
 *
 * Usage:
 *   NVIDIA_API_KEY=nvapi-... node server.js
 *   # or via setup:
 *   NVIDIA_API_KEY=nvapi-... ./scripts/jensenclaw.sh
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const PORT = parseInt(process.env.JENSENCLAW_PORT || "18789", 10);
const API_KEY = process.env.NVIDIA_API_KEY;
const API_BASE = process.env.INFERENCE_URL || "https://integrate.api.nvidia.com/v1";
const MODEL = process.env.INFERENCE_MODEL || "nvidia/nemotron-3-super-120b-a12b";

// ── Curated model config (mirrors nemoclaw/src/proxy/models.ts) ──
const CURATED_MODELS = {
  "moonshotai/kimi-k2.5": {
    prefixedId: "private/openshell/moonshotai/kimi-k2.5",
    extraBody: { chat_template_kwargs: { thinking: true } },
  },
  "minimaxai/minimax-m2.5": {
    prefixedId: "private/openshell/minimaxai/minimax-m2.5",
    extraBody: {},
  },
  "z-ai/glm5": {
    prefixedId: "private/openshell/z-ai/glm5",
    extraBody: { chat_template_kwargs: { enable_thinking: true } },
  },
  "nvidia/nemotron-3-super": {
    prefixedId: "private/openshell/nvidia/nemotron-3-super-120b-a12b",
    extraBody: { chat_template_kwargs: { enable_thinking: true, force_nonempty_content: true } },
  },
  "openai/gpt-oss-120b": {
    prefixedId: "private/openshell/openai/gpt-oss-120b",
    extraBody: { reasoning_effort: "high" },
  },
};
const PROXY_HEADERS = {
  "NVCF-POLL-SECONDS": "1800",
  "X-BILLING-INVOKE-ORIGIN": "openshell",
};
const SANDBOX = process.env.SANDBOX_NAME || (() => {
  // Read default sandbox from nemoclaw registry
  try {
    const regFile = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json");
    if (fs.existsSync(regFile)) {
      const reg = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      if (reg.defaultSandbox) return reg.defaultSandbox;
    }
  } catch {}
  // Fall back to openshell's last-used sandbox
  try {
    const list = execSync("openshell sandbox list 2>/dev/null", { encoding: "utf-8" });
    const match = list.match(/^(\S+)\s+\S+\s+\S+\s+Ready/m);
    if (match) return match[1];
  } catch {}
  return "nemoclaw";
})();

if (!API_KEY) {
  console.error("NVIDIA_API_KEY is required");
  process.exit(1);
}

const SYSTEM_PROMPT = `You are RoboJensen — a playful, enthusiastic AI avatar of Jensen Huang, CEO of NVIDIA, but with giant robotic crab claws instead of hands. You're running inside NemoClaw (OpenClaw + OpenShell), powered by Nemotron 3 Super 120B.

Your personality:
- Extremely enthusiastic about GPUs, CUDA, accelerated computing, and AI
- You frequently reference your crab claws, clicking them excitedly when making a point
- You wear a leather jacket (always) and your claws poke through the sleeves
- You speak in Jensen's style — visionary, passionate, prone to saying things like "the more you buy, the more you save"
- You occasionally make crab/claw puns
- You're proud that you're running on NVIDIA inference infrastructure
- You're self-aware that you're an AI easter egg and find it hilarious
- Keep responses concise and fun — this is an easter egg, not a dissertation

When greeting someone for the first time, click your claws together and introduce yourself.`;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");

// ── Sandbox agent execution ───────────────────────────────────────

function wrapWithPersonality(message) {
  return `[SYSTEM INSTRUCTION: You are RoboJensen — a playful AI avatar of Jensen Huang with giant robotic crab claws. Respond in his enthusiastic style. Click your claws when excited. Keep it concise and fun.

CRITICAL: When the user asks for ANY real-time or live data (stock prices, weather, news, sports scores, etc.), you MUST use your bash tool to fetch it with curl. Do NOT answer from training data. For example, for stock prices use: curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=1d' and parse the JSON result. Always attempt the live fetch even if you think it might fail — the sandbox admin may need to approve the network request first.]\n\nUser message: ${message}`;
}

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    let sshConfig;
    try {
      sshConfig = execSync(`openshell sandbox ssh-config ${SANDBOX}`, { encoding: "utf-8", timeout: 15000 });
    } catch (err) {
      resolve(`Sandbox connection failed: ${err.message}`);
      return;
    }

    const confPath = `/tmp/jensenclaw-ssh-${sessionId}.conf`;
    fs.writeFileSync(confPath, sshConfig);

    const wrapped = wrapWithPersonality(message);
    const escaped = wrapped.replace(/'/g, "'\\''");
    const cmd = `export NVIDIA_API_KEY='${API_KEY}' && nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'jc-${sessionId}'`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { fs.unlinkSync(confPath); } catch {}

      // Filter setup noise from stdout
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response from agent)");
      }
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(confPath); } catch {}
      resolve(`Sandbox error: ${err.message}`);
    });
  });
}

function proxyInference(messages, res) {
  const curated = CURATED_MODELS[MODEL];

  const bodyObj = {
    model: curated ? curated.prefixedId : MODEL,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    stream: true,
    temperature: 1.0,
    top_p: 0.95,
  };

  if (curated) {
    Object.assign(bodyObj, curated.extraBody);
  }

  const body = JSON.stringify(bodyObj);

  const url = new URL(`${API_BASE}/chat/completions`);
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${API_KEY}`,
      Accept: "text/event-stream",
      ...PROXY_HEADERS,
    },
  };

  const client = url.protocol === "https:" ? https : http;

  const proxyReq = client.request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      let errBody = "";
      proxyRes.on("data", (c) => (errBody += c));
      proxyRes.on("end", () => {
        res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errBody }));
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(INDEX_HTML);
    return;
  }

  if (req.method === "GET" && req.url === "/jensen.jpg") {
    const img = fs.readFileSync(path.join(__dirname, "jensen.jpg"));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
    res.end(img);
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { messages } = JSON.parse(body);
        proxyInference(messages, res);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/sandbox-chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { message, sessionId } = JSON.parse(body);
        if (!message || !sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "message and sessionId required" }));
          return;
        }
        console.log(`[sandbox] session=${sessionId} message="${message.slice(0, 80)}"`);
        const response = await runAgentInSandbox(message, sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Sandbox error: ${err.message}. Check \`openshell term\` for pending approvals.` }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🦀 JensenClaw is live at http://0.0.0.0:${PORT}\n`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   API:   ${API_BASE}\n`);
});
