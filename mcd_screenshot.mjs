import puppeteer from "puppeteer-core";
const chromium = puppeteer;
(async () => {
  const browser = await chromium.launch({
    executablePath: "/home/felix/.cache/ms-playwright/chromium_headless_shell-1208/chrome-linux/headless_shell",
    args: ["--no-sandbox", "--disable-dev-shm-usage",
           "--host-resolver-rules=MAP www.xm-apps-static.com 23.62.15.16"],
  });
  const page = await browser.newPage();
  await page.goto("https://feedback.mcdonalds.com/jfe/form/SV_3fv6PsQJMBgs6ea",
                  { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#next-button", { timeout: 25000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: "/tmp/mcd-startseite.png" });
  console.log("SCREENSHOT_OK");
  await browser.close();
})();
