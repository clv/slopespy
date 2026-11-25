const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto('http://localhost:8765/#a=whistler-blackcomb&b=vail');
  const done = () => page.waitForFunction(() => [...document.querySelectorAll('.status')].every(s => !s.textContent), null, { timeout: 120000 });
  await done();
  await page.click('.picker[data-side="1"] input');
  await page.waitForTimeout(500);
  await page.screenshot({ path: out + '-browse.png' });
  await page.selectOption('.picker[data-side="1"] .sort', 'vert');
  await page.waitForTimeout(400);
  await page.screenshot({ path: out + '-sortvert.png' });
  await page.keyboard.type('zermatt');
  await page.keyboard.press('Enter');
  await done();
  // hover the longest lift label on the left
  const lbl = page.locator('.labels[data-side="0"] .lift-label:visible').first();
  await lbl.hover();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out + '-hover.png' });
  await page.click('.panel[data-side="0"] .title');
  await page.waitForTimeout(300);
  await page.screenshot({ path: out + '-collapsed.png' });
  await browser.close();
})();
