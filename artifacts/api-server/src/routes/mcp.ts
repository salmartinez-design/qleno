import { Router, type Request, type Response } from "express";
import { requireApiKey, logApiRequest } from "../lib/api-auth.js";
import { dispatchV1 } from "../lib/mcp-dispatch.js";
import { TOOLS_BY_NAME, toolsForScopes } from "../lib/mcp-tools.js";

// [ai-access 2026-08-15] Qleno Agent — the MCP endpoint, mounted at /api/mcp.
// Design: docs/AI_ACCESS_DESIGN.md §9-§11.
//
// WHAT THIS IS
// ------------
// Model Context Protocol over streamable HTTP: one POST per JSON-RPC message,
// the API key as a bearer token. That transport was chosen because it is the
// one Claude custom connectors, ChatGPT, and Gemini all speak without
// per-client special cases — and this feature exists precisely because Sal is on
// Claude while Maribel and Francisco are on Gemini. An assistant-specific
// integration would have been a smaller build and the wrong product.
//
// WHY IT IS HAND-ROLLED
// ---------------------
// @modelcontextprotocol/sdk is not a dependency of this repo. The surface we
// actually need is five methods and a strict request/response shape — roughly
// this file's length — against a new dependency in the request path of a tenant
// feature that reaches customer data. Wiring it by hand keeps that path made of
// code this repo owns and can audit. If the protocol grows past what is here,
// revisit; the tool table in lib/mcp-tools.ts is already independent of this.
//
// WHAT IT DOES NOT DO
// -------------------
// No sessions, no resources, no prompts, no server-initiated messages, no SSE.
// Every tool is a stateless read, so there is nothing to keep between calls and
// nothing for the server to push. Advertising capabilities we do not implement
// would make clients wait on streams that never arrive.

const router = Router();

// The protocol revisions we can actually satisfy. A client that asks for
// something else is answered with our newest rather than refused: per the spec
// it may then continue or disconnect, and refusing outright would break clients
// that would have worked fine.
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const SERVER_INFO = { name: "qleno", title: "Qleno", version: "1.0.0" };

// JSON-RPC 2.0 error codes. The first four are the spec's; -32002 is MCP's
// convention for "the server understood and refused".
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const REQUEST_DENIED = -32002;

type JsonRpcId = string | number | null;

