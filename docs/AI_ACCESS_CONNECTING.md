# Connecting an AI assistant to Qleno

*Companion to `AI_ACCESS_DESIGN.md`. This is the operator-facing half: how a
tenant points Claude, ChatGPT, or Gemini at their own Qleno data.*

---

## What this gives you

Ask questions about your business in plain English and get answers from live
data. "Who's unassigned tomorrow?" "What did we bill National Able in July?"
"Which cleaners are running over budget this month?"

The assistant reads. In this phase it cannot change anything — not a job, not a
price, not a message to a customer. Write access is a later, separately gated
step.

## What you need

1. **A Pro plan.** API and AI access is a Pro feature.
2. **An owner or admin account.** Office users can use a key someone made for
   them; they cannot create one. Technicians cannot hold one at all.
3. **An API key**, from Settings → AI & API Access. The key is shown once, at
   creation. Copy it then; it cannot be retrieved later, only replaced.

A key looks like `qlno_live_XXXXXXXXXXXX_...`. Treat it like a password to your
whole office: anyone holding it sees everything your role can see.

## The connection details

| | |
|---|---|
| **Server URL** | `https://workspaceapi-server-production-b9d4.up.railway.app/api/mcp` |
| **Transport** | Streamable HTTP |
| **Authentication** | Bearer token — the API key |

---

## Claude

1. Open **Settings → Connectors → Add custom connector**.
2. Name it `Qleno`.
3. Paste the server URL above.
4. Under authentication, choose a bearer token and paste your API key.
5. Save, then enable the connector in a chat.

Claude will list the Qleno tools it can use. Ask it something you already know
the answer to first — today's schedule is a good check.

## ChatGPT

1. Open **Settings → Connectors → Create** (available on Plus, Pro, Team, and
   Enterprise; the exact menu name moves around).
2. Choose an MCP server, paste the URL, and set the bearer token to your API key.
3. Enable the connector in a conversation.

## Gemini

Gemini reaches MCP servers through Gemini CLI and the extensions/`settings.json`
mechanism rather than a web settings page. Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "qleno": {
      "httpUrl": "https://workspaceapi-server-production-b9d4.up.railway.app/api/mcp",
      "headers": { "Authorization": "Bearer qlno_live_YOUR_KEY_HERE" }
    }
  }
}
```

Then run `/mcp` inside Gemini CLI to confirm the Qleno tools loaded.

> Each assistant's own connector UI changes faster than this document. If the
> steps have drifted, the three facts that matter are unchanged: the URL above,
> streamable HTTP, and the key as a bearer token.

---

## What the assistant can see

Fourteen read tools, grouped by the scopes on the key:

| Scope | Tools |
|---|---|
| `jobs:read` | `get_schedule`, `find_jobs`, `get_job`, `get_client_history`, `get_unassigned_work`, `get_technician_load` |
| `clients:read` | `find_client` |
| `invoices:read` | `get_invoices`, `get_receivables` |
| `reports:read` | `get_revenue`, `get_kpis`, `get_efficiency` |
| `payroll:read` | `get_payroll_summary`, `get_employee_pay` |

A key only sees the tools its scopes allow. Narrowing a key is the practical way
to answer "I want the assistant to help with dispatch but never see payroll":
create it with `jobs:read` and `clients:read` only, and the payroll tools do not
appear at all.

## What it cannot see or do

- **Change anything.** Every tool is read-only.
- **Another company's data.** The key resolves to one company; every query is
  scoped to it, and a job id from another tenant returns "not found".
- **Pay rates on the roster.** `get_technician_load` answers who is free, not
  what anyone earns. Compensation only comes through the payroll tools, and only
  with `payroll:read`.
- **More than the person who made it.** A key can never exceed the role of the
  user it belongs to. It can only be narrower.

## Turning it off

Three switches, all immediate — no waiting for a token to expire:

- **Revoke the key** (Settings → AI & API Access). That key stops working on its
  next request; its activity history is kept.
- **Deactivate the user** the key belongs to. Their keys die with their account.
- **Turn off API access for the company.** Every key stops at once. This is the
  switch to use if a laptop goes missing and you are not sure which key was on it.

## Limits

- **600 requests per minute per company**, shared across every key you hold.
  Minting a second key does not raise it. A refused request says so plainly and
  tells you how long to wait.
- **Up to 200 rows per response.** Longer answers come back paginated, and the
  assistant is told to page through before reporting a total.
- **Usage is counted from day one** and shown in Settings. It is not billed
  today; counting from the start means any future pricing conversation is based
  on what tenants actually did, not a guess.

## When an answer looks wrong

Assistants report what they are given, confidently. Two habits catch most of it:

1. **Ask what it used.** "Which tool did you call, and for what dates?" A wrong
   answer is usually a right answer to a different question.
2. **Spot-check a number you can verify.** Today's job count against the board.
   If the tool and the board disagree, that is a bug worth reporting — the API
   runs the same queries the app does, so they should never differ.

Two distinctions the tools draw deliberately, because they are the ones people
conflate:

- **Booked revenue is not cash collected.** `get_revenue` prices the work;
  `get_receivables` is what is actually owed.
- **Budgeted hours are not worked hours.** The schedule's plan and the clock are
  different numbers, and pay is commission plus mileage — never hours × a rate.
