// analyze.js — collect on-chain signals for a Pharos address.
//
// Design goals (mirrors pharos-contract-inspector):
//   * Pure JSON-RPC for the core signals so the tool works even when the
//     explorer API is rate-limited / behind a checkpoint.
//   * Explorer API is used ONLY for best-effort enrichment (first/last seen,
//     full tx count, protocol naming). If it fails, the report still works.
//   * Zero runtime dependencies beyond Node built-ins.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Rpc } from "./rpc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const networks = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "networks.json"), "utf8")
);
const tokensByNet = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "tokens.json"), "utf8")
);

// Exposed for report.js so per-network thresholds (e.g. whale cutoff) stay
// config-driven rather than hardcoded.
export const networksConfig = networks;

// balanceOf(address) selector + 32-byte left-padded address argument.
const BALANCE_OF_SELECTOR = "0x70a08231";
function encodeBalanceOf(addr) {
  return BALANCE_OF_SELECTOR + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// uint (hex) -> decimal string with `decimals` places, trailing zeros trimmed.
export function formatUnits(hexValue, decimals) {
  const v = typeof hexValue === "bigint" ? hexValue : BigInt(hexValue || "0x0");
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function isValidAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

// Best-effort enrichment from the explorer API. Never throws — returns
// { available:false, ... } on any failure so the caller can degrade.
async function fetchContractInfo(net, address) {
  const api = net.explorerApiUrl;
  if (!api) return { available: false, reason: "no explorer api configured" };
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`${api}/smart-contracts/${address}`, { signal: ctrl.signal });
    if (!res.ok) return { available: false, reason: `explorer http ${res.status}` };
    const json = await res.json();
    return {
      available: true,
      name: json?.name ?? null,
      verified: json?.is_verified ?? null,
    };
  } catch (e) {
    return { available: false, reason: e?.name === "AbortError" ? "explorer timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchActivity(net, address) {
  const api = net.explorerApiUrl;
  if (!api) return { available: false, reason: "no explorer api configured" };
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 9000);
  try {
    const [addrRes, txRes] = await Promise.all([
      fetch(`${api}/addresses/${address}`, { signal: ctrl.signal }),
      fetch(`${api}/addresses/${address}/transactions?limit=100`, {
        signal: ctrl.signal,
      }),
    ]);
    if (!addrRes.ok || !txRes.ok)
      return { available: false, reason: `explorer http ${addrRes.status}/${txRes.status}` };
    const addrJson = await addrRes.json();
    const txJson = await txRes.json();
    const items = Array.isArray(txJson?.items) ? txJson.items : [];

    const timestamps = items
      .map((t) => Date.parse(t.timestamp))
      .filter((n) => !Number.isNaN(n));
    const firstSeen = timestamps.length
      ? new Date(Math.min(...timestamps)).toISOString()
      : null;
    const lastSeen = timestamps.length
      ? new Date(Math.max(...timestamps)).toISOString()
      : null;

    // Distinct destination contracts from recent txs.
    const destSet = new Set();
    for (const t of items) {
      const to = t?.to?.hash || t?.to;
      if (to && /^0x[0-9a-fA-F]{40}$/.test(to) && to.toLowerCase() !== address.toLowerCase())
        destSet.add(to.toLowerCase());
    }

    // Resolve names for up to a handful of destinations (best-effort, fast).
    const protocols = [];
    let resolved = 0;
    for (const dest of destSet) {
      if (resolved >= 8) break;
      try {
        const c = await fetch(`${api}/smart-contracts/${dest}`, { signal: ctrl.signal });
        if (!c.ok) continue;
        const cj = await c.json();
        if (cj?.name) {
          protocols.push({
            address: dest,
            name: cj.name,
            verified: cj.is_verified ?? null,
          });
          resolved++;
        }
      } catch {
        /* ignore individual resolution failures */
      }
    }

    const txCount = Number(addrJson?.transactions_count ?? 0);
    const ageDays =
      firstSeen && lastSeen
        ? Math.max(0, (Date.parse(lastSeen) - Date.parse(firstSeen)) / 86_400_000)
        : null;

    return {
      available: true,
      firstSeen,
      lastSeen,
      txCount,
      uniqueContracts: destSet.size,
      protocols,
      ageDays,
      recentCount: items.length,
    };
  } catch (e) {
    return { available: false, reason: e?.name === "AbortError" ? "explorer timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timeout);
  }
}

// Main entry: gather all signals for an address.
export async function analyzeAddress(address, networkKey = "atlantic_testnet", opts = {}) {
  const offline = opts.offline === true;
  const net = networks.networks[networkKey];
  if (!net) throw new Error(`Unknown network "${networkKey}". Available: ${Object.keys(networks.networks).join(", ")}`);
  if (!isValidAddress(address)) throw new Error(`Invalid address "${address}" — expected 0x + 40 hex chars`);

  const rpc = new Rpc(net.rpcUrl);
  const addrLower = address.toLowerCase(); // normalized for calls/comparisons

  const result = {
    address, // keep original checksum casing in display
    network: net.name,
    chainId: net.chainId,
    analyzedAt: new Date().toISOString(),
  };

  // 1. Address type (EOA vs Contract)
  const code = await rpc.getCode(addrLower);
  const isContract = !!code && code !== "0x" && code.length > 2;
  result.addressType = isContract ? "Contract" : "EOA";
  if (isContract) result.bytecodeSize = (code.length - 2) / 2;

  // 2. Native balance
  const balWei = await rpc.getBalance(addrLower);
  result.nativeBalanceWei = balWei;
  result.nativeBalance = formatUnits(balWei, 18); // PHRS uses 18 decimals

  // 3. ERC20 token holdings (from assets/tokens.json)
  const tokenCfg = tokensByNet[networkKey] || {};
  result.tokenHoldings = [];
  for (const [sym, t] of Object.entries(tokenCfg)) {
    const r = await rpc.ethCallSafe(t.address, encodeBalanceOf(addrLower));
    if (r.ok && r.data && r.data !== "0x" && r.data !== "0x0") {
      const human = formatUnits(r.data, t.decimals);
      if (human !== "0")
        result.tokenHoldings.push({ symbol: sym, address: t.address, balance: human });
    }
  }

  // 4. Nonce / sent-tx count
  const nonceHex = await rpc.call("eth_getTransactionCount", [addrLower, "latest"]);
  result.nonce = parseInt(nonceHex, 16);

  // 5. Activity (best-effort explorer enrichment)
  if (!offline) {
    if (isContract) result.contractInfo = await fetchContractInfo(net, addrLower);
    result.activity = await fetchActivity(net, addrLower);
  } else {
    if (isContract) result.contractInfo = { available: false, reason: "offline mode" };
    result.activity = { available: false, reason: "offline mode" };
  }

  // Confidence: activity drives several classification/risk factors.
  result.confidence = result.activity?.available ? "full" : "partial (explorer unavailable)";
  return result;
}