function rpcError(res: Response, id: JsonRpcId, code: number, message: string, data?: unknown): void {
  // HTTP stays 200 for a well-formed JSON-RPC error: the transport succeeded and
  // the error is in the envelope. Clients that see a non-200 tend to retry or
  // surface a connection failure, which would misreport "you lack that scope"
  // as "Qleno is down".
  res.status(200).json({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function rpcResult(res: Response, id: JsonRpcId, result: unknown): void {
  res.status(200).json({ jsonrpc: "2.0", id, result });
}

/**
 * A tool result the model can read.
 *
 * MCP carries tool output as content blocks, and every client renders text. The
 * payload is pretty-printed JSON rather than prose: the model is better at
 * reading structure than our summarizer would be at writing it, and a summary
 * would be a second place where units and edge cases could go wrong.
 */
function toolContent(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

router.use(logApiRequest("mcp"));

/**
 * MCP is POST-only here.
 *
 * Streamable HTTP allows a GET that opens an SSE stream for server-initiated
 * messages. We have none to send, so a client that opens one would hold a
 * connection forever waiting. Saying so plainly beats a silent hang.
 */
router.get("/", (_req: Request, res: Response) => {
  res.status(405).json({
    error: "method_not_allowed",
    message: "This MCP endpoint accepts POST only. It sends no server-initiated messages, so there is no stream to open.",
  });
});

router.post("/", requireApiKey("mcp"), async (req: Request, res: Response) => {
  const body = req.body;

  // Batches are refused rather than half-supported. Each entry could be a
  // different tool, and the usage log records ONE route name per HTTP request —
  // so a batch would be metered as a single call under whichever name we picked,
  // and a tenant reading their own activity would see fewer calls than they made.
  // Every client we target sends one message per request.
  if (Array.isArray(body)) {
    rpcError(res, null, INVALID_REQUEST, "Batched JSON-RPC requests are not supported. Send one message per request.");
    return;
  }
  if (!body || typeof body !== "object") {
    rpcError(res, null, PARSE_ERROR, "Request body must be a single JSON-RPC 2.0 object.");
    return;
  }

  const id: JsonRpcId = body.id === undefined ? null : body.id;
  const method = typeof body.method === "string" ? body.method : null;
  const params = (body.params ?? {}) as Record<string, any>;

  if (!method) {
    rpcError(res, id, INVALID_REQUEST, "Missing 'method'.");
    return;
  }

  // The name recorded in the tenant's activity log. Overwritten with the actual
  // tool for tools/call, which is the row an operator wants to see.
  (req as any).mcpToolName = method;

  const scopes = req.apiKey?.scopes ?? [];
  // [ai-access-oauth 2026-08-16] Two credential shapes reach this router now,
  // and they are fixed in different places. A key's scopes are edited on the
  // settings page; a chat app's are frozen at the moment the tenant approved
  // it, so the only way to widen them is to connect the app again and approve
  // the larger set. Telling a Claude user to "add the scope under Settings"
  // sends them to a screen with no control that does it.
  const isChatApp = req.apiKey?.credential === "oauth";
  const widenScope = isChatApp
    ? "Disconnect it under Settings → AI & API Access and connect it again, approving that access."
    : "An owner or admin can add it under Settings → AI & API Access.";

  switch (method) {
    // ── Handshake ────────────────────────────────────────────────────────────
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      rpcResult(res, id, {
        protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        // Only tools. listChanged is false because the set a key can reach is
        // fixed by its scopes, and scopes cannot change mid-connection — the key
        // would have to be edited, which ends the session at the next request
        // anyway since every call re-verifies.
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Qleno runs a residential and commercial cleaning business: the job schedule, the customer book, invoices, and payroll. " +
          "Every tool reads live data for this company only and nothing here can change anything. " +
          "Money is US dollars, hours are decimal hours, and dates are YYYY-MM-DD in the company's own timezone — omit a date to get today. " +
          "List results are paginated: when a response carries next_cursor there are more rows, so page through before stating any total. " +
          "Read each tool's description before choosing between similar ones; several draw a distinction that matters, such as booked revenue versus money actually owed.",
      });
      return;
    }

    // Notifications carry no id and get no result — only an acknowledgement that
    // the transport accepted them.
    case "notifications/initialized":
    case "notifications/cancelled":
      res.status(202).end();
      return;

    case "ping":
      rpcResult(res, id, {});
      return;

    // ── Discovery ────────────────────────────────────────────────────────────
    case "tools/list": {
      // Filtered by the key's scopes: advertising a tool that tools/call would
      // refuse teaches the model to retry something that can never work, and
      // leaks the shape of data this key was deliberately not given.
      const visible = toolsForScopes(scopes);
      rpcResult(res, id, {
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          // Advertised on every tool because every tool here is a read. When
          // Phase 5 adds writes, this is the flag that must stop being constant.
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
        // No nextCursor: the whole table is small and returned in one page.
      });
      return;
    }

    // ── Execution ────────────────────────────────────────────────────────────
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : null;
      if (!name) { rpcError(res, id, INVALID_PARAMS, "tools/call requires a tool name."); return; }

      (req as any).mcpToolName = name;

      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        rpcError(res, id, INVALID_PARAMS, `No such tool: ${name}. Call tools/list for what this ${isChatApp ? "connection" : "key"} can use.`, {
          available: toolsForScopes(scopes).map((t) => t.name),
        });
        return;
      }

      // Scope is re-checked here and not only at tools/list. A client may call a
      // tool name it learned from a stale list, from another tenant's
      // documentation, or from a prompt injection — the list is a convenience,
      // this is the control.
      if (!scopes.includes(tool.scope)) {
        rpcError(res, id, REQUEST_DENIED,
          `${isChatApp ? "This connection" : "This key"} cannot use ${name}: ` +
          `it is missing the ${tool.scope} scope. ${widenScope}`);
        return;
      }

      const built = tool.build((params.arguments ?? {}) as Record<string, unknown>);
      if ("error" in built) {
        // A bad argument comes back as a tool error rather than a protocol
        // error, so the model sees it as a result it can correct and retry
        // instead of a broken connection.
        rpcResult(res, id, toolContent({ error: "invalid_argument", message: built.error }, true));
        return;
      }

      let out;
      try {
        out = await dispatchV1(req, built.path, built.query);
      } catch (err) {
        console.error(`[mcp] ${name} threw`, err);
        rpcError(res, id, INTERNAL_ERROR, "The request could not be completed.");
        return;
      }

      // Row count for the usage log — the same field the REST path records, so
      // both surfaces are measured the same way.
      const rows = Array.isArray((out.body as any)?.data)
        ? (out.body as any).data.length
        : Array.isArray((out.body as any)?.jobs)
          ? (out.body as any).jobs.length
          : out.status === 200 ? 1 : 0;
      (res as any).qlenoResultCount = rows;

      // A 4xx from v1 is handed back as a tool error carrying v1's own message.
      // Those messages were written to be actionable ("from must be a date as
      // YYYY-MM-DD"), and replacing them with something generic here would throw
      // away the one thing that lets the model fix its own call.
      rpcResult(res, id, toolContent(out.body, out.status >= 400));
      return;
    }

    default:
      rpcError(res, id, METHOD_NOT_FOUND,
        `Unsupported method: ${method}. This server implements initialize, tools/list, tools/call, and ping.`);
      return;
  }
});

export default router;
