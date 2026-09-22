import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.goto("https://gemini.google.com", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000);
console.log("URL:", page.url());
console.log("TITLE:", await page.title().catch(() => "(no title)"));
await browser.close();
