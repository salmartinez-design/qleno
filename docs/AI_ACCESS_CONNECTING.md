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

## Two ways in, and the difference matters

**Chat apps sign in.** Claude, ChatGPT, Gemini, and Grok never see a key. You
paste one address, the app sends you to a Qleno screen, and you approve it while
signed in as yourself. That is the path for anyone using AI in a chat window —
including on a phone, where there is no config file to edit.

**Developer tools paste a key.** Command-line tools and anything you write
yourself use the same address with an API key as a bearer token.

Earlier versions of this page told chat users to paste a key into their
connector dialog. There is no field to paste it into — that instruction sent
people to a dead end, and it is why the sign-in path was built.

## What you need

1. **A Pro plan.** API and AI access is a Pro feature.
2. **An owner, admin, or office account** to approve a connection. Technicians,
   trainees, and accountants cannot — the approval screen tells them so rather
   than failing silently.
3. **Nothing else, for a chat app.** For a developer tool, an API key from
   Settings → AI & API Access — shown once at creation, replaceable but never
   retrievable.

## The connection details

| | |
|---|---|
| **MCP address** | `https://app.qleno.com/api/mcp` |
| **Transport** | Streamable HTTP |
| **Chat apps** | Sign in and approve — no key |
| **Developer tools** | Bearer token — the API key |

---

## Claude — phone, desktop, or claude.ai

1. Open **Settings → Connectors → Add custom connector**.
2. Name it `Qleno` and paste the MCP address.
3. Save, then press **Connect**. Claude sends you to Qleno.
4. Sign in if you are not already, read what the app is asking for, and press
   **Connect**.
5. Enable the connector in a chat.

The same connector appears on the phone app, the desktop app, and claude.ai —
approve it once and it is on all three. Ask it something you already know the
answer to first; today's schedule is a good check.

## ChatGPT

1. Open **Settings → Connectors → Create**.
2. Paste the MCP address, and choose **OAuth** when it asks how the server
   authenticates. ChatGPT does not accept a pasted key for a custom connector.
3. Approve on the Qleno screen, then enable the connector in a conversation.

## Gemini

1. Add the MCP address as a custom connector.
2. Gemini registers itself with Qleno automatically, then sends you to the Qleno
   screen to approve.

Gemini CLI is a developer tool and still uses a key — see below.

## Grok

1. Open **Settings → Connectors → Bring your own**.
2. Paste the MCP address. Grok follows whatever sign-in the server asks for and
   lands on the same Qleno approval screen.

## Developer tools

**Claude Code:**

```bash
claude mcp add --transport http qleno https://app.qleno.com/api/mcp --header "Authorization: Bearer <your key>"
```

**Gemini CLI** — add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "qleno": {
      "httpUrl": "https://app.qleno.com/api/mcp",
      "headers": { "Authorization": "Bearer qlno_live_YOUR_KEY_HERE" }
    }
  }
}
```

Then run `/mcp` inside Gemini CLI to confirm the Qleno tools loaded.

> Each assistant's own connector UI changes faster than this document. If the
> steps have drifted, the facts that matter are unchanged: the address above,
> streamable HTTP, sign-in for chat apps, and a bearer key for developer tools.

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

Four switches, all immediate — no waiting for a token to expire:

- **Disconnect the app** (Settings → AI & API Access → Connected apps). The chat
  app stops working on its very next question. Its history is kept.
- **Revoke the key** (same page). That key stops working on its next request;
  its activity history is kept.
- **Deactivate the user** who owns it. Their keys and their approved connections
  die with their account.
- **Turn off API access for the company.** Everything stops at once — keys and
  connected apps alike. This is the switch to use if a laptop or phone goes
  missing and you are not sure what was on it.

The Connected apps list is also the record of who approved what: the app's name,
the person who approved it, when it was last used, and from what address.

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
