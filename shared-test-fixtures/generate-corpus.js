#!/usr/bin/env node
/**
 * Money-Math Fixture Corpus Generator
 * ───────────────────────────────────
 * Generates a deterministic JSON corpus of money-math test cases consumable
 * by both Rust and TypeScript test suites.
 *
 * Usage:
 *   node shared-test-fixtures/generate-corpus.js [--seed <number>] [--cases <number>]
 *
 * The generator uses a seeded PRNG (mulberry32) for reproducibility.
 * The seed is recorded in the output JSON so both stacks can verify parity.
 */
"use strict";

var fs = require("fs");
var path = require("path");

// ── Mulberry32 PRNG ──────────────────────────────────────────────────────────
function mulberry32(seed) {
  var s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Parameters ───────────────────────────────────────────────────────────────
var BPS_DIVISOR = 10000;
var DEFAULT_SEED = 42;
var DEFAULT_GENERATED_CASES = 1000;

var args = process.argv.slice(2);
var seed = DEFAULT_SEED;
var generatedCases = DEFAULT_GENERATED_CASES;
for (var i = 0; i < args.length; i++) {
  if (args[i] === "--seed") seed = Number(args[++i]);
  if (args[i] === "--cases") generatedCases = Number(args[++i]);
}

var rng = mulberry32(seed);

// ── Helpers ──────────────────────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function validAmount() {
  return Math.max(1, Math.min(randInt(1, 1e15), Number.MAX_SAFE_INTEGER));
}

function validBps() {
  return randInt(0, BPS_DIVISOR);
}

// ── Money Math Functions (mirrors Rust lib.rs) ───────────────────────────────
//
// The Rust contract does this arithmetic in exact 128-bit integers. JavaScript
// numbers are IEEE-754 doubles, so `amount * feeBps` silently loses precision
// once the product exceeds 2^53 (amounts are generated up to 1e15, i.e. a
// product up to 1e19). A corpus built from doubles therefore disagrees with
// the contract on the very cases it is supposed to pin down, so every money
// value is computed with BigInt here and converted back to a Number only when
// it is serialised (all results are <= 1e15, which a double represents
// exactly).
var BPS_DIVISOR_BIG = BigInt(BPS_DIVISOR);

function feeAmount(amount, feeBps) {
  return (BigInt(amount) * BigInt(feeBps)) / BPS_DIVISOR_BIG;
}

function lossAmount(total, lossBps, sellerLossBps) {
  return (
    (BigInt(total) * BigInt(lossBps) * BigInt(sellerLossBps)) /
    (BPS_DIVISOR_BIG * BPS_DIVISOR_BIG)
  );
}

// ── Boundary Cases ───────────────────────────────────────────────────────────
var amounts = [1, 100, 10000, 1000000, 1000000000, 1000000000000];
var bpsValues = [0, 1, 100, 1000, 5000, 9999, 10000];

var boundaryFeeCases = [];
var id = 0;
amounts.forEach(function (amount) {
  bpsValues.forEach(function (bps) {
    var fee = feeAmount(amount, bps);
    boundaryFeeCases.push({
      id: id++,
      amount: amount,
      fee_bps: bps,
      expected_fee: Number(fee),
      expected_seller_amount: Number(BigInt(amount) - fee),
    });
  });
});

var boundaryLossCases = [];
id = 0;
amounts.forEach(function (total) {
  [0, 1000, 5000, 10000].forEach(function (lossBps) {
    [0, 2500, 5000, 10000].forEach(function (slBps) {
      boundaryLossCases.push({
        id: id++,
        total: total,
        loss_bps: lossBps,
        seller_loss_bps: slBps,
        expected_loss: Number(lossAmount(total, lossBps, slBps)),
      });
    });
  });
});

// ── Generated (fuzzed) Cases ─────────────────────────────────────────────────
var generatedFeeCases = [];
id = 0;
for (var i = 0; i < generatedCases; i++) {
  var amount = validAmount();
  var bps = validBps();
  var fee = feeAmount(amount, bps);
  generatedFeeCases.push({
    id: id++,
    amount: amount,
    fee_bps: bps,
    expected_fee: Number(fee),
    expected_seller_amount: Number(BigInt(amount) - fee),
  });
}

