# Lead board setup

The admin board lives at `https://jessicakortum.com/admin`. It will **not work
until the steps below are done** — the API fails closed on purpose, so an
unconfigured deploy returns "Admin auth is not configured" rather than serving
client data to anyone who guesses the URL.

Everything here is done in the Cloudflare dashboard. No Node.js required.

---

## 1. Create the database

Cloudflare dashboard → **Storage & Databases → D1** → *Create database*.

- Name: `jess-realty-leads`
- Location: **Eastern North America** (`enam`)
- Jurisdiction: **leave unset**

> **Location cannot be changed later** — it is fixed at creation. To move it you
> would have to create a new database and copy the rows across.

Eastern North America puts the database's primary near Tampa, which is where
both ends of the traffic are: visitors submitting the form and Jessica reading
the board. D1 serves writes from a single primary, so that round trip is what
determines how fast the form and board feel.

Leave jurisdiction unset. The `eu` option pins storage to EU data centres for
GDPR residency and **overrides the location hint entirely** — it would put
Tampa leads in Europe for no benefit. `fedramp` is for US government compliance
workloads and does not apply here.

Open the new database → **Console** tab → paste the contents of
[`schema.sql`](schema.sql) → run it. That creates the `leads` table.

Equivalent via CLI, if you ever install Node.js:

```bash
wrangler d1 create jess-realty-leads --location enam
```

## 2. Bind the database to the site

Dashboard → **Workers & Pages** → `jess-realty-site` → **Settings** →
**Bindings** (older UI: *Functions → D1 database bindings*) → *Add binding*:

| Field | Value |
|---|---|
| Variable name | `DB` |
| D1 database | `jess-realty-leads` |

The variable name must be exactly `DB` — that is what the code reads.

Add it for **Production** (and Preview if you use preview deploys).

## 3. Add the email-notification key

Same Settings page → **Environment variables** → add:

| Name | Value |
|---|---|
| `WEB3FORMS_KEY` | your Web3Forms access key (from the Web3Forms dashboard, or the email they sent when you created it) |

This moved out of the page source and onto the server. Setting it is optional:
`functions/api/contact.js` falls back to the existing key so the form keeps
working, and the variable just lets you rotate the key without a code change.

> The key used to be embedded in `index.html`, so it is still visible in this
> repo's git history. Web3Forms access keys are designed to be public, but if
> the form ever starts attracting spam, generate a fresh key and update this
> variable — no code change needed.

## 4. Lock down /admin with Cloudflare Access

Dashboard → **Zero Trust** → **Access controls → Applications** →
*Add an application* → **Self-hosted**.

- Application name: `Jess Realty Admin`
- Session duration: your call (24 hours is reasonable)
- Add **two** public hostnames / paths:
  - `jessicakortum.com` path `admin*`
  - `jessicakortum.com` path `api/leads*`

> Do **not** add `api/contact` — that is the public contact form endpoint.
> Putting it behind Access would stop visitors from submitting.

Then add a policy:

- Policy name: `Jessica only`
- Action: **Allow**
- Include → **Emails** → `jkortumrealtor@gmail.com`

With the default one-time-PIN login method, signing in emails her a code.
There is no password to store, leak, or rotate.

## 5. Wire Access into the API

Two more environment variables, back in the Pages project
(**Workers & Pages → `jess-realty-site` → Settings → Environment variables**):

**`CF_ACCESS_TEAM_DOMAIN`**

> Zero Trust → **Settings** → **Team name and domain**

Looks like `yourteam.cloudflareaccess.com`.
**Hostname only — no `https://`, no trailing slash.** The code builds the
issuer URL itself, so including the scheme makes the issuer check fail.

**`CF_ACCESS_AUD`**

> Zero Trust → **Access controls** → **Applications** → click
> **`Jess Realty Admin`** → **Configure** tab → scroll to
> **Additional settings** → **Application Audience (AUD) Tag**

`Configure` is a tab *inside* the application, so you have to click into the
app from the Applications list first — it is not in the left-hand nav. The
value is a long hex string with a copy button next to it.

These let the API verify Access's signed token itself, so the endpoints stay
protected even if the Access policy is later changed or removed.

## 6. Redeploy and test

Environment variable and binding changes only take effect on a new deploy.
Dashboard → **Deployments** → *Retry deployment* on the latest, or push any
commit.

Then check:

1. Visit `https://jessicakortum.com/admin` in a private window → you should get
   the Cloudflare Access login, **not** the board.
2. Sign in with `jkortumrealtor@gmail.com` → the board loads.
3. Submit the contact form on the live site → the lead appears in **New**
   (hit Refresh) and the email still arrives.
4. Drag a card to another column, reload → it stayed.

---

## The board

Six stages: **New → Contacted → Touring → Under Contract → Closed**, plus
**Lost / Cold**.

- Drag cards between columns on desktop; use the dropdown on each card on a
  phone (dragging is unreliable on touch).
- Click a card for the full message, click-to-call / click-to-email links, and
  a private notes field.
- Notes and stage are saved per lead; deleting is permanent.

## Local development (optional, needs Node.js)

There is deliberately **no `wrangler.toml` in this repo**. Cloudflare Pages
reads that file during Git builds, and a placeholder database id in it can fail
the deploy — so all bindings live in the dashboard instead.

If you install Node.js and want to run the Functions locally, create
`wrangler.toml` yourself (it is gitignored):

```toml
name = "jess-realty-site"
compatibility_date = "2025-01-01"
pages_build_output_dir = "."

[[d1_databases]]
binding = "DB"
database_name = "jess-realty-leads"
database_id = "<your real database id>"
```

```bash
npm install -g wrangler
wrangler d1 execute jess-realty-leads --local --file=./schema.sql
wrangler pages dev .
```

Put `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `WEB3FORMS_KEY` in a
`.dev.vars` file (also gitignored). Access does not run in front of
`wrangler pages dev`, so the admin API returns 401 locally unless you supply a
real token.

## Files

| Path | What it does |
|---|---|
| `functions/api/contact.js` | Public. Contact form posts here; validates, stores, emails. |
| `functions/api/leads/index.js` | Protected. Lists leads for the board. |
| `functions/api/leads/[id].js` | Protected. Updates stage/notes, deletes. |
| `functions/_lib/auth.js` | Verifies the Access JWT. Fails closed. |
| `admin/index.html` | The kanban board. |
| `schema.sql` | Database table definition. |
