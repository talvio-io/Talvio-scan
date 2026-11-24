// refresh-orbs.mjs — regenerate orbs.json for Talvio Scan from the chain.
//
// What it does:
//   1. Reads nextTokenId() from the Scan NFT (0x7De1Ee0E8E2228D2b7826dE5c9A330Bf8107372C).
//   2. For every Orb 1..nextTokenId-1 reads ownerOf() + preview() on the claim
//      contract (0xc64a804CB03019d9e438B4e1B0Dd5d0f3dC13a7a).
//      preview() returns (amount, fee, claimable, opensAt); Orbs whose preview
//      says claimable are double-checked with claimed() so already-claimed
//      Orbs never count as claimable.
//   3. Writes orbs.json in the exact schema agents already read:
//      { generatedAtUtc, contracts, nextTokenId, totalOrbs,
//        claimableNow, claimableScanTotal, owners: { wallet: [orbIds...] } }
//
// No dependencies, no secrets — read-only eth_call through public BSC RPCs,
// same endpoints + selectors the live site (index.html) already uses.
// Usage:
//   node scripts/refresh-orbs.mjs --out orbs.json            # write file
//   node scripts/refresh-orbs.mjs --out /tmp/orbs.json --validate
//     # also fetch the live orbs.json and diff the owners map for the
//     # token range it covers (catches regressions before pushing).
//
// Exit codes: 0 = written (or validated OK), 1 = RPC failure / mismatch.

import { writeFileSync } from "node:fs";

const NFT = "0x7De1Ee0E8E2228D2b7826dE5c9A330Bf8107372C";
const CLAIM = "0xc64a804CB03019d9e438B4e1B0Dd5d0f3dC13a7a";
const SEL = {
  nextTokenId: "0x75794a3c",
  ownerOf: "0x6352211e",
  preview: "0xc317c377", // preview(uint256) -> amount, fee, claimable, opensAt
  claimed: "0xdbe7e3bd", // claimed(uint256)
};
const RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.ninicoin.io",
  "https://rpc.ankr.com/bsc",
];

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "orbs.json";
const VALIDATE = args.includes("--validate");
const CONCURRENCY = 20;

const padUint = (n) => BigInt(n).toString(16).padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ethCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  if (!j.result) throw new Error("empty RPC result");
  return j.result;
}

