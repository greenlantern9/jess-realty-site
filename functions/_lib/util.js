// Shared helpers for Pages Functions.
// Files under _lib/ are not routed by Cloudflare Pages.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'active',
  'under_contract',
  'closed',
  'lost'
];
