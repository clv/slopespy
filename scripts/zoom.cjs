const { chromium } = require('playwright');
(async () => {
  const [url, out, tx, tz, dist, pol] = process.argv.slice(2);
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 850 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => [...document.querySelectorAll('.status')].every(s => !s.textContent), null, { timeout: 120000 });
  await page.evaluate(([tx, tz, d, pol]) => {
    const { camera, controls, sides, settings } = window.skiCompare;
    const S = sides[0]; const y = (680 - S.mid) * settings.exag; tx = S.project.toX(+tx); tz = S.project.toZ(+tz);
    controls.target.set(+tx, y, +tz);
    const phi = pol * Math.PI / 180;
    camera.position.set(+tx, y + d * Math.cos(phi), +tz + d * Math.sin(phi));
    controls.update(); window.skiCompare.requestRender();
  }, [tx, tz, +dist, +pol]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out });
  await browser.close();
})();
