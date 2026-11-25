const { chromium } = require('playwright');
(async () => {
  const [url, out, waitMs = '25000', w = '1500', h = '850'] = process.argv.slice(2);
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1, reducedMotion: process.env.MOTION ? 'no-preference' : 'reduce' });
  page.on('console', m => console.log('console:', m.type(), m.text()));
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => [...document.querySelectorAll('.status')].every(s => !s.textContent), null, { timeout: +waitMs }).catch(() => console.log('timeout waiting'));
  await page.waitForTimeout(1500);
  console.log(await page.evaluate(() => [...document.querySelectorAll('.panel')].map(p => p.innerText.replace(/\n/g, ' | ')).join('\n')));
  await page.screenshot({ path: out });
  await browser.close();
})();