// Try each RPC in rotation until one answers.
async function call(to, data) {
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const rpc = RPCS[attempt % RPCS.length];
    try {
      return await ethCall(rpc, to, data);
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

const word = (hex, i) => {
  const s = hex.replace(/^0x/, "");
  const chunk = s.slice(i * 64, (i + 1) * 64);
  if (chunk.length < 64) return null;
  return BigInt("0x" + chunk);
};

// Offline self-test: exercises the script's own decode code on canned chain
// responses (no network). Run: node scripts/refresh-orbs.mjs --self-test
if (args.includes("--self-test")) {
  const toWord = (v) => BigInt(v).toString(16).padStart(64, "0");
  const previewHex =
    "0x" + toWord(60000) + toWord(277000000000000n) + toWord(1) + toWord(1794000000);
  const amount = word(previewHex, 0);
  const fee = word(previewHex, 1);
  const claimable = word(previewHex, 2) > 0n;
  const opensAt = word(previewHex, 3);
  const ownerHex =
    "0x0000000000000000000000004d50dd3e57d1f4adade559bd075bca0496aaa29b";
  const owner = "0x" + ownerHex.replace(/^0x/, "").slice(-40).toLowerCase();
  const ok =
    amount === 60000n &&
    fee === 277000000000000n &&
    claimable === true &&
    opensAt === 1794000000n &&
    owner === "0x4d50dd3e57d1f4adade559bd075bca0496aaa29b" &&
    padUint(1) === "0".repeat(63) + "1";
  console.log(ok ? "SELF-TEST OK" : "SELF-TEST FAILED", {
    amount: String(amount),
    fee: String(fee),
    claimable,
    opensAt: String(opensAt),
    owner,
  });
  process.exit(ok ? 0 : 1);
}

async function run() {
  const nextHex = await call(NFT, SEL.nextTokenId);
  const nextId = Number(word(nextHex, 0));
  const total = nextId - 1;
  console.log(`nextTokenId=${nextId} totalOrbs=${total}`);

  const owners = {};
  let claimableNow = 0;
  let claimableScanTotal = 0n;
  const failures = [];
  let done = 0;

  async function oneOrb(id) {
    try {
      const [ownerHex, prevHex] = await Promise.all([
        call(NFT, SEL.ownerOf + padUint(id)),
        call(CLAIM, SEL.preview + padUint(id)),
      ]);
      const owner = "0x" + ownerHex.replace(/^0x/, "").slice(-40).toLowerCase();
      const amount = word(prevHex, 0);
      const claimable = word(prevHex, 2) > 0n;
      if (amount === null) throw new Error("bad preview");
      (owners[owner] ??= []).push(id);
      if (claimable) {
        // preview() can stay true after a claim; confirm with claimed().
        const claimedHex = await call(CLAIM, SEL.claimed + padUint(id));
        if (word(claimedHex, 0) === 0n) {
          claimableNow++;
          claimableScanTotal += amount;
        }
      }
    } catch (e) {
      failures.push(id);
      console.error(`orb ${id} failed: ${e.message}`);
    }
    done++;
    if (done % 100 === 0) console.log(`... ${done}/${total} orbs`);
  }

  // Worker pool over Orb ids, ascending (keeps owners map in Orb order).
  const ids = Array.from({ length: total }, (_, i) => i + 1);
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      await oneOrb(id);
    }
  });
  await Promise.all(workers);

  // One retry pass for anything the RPCs dropped.
  if (failures.length) {
    console.log(`retrying ${failures.length} failed orbs...`);
    const retry = failures.splice(0);
    for (const id of retry) await oneOrb(id);
  }
  if (failures.length) {
    throw new Error(`${failures.length} orbs still unread: ${failures.slice(0, 20).join(",")}`);
  }

  const out = {
    generatedAtUtc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    contracts: { nft: NFT, claim: CLAIM },
    nextTokenId: nextId,
    totalOrbs: total,
    claimableNow,
    claimableScanTotal: Number(claimableScanTotal),
    owners,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `wrote ${OUT}: totalOrbs=${total} claimableNow=${claimableNow} ` +
      `claimableScanTotal=${Number(claimableScanTotal).toLocaleString("en-US")} ` +
      `owners=${Object.keys(owners).length}`
  );

  if (VALIDATE) {
    console.log("validating against live https://talvio.id/orbs.json ...");
    const live = await (await fetch("https://talvio.id/orbs.json")).json();
    let mismatches = 0;
    const maxLive = live.nextTokenId - 1;
    for (const [wallet, liveIds] of Object.entries(live.owners)) {
      const mine = owners[wallet.toLowerCase()] || [];
      const liveSet = new Set(liveIds);
      const mySet = new Set(mine);
      for (const id of liveIds) if (!mySet.has(id) && id <= maxLive) mismatches++;
      for (const id of mine) if (id <= maxLive && !liveSet.has(id)) mismatches++;
    }
    // Orbs the live file never saw (above its nextTokenId) must exist in mine.
    const fresh = Object.values(owners).flat().filter((id) => id > maxLive).length;
    console.log(`live file covers 1..${maxLive}; mismatches=${mismatches}; new orbs above live file=${fresh}`);
    if (mismatches > 0) throw new Error(`validation failed: ${mismatches} owner mismatches`);
    if (total <= maxLive) throw new Error("validation failed: no new orbs found, file may be stale");
    console.log("VALIDATION OK");
  }
}

run().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
