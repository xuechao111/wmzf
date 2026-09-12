import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("NCT annual-card workflow stays wired end to end", () => {
  const html = read("index.html");
  const bridge = read("bridge.ps1");
  const background = read("chrome-extension/background.js");
  const manifest = JSON.parse(read("chrome-extension/manifest.json"));
  const sync = read("sync-nct-table.mjs");

  for (const id of ["nctBtn", "nctStartDate", "nctEndDate", "nctOrderStatus", "nctProductName", "configNctWorkbook"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /C\+\+AI互动课-NCT年卡/);
  assert.match(html, /fetch-nct/);
  assert.match(html, /\/nct-extension-data/);
  assert.match(bridge, /'\/nct-status'/);
  assert.match(bridge, /'\/nct-extension-data'/);
  assert.match(bridge, /'\/nct-client-status'/);
  assert.match(bridge, /NCT年卡购买更新已配置/);
  assert.match(background, /paidAtFrom/);
  assert.match(background, /paidAtTo/);
  assert.match(background, /orderStatuss/);
  assert.match(background, /spuName/);
  assert.ok(manifest.host_permissions.includes("https://codecamp-marketing.codemao.cn/*"));
  assert.match(sync, /const sheetName="年卡招考数据"/);
  assert.match(sync, /NCT_FILTER_MISMATCH/);
  assert.match(sync, /normalizeDateTime/);
  assert.match(sync, /businessLineStr/);
  assert.match(sync, /NCT_SOURCE_COUNT_MISMATCH/);
  assert.match(sync, /NCT_VERIFY_HEADER_MISMATCH/);
});
