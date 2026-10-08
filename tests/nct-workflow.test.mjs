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
  const runner = read("run-nct-update.ps1");

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
  assert.equal(manifest.version, "1.6.38");
  assert.match(html, /const minimum='1\.6\.38'/);
  assert.match(background, /mapLimit\(liveMatches,6/);
  assert.match(background, /requestedPageSize=100/);
  assert.match(background, /timeout:12000,attempts:3/);
  assert.match(background, /const rosterCache=new Map\(\)/);
  assert.match(background, /httpStatus>=400&&httpStatus<500/);
  assert.match(background, /6路并行/);
  assert.match(sync, /const sheetName="年卡招考数据"/);
  assert.match(sync, /NCT_FILTER_MISMATCH/);
  assert.match(sync, /normalizeDateTime/);
  assert.match(sync, /businessLineStr/);
  assert.match(sync, /NCT_SOURCE_COUNT_MISMATCH/);
  assert.match(sync, /NCT_VERIFY_HEADER_MISMATCH/);
  assert.match(sync, /attempts=4/);
  assert.match(sync, /DINGTALK_NETWORK_FAILED/);
  assert.ok(runner.includes("$completed-and(Test-Path -LiteralPath $InputFile)"));
});

test("teaching-service writer retries transient DingTalk failures and preserves failed input", () => {
  const sync = read("sync-service-data.mjs");
  const runner = read("run-service-update.ps1");
  assert.match(sync, /attempts=4/);
  assert.match(sync, /DINGTALK_NETWORK_FAILED/);
  assert.match(runner, /\$completed=\$false/);
  assert.match(runner, /\$completed=\$true/);
  assert.ok(runner.includes("$completed-and(Test-Path $InputFile)"));
});
