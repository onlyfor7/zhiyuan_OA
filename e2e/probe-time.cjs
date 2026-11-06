const { chromium } = require("playwright");
const B = "http://localhost:3000";
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${B}/login`);
  await page.getByPlaceholder("name@firm.com").fill("guanchen@lexflow.demo");
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  const r = await page.goto(`${B}/operations/time`);
  await page.waitForTimeout(1800);
  const d = await page.evaluate(() => ({ status: document.title, topnav: !!document.querySelector(".topnav-groups"), bodyLen: document.body.innerText.length, bodyStart: document.body.innerText.slice(0, 150) }));
  console.log("http", r?.status(), JSON.stringify(d));
  await browser.close();
})();
