const { chromium } = require("playwright");
const B = "http://localhost:3000";
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  async function login(email) {
    await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
    await page.goto(`${B}/login`);
    await page.getByPlaceholder("name@firm.com").fill(email);
    await page.locator('input[type="password"]').fill("Demo@2026");
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
    await page.waitForTimeout(600);
  }
  const dump = async (route, tag) => {
    await page.goto(`${B}${route}`);
    await page.waitForSelector(".topnav-groups", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(900);
    const d = await page.evaluate(() => {
      const vis = (el) => el.getBoundingClientRect().width > 0;
      return {
        heads: [...document.querySelectorAll("h1,h2,h3")].filter(vis).map((e) => e.textContent.trim()).slice(0, 8),
        btns: [...document.querySelectorAll("button")].filter(vis).map((e) => e.textContent.trim()).filter((t) => t && t.length <= 16).slice(0, 14),
        tabs: [...document.querySelectorAll("[role='tab'],[class*='tab']")].filter(vis).map((e) => e.textContent.trim()).filter((t) => t && t.length <= 8).slice(0, 8),
      };
    });
    console.log(tag, JSON.stringify(d));
  };
  await login("zhaokai@lexflow.demo");
  await dump("/admin/org/company", "公司信息(sysadmin)");
  await dump("/admin/org/units", "部门维护(sysadmin)");
  await dump("/admin/org/members", "员工信息(sysadmin)");
  await login("liangqifeng@lexflow.demo");
  await dump("/admin/org/company", "公司信息(partner)");
  await browser.close();
})();
