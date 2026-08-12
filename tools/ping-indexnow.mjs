// Tells Bing, Yandex, Seznam and DuckDuckGo that a URL changed, instead of
// waiting for them to crawl it. Google does not participate in IndexNow -
// use Google Search Console for that (see ADMIN-SETUP.md).
//
//   node tools/ping-indexnow.mjs
//   node tools/ping-indexnow.mjs https://jessicakortum.com/some-new-page
//
// The key must stay reachable at https://jessicakortum.com/<KEY>.txt, which is
// what proves to the search engines that we own the host.

const HOST = 'jessicakortum.com';
const KEY = '7cb7efe3bc02daac8b0bfcdb16a3b0d7';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

const urls = process.argv.slice(2);
if (!urls.length) urls.push(`https://${HOST}/`);

// Verify the key file is actually live first - a 404 here makes every
// submission fail silently, which is the usual way this ends up not working.
const keyRes = await fetch(KEY_LOCATION + '?cb=' + Date.now());
const keyBody = (await keyRes.text()).trim();
if (!keyRes.ok || keyBody !== KEY) {
  console.error(`Key file check FAILED: ${KEY_LOCATION} -> ${keyRes.status} "${keyBody.slice(0, 40)}"`);
  console.error('Deploy the key file before submitting.');
  process.exit(1);
}
console.log(`key file OK  ${KEY_LOCATION}`);

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls })
});

// 200 and 202 both mean accepted; 202 means the key is still being validated.
console.log(`submitted ${urls.length} url(s) -> ${res.status} ${res.statusText}`);
for (const u of urls) console.log('   ' + u);
if (![200, 202].includes(res.status)) {
  console.error('body:', (await res.text()).slice(0, 300));
  process.exit(1);
}