var generatedReleaseCases = [];
id = 0;
for (var i = 0; i < generatedCases; i++) {
  var amount = validAmount();
  var bps = validBps();
  var fee = feeAmount(amount, bps);
  var seller = BigInt(amount) - fee;
  generatedReleaseCases.push({
    id: id++,
    amount: amount,
    fee_bps: bps,
    seller_amount: Number(seller),
    fee_amount: Number(fee),
    sum_equals_amount: seller + fee === BigInt(amount),
  });
}

var generatedResolveCases = [];
id = 0;
for (var i = 0; i < generatedCases; i++) {
  var total = validAmount();
  var sellerGetsBps = validBps();
  var buyerLossBps = validBps();
  var sellerLossBps = BPS_DIVISOR - buyerLossBps;
  var feeBps = validBps();

  var lossBps = BPS_DIVISOR - sellerGetsBps;
  var sellerLoss = lossAmount(total, lossBps, sellerLossBps);
  var sellerRaw = BigInt(total) - sellerLoss;
  var buyerRefund = BigInt(total) - sellerRaw;
  var fee = feeAmount(sellerRaw, feeBps);
  var sellerNet = sellerRaw - fee;

  generatedResolveCases.push({
    id: id++,
    total: total,
    seller_gets_bps: sellerGetsBps,
    buyer_loss_bps: buyerLossBps,
    seller_loss_bps: sellerLossBps,
    fee_bps: feeBps,
    seller_loss: Number(sellerLoss),
    seller_raw: Number(sellerRaw),
    buyer_refund: Number(buyerRefund),
    fee: Number(fee),
    seller_net: Number(sellerNet),
    sum_equals_total: sellerNet + buyerRefund + fee === BigInt(total),
    all_non_negative:
      sellerNet >= 0n && buyerRefund >= 0n && fee >= 0n && sellerLoss >= 0n,
  });
}

// ── Clawback Cases ───────────────────────────────────────────────────────────
var generatedClawbackCases = [];
id = 0;
for (var i = 0; i < Math.min(generatedCases, 500); i++) {
  var tradeAmount = validAmount();
  var clawbackAmount = randInt(1, tradeAmount);
  generatedClawbackCases.push({
    id: id++,
    trade_amount: tradeAmount,
    clawback_amount: clawbackAmount,
    expected_remaining: tradeAmount - clawbackAmount,
    expected_clawback_total: clawbackAmount,
    full_clawback: clawbackAmount === tradeAmount,
  });
}

// ── Build Corpus ─────────────────────────────────────────────────────────────
var corpus = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  description:
    "Shared money-math test fixture corpus for Rust and TypeScript parity testing",
  version: "1.0.0",
  generator: {
    name: "shared-test-fixtures/generate-corpus.js",
    seed: seed,
    generated_cases: generatedCases,
    bps_divisor: BPS_DIVISOR,
    timestamp: new Date().toISOString(),
  },
  invariants: [
    "release_funds_conservation: seller_amount + fee_amount == amount",
    "resolve_dispute_conservation: seller_net + buyer_refund + fee == total",
    "clawback_conservation: remaining + clawback_amount == trade_amount",
    "fee_amount_non_negative: fee >= 0 for all valid inputs",
    "fee_amount_le_amount: fee <= amount for all valid inputs",
    "seller_amount_non_negative: (amount - fee) >= 0 for all valid inputs",
    "loss_amount_non_negative: loss >= 0 for all valid inputs",
    "loss_amount_le_total: loss <= total for all valid inputs",
  ],
  fixtures: {
    fee_boundary: boundaryFeeCases,
    fee_generated: generatedFeeCases,
    loss_boundary: boundaryLossCases,
    release_funds_conservation: generatedReleaseCases,
    resolve_dispute_conservation: generatedResolveCases,
    clawback_conservation: generatedClawbackCases,
  },
};

// ── Write Output ─────────────────────────────────────────────────────────────
var outDir = path.dirname(__filename || __dirname);
var outFile = path.join(outDir, "money_math_corpus.json");
fs.writeFileSync(outFile, JSON.stringify(corpus, null, 2));
console.log(
  "✅ Corpus written to " +
    outFile +
    ": " +
    (boundaryFeeCases.length + generatedFeeCases.length) +
    " fee cases, " +
    boundaryLossCases.length +
    " loss cases, " +
    generatedReleaseCases.length +
    " release cases, " +
    generatedResolveCases.length +
    " dispute cases, " +
    generatedClawbackCases.length +
    " clawback cases"
);
