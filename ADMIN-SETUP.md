# Lead pipeline — how it works

The admin board is at `https://jessicakortum.com/admin`, protected by
Cloudflare Access. **Setup is complete** — this document explains the moving
parts and how to change them.

## Architecture

This site deploys as a **Cloudflare Worker with static assets**, not as a Pages
project. CI runs `npx wrangler deploy`, and everything is configured by
[`wrangler.jsonc`](wrangler.jsonc) in this repo.

| Piece | Where |
|---|---|
| Worker code (API + routing) | [`worker.js`](worker.js) |
| Config, bindings, variables | [`wrangler.jsonc`](wrangler.jsonc) |
| Files kept out of the public upload | [`.assetsignore`](.assetsignore) |
| Database table definition | [`schema.sql`](schema.sql) |
| Kanban board | [`admin/index.html`](admin/index.html) |
| Public site | [`index.html`](index.html) |

> **`wrangler deploy` is declarative.** It reconciles the Worker to
> `wrangler.jsonc` on every deploy, so a binding or variable added in the
> **dashboard gets wiped on the next build**. Change them here, not there.

Because the asset directory is the repo root, every committed file would
otherwise be downloadable. `.assetsignore` is what keeps `worker.js`,
`schema.sql`, and this document out of the public upload — **add any new
non-public file to it.**

## Routes

| Route | Access | Purpose |
|---|---|---|
| `POST /api/contact` | public | Contact form: validates, stores, emails |
| `GET /api/leads` | protected | Board data |
| `PATCH /api/leads/:id` | protected | Change stage / edit notes |
| `DELETE /api/leads/:id` | protected | Remove a lead |
| everything else | — | Static files |

`/api/contact` must **never** go behind Access or visitors cannot submit. It is
named `contact`, not `lead`, so an Access rule on `api/leads*` cannot match it
by accident.

## Security model

Two independent layers guard the admin routes:

1. **Cloudflare Access** at the edge redirects anyone not signed in.
2. **`worker.js` verifies the signed Access JWT itself** — signature, expiry,
   issuer, and the audience tag that pins the token to this specific Access
   application.

The second layer matters: if the Access policy is ever deleted or stops
matching the path, the API returns 503/401 instead of serving client contact
details. It fails closed. If you ever see *"Admin auth is not configured"*,
that is this working — `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is missing.

Lead content is attacker-controlled text from an anonymous form, so the board
renders every field with `textContent`, never HTML.

## The database

D1 database `jess-realty-leads`, pinned to **Eastern North America** (near
Tampa, where both the visitors and Jessica are). Location is fixed at creation
and cannot be changed later.

To inspect or fix data by hand: Cloudflare → Storage & Databases → D1 →
`jess-realty-leads` → **Console**.

```sql
SELECT name, email, phone, status, created_at FROM leads ORDER BY created_at DESC;
DELETE FROM leads WHERE name LIKE 'ZZ TEST%';
```

Stages: `new` → `contacted` → `active` → `under_contract` → `closed`, plus
`lost`. These strings are validated server-side; adding a stage means updating
both `LEAD_STATUSES` in `worker.js` and `STAGES` in `admin/index.html`.

## Email notification

Submissions are emailed via Web3Forms in addition to being stored. The key is
inlined in `worker.js` as a fallback and can be overridden with a
`WEB3FORMS_KEY` variable in `wrangler.jsonc`. Web3Forms keys are public by
design; if the form attracts spam, generate a new key and set that variable.

Storing and emailing are independent — one failing does not lose the other.

## Access application

Zero Trust → Access controls → Applications → **Jess Realty Admin**

- Covers `jessicakortum.com/admin*` and `jessicakortum.com/api/leads*`
- Policy: Allow, Emails → `jkortumrealtor@gmail.com`
- Login is a one-time PIN emailed on sign-in — no password stored anywhere

Team domain: `kortumskingdom.cloudflareaccess.com`

## Search indexing

Nothing in the site blocks crawlers: no `noindex`, clean canonical, valid
sitemap, permissive `robots.txt`. Getting found is a discovery problem, not a
technical one.

**IndexNow (done).** `7cb7efe3bc02daac8b0bfcdb16a3b0d7.txt` at the site root
proves ownership to Bing, Yandex, Seznam and DuckDuckGo. Do not delete or
rename it. After adding pages:

```bash
node tools/ping-indexnow.mjs https://jessicakortum.com/new-page
```

**Google Search Console (still needs doing — Google ignores IndexNow).**

1. [search.google.com/search-console](https://search.google.com/search-console) →
   *Add property* → **Domain** → `jessicakortum.com`
2. It gives you a TXT record. Cloudflare → **DNS** → *Add record*:
   type `TXT`, name `@`, content = the `google-site-verification=…` string
3. Back in Search Console, click **Verify**
4. **Sitemaps** → submit `sitemap.xml`
5. **URL Inspection** → paste `https://jessicakortum.com/` → **Request
   Indexing**. This is the step that actually gets Google to come and look.

Use the Domain property rather than the URL-prefix one — it covers every
subdomain and both protocols in a single verification.

After that, Search Console is where you see which queries the site appears
for, which is the only reliable feedback loop for what content to write next.

## Local development

Node.js is installed. From the repo root:

```bash
npx wrangler deploy --dry-run
```

Run this before pushing — it is the exact command CI runs and it catches config
and bundling errors locally. It also prints the resolved bindings, which is the
quickest way to confirm `env.DB` and the Access variables are wired.

```bash
npx wrangler dev
```

Serves the site and Worker locally. Access does not run in front of local dev,
so the admin API returns 401 there.

## Verifying end to end

1. Submit the contact form on the live site.
2. Lead appears in **New** on `/admin` (and in the D1 console).
3. Email arrives at `jkortumrealtor@gmail.com`.
4. Open `/admin` in a private window → Access login, not the board.
