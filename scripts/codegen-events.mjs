#!/usr/bin/env node
/**
 * Event schema codegen — issue #190.
 *
 * Event parsing lived twice: once in the Rust contract that emits, once in the
 * TypeScript that decodes. Nothing tied them together, so a topic rename or a
 * new field broke settlement silently — and it had: the decoder mapped
 * `"TradeCreated"` / `"trade_created"` while the contract emits `"TRDCRT"`.
 *
 * `schemas/events/amana_escrow.events.json` is now the single source of truth.
 * This script generates the Rust topic constants and the TypeScript decoder
 * from it, and verifies the schema still matches the contract source, so drift
 * fails the build instead of production.
 *
 * Usage:
 *   node scripts/codegen-events.mjs            # write generated files
 *   node scripts/codegen-events.mjs --check    # exit 1 on any drift
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = resolve(ROOT, "schemas/events/amana_escrow.events.json");
const CONTRACT_SRC_DIR = resolve(ROOT, "contracts/amana_escrow/src");
const RUST_OUT = resolve(ROOT, "contracts/amana_escrow/src/generated/event_schema.rs");
const TS_OUT = resolve(ROOT, "backend/src/types/generated/events.generated.ts");

const checkOnly = process.argv.includes("--check");

const HEADER_LINES = [
  "GENERATED FILE - DO NOT EDIT.",
  "",
  "Source: schemas/events/amana_escrow.events.json",
  "Regenerate: node scripts/codegen-events.mjs",
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function loadSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const seenTopics = new Map();

  for (const event of schema.events) {
    if (!event.topics?.length) {
      fail(`Event ${event.name} declares no topics`);
    }
    // The first topic is what the decoder dispatches on, so it must be unique.
    const key = event.topics[0];
    if (seenTopics.has(key)) {
      fail(`Topic "${key}" is claimed by both ${seenTopics.get(key)} and ${event.name}`);
    }
    seenTopics.set(key, event.name);
  }

  return schema;
}

function fail(message) {
  console.error(`codegen-events: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Contract source verification
// ---------------------------------------------------------------------------

/**
 * Parses `#[contractevent]` structs out of the contract so the schema can be
 * checked against what is actually emitted. This is the drift guard that would
 * have caught the topic mismatch.
 */
function parseContractEvents(source) {
  const pattern =
    /#\[contractevent\(topics\s*=\s*\[([^\]]*)\]\)\]\s*(?:#\[[^\]]*\]\s*)*pub struct (\w+)\s*\{([^}]*)\}/g;
  const events = [];

  for (const match of source.matchAll(pattern)) {
    const topics = match[1]
      .split(",")
      .map((topic) => topic.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);

    const fields = [];
    for (const line of match[3].split("\n")) {
      const fieldMatch = line.trim().match(/^pub (\w+):\s*([^,]+),?$/);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2].trim() });
      }
    }

    events.push({ rustStruct: match[2], topics, fields });
  }

  return events;
}

/**
 * Reads the whole contract source tree. Events and `EVENT_SCHEMA_VERSION` used
 * to live in `lib.rs`; the contract is now split into modules (for example
 * `events.rs`), so scanning a single file silently reported every event as
 * removed.
 */
function loadContractSource(dir) {
  const sources = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) {
      sources.push(loadContractSource(path));
    } else if (entry.endsWith(".rs")) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
  return sources.join("\n");
}

function verifyAgainstContract(schema, source) {
  const emitted = new Map(parseContractEvents(source).map((e) => [e.rustStruct, e]));
  const declared = new Map(schema.events.map((e) => [e.rustStruct, e]));
  const problems = [];

  for (const [name, event] of emitted) {
    const schemaEvent = declared.get(name);
    if (!schemaEvent) {
      problems.push(`${name} is emitted by the contract but missing from the schema`);
      continue;
    }
    if (schemaEvent.topics.join(",") !== event.topics.join(",")) {
      problems.push(
        `${name} topics differ: schema [${schemaEvent.topics}] vs contract [${event.topics}]`,
      );
    }
    const schemaFields = schemaEvent.fields.map((f) => `${f.name}:${f.type}`).join(",");
    const contractFields = event.fields.map((f) => `${f.name}:${f.type}`).join(",");
    if (schemaFields !== contractFields) {
      problems.push(
        `${name} fields differ:\n    schema:   ${schemaFields}\n    contract: ${contractFields}`,
      );
    }
  }

  for (const name of declared.keys()) {
    if (!emitted.has(name)) {
      problems.push(`${name} is in the schema but no longer emitted by the contract`);
    }
  }

  const versionMatch = source.match(/pub const EVENT_SCHEMA_VERSION: u32 = (\d+);/);
  if (!versionMatch) {
    problems.push("EVENT_SCHEMA_VERSION not found in the contract source");
  } else if (Number(versionMatch[1]) !== schema.schemaVersion) {
    problems.push(
      `schemaVersion ${schema.schemaVersion} does not match contract EVENT_SCHEMA_VERSION ${versionMatch[1]}`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Rust generation
// ---------------------------------------------------------------------------

function rustHeader() {
  return HEADER_LINES.map((line) => (line ? `// ${line}` : "//")).join("\n");
}

function generateRust(schema) {
  const lines = [rustHeader(), ""];
  lines.push("/// Event schema version this module was generated from.");
  lines.push(`pub const EVENT_SCHEMA_VERSION: u32 = ${schema.schemaVersion};`);
  lines.push("");
  lines.push("/// Topic tuple for every event the contract emits, in schema order.");
  lines.push("///");
  lines.push("/// Tests assert emitted topics against these constants, so a rename in");
  lines.push("/// the contract that is not reflected in the schema fails the suite.");
  lines.push(`pub const EVENT_TOPICS: [(&str, &[&str]); ${schema.events.length}] = [`);
  for (const event of schema.events) {
    const topics = event.topics.map((t) => `"${t}"`).join(", ");
    lines.push(`    ("${event.rustStruct}", &[${topics}]),`);
  }
  lines.push("];");
  lines.push("");
  lines.push("/// Field names of every event, in declaration order.");
  lines.push(`pub const EVENT_FIELDS: [(&str, &[&str]); ${schema.events.length}] = [`);
  for (const event of schema.events) {
    const fields = event.fields.map((f) => `"${f.name}"`).join(", ");
    lines.push(`    ("${event.rustStruct}", &[${fields}]),`);
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// TypeScript generation
// ---------------------------------------------------------------------------

/** Soroban type -> the TypeScript type `scValToNative` yields for it. */
const TS_TYPES = {
  Address: "string",
  String: "string",
  Symbol: "string",
  Bytes: "string",
  "BytesN<32>": "string",
  bool: "boolean",
  u32: "number",
  u64: "bigint",
  i128: "bigint",
  u128: "bigint",
  i64: "bigint",
  "soroban_sdk::String": "string",
  // Unit-variant `#[contracttype]` enums encode as a one-symbol vec.
  QuorumOutcome: '["Quorum"] | ["Fallback"]',
};

/**
 * Maps a Soroban field type to what `scValToNative` yields for it.
 *
 * `Vec<T>` is handled structurally so a new collection field does not need a
 * codegen change; anything else unknown is a hard failure rather than a silent
 * `any`, since an unmapped type is exactly the drift this file exists to catch.
 */
function tsType(sorobanType) {
  const vecMatch = sorobanType.match(/^Vec<(.+)>$/);
  if (vecMatch) {
    return `${tsType(vecMatch[1].trim())}[]`;
  }

  const mapped = TS_TYPES[sorobanType];
  if (!mapped) {
    fail(`No TypeScript mapping for Soroban type "${sorobanType}"`);
  }
  return mapped;
}

function generateTypeScript(schema) {
  const lines = [];
  lines.push("/**");
  for (const line of HEADER_LINES) {
    lines.push(line ? ` * ${line}` : " *");
  }
  lines.push(" */");
  lines.push("");
  lines.push("/** Event schema version this file was generated from. */");
  lines.push(`export const EVENT_SCHEMA_VERSION = ${schema.schemaVersion};`);
  lines.push("");

  lines.push("/** Every event the contract emits. */");
  lines.push("export enum GeneratedEventType {");
  for (const event of schema.events) {
    lines.push(`  ${event.name} = "${event.name}",`);
  }
  lines.push("}");
  lines.push("");

  lines.push("/**");
  lines.push(" * First topic symbol -> event type.");
  lines.push(" *");
  lines.push(" * The decoder dispatches on this. Hand-written before, it drifted from");
  lines.push(" * the contract's actual topics; it is now generated from the schema.");
  lines.push(" */");
  lines.push("export const TOPIC_TO_EVENT_TYPE: Readonly<Record<string, GeneratedEventType>> = {");
  for (const event of schema.events) {
    lines.push(`  "${event.topics[0]}": GeneratedEventType.${event.name},`);
  }
  lines.push("};");
  lines.push("");

  lines.push("/** Full topic tuple each event is published under. */");
  lines.push("export const EVENT_TOPICS: Readonly<Record<GeneratedEventType, readonly string[]>> = {");
  for (const event of schema.events) {
    const topics = event.topics.map((t) => `"${t}"`).join(", ");
    lines.push(`  [GeneratedEventType.${event.name}]: [${topics}],`);
  }
  lines.push("};");
  lines.push("");

  lines.push("/** Field names of each event, in declaration order. */");
  lines.push("export const EVENT_FIELDS: Readonly<Record<GeneratedEventType, readonly string[]>> = {");
  for (const event of schema.events) {
    const fields = event.fields.map((f) => `"${f.name}"`).join(", ");
    lines.push(`  [GeneratedEventType.${event.name}]: [${fields}],`);
  }
  lines.push("};");
  lines.push("");

  for (const event of schema.events) {
    lines.push(`/** Payload of the \`${event.topics.join("/")}\` event. */`);
    lines.push(`export interface ${event.name}Payload {`);
    for (const field of event.fields) {
      lines.push(`  ${field.name}: ${tsType(field.type)};`);
    }
    lines.push("}");
    lines.push("");
  }

  lines.push("/** Payload type for a given event type. */");
  lines.push("export interface EventPayloadMap {");
  for (const event of schema.events) {
    lines.push(`  [GeneratedEventType.${event.name}]: ${event.name}Payload;`);
  }
  lines.push("}");
  lines.push("");

  const withStatus = schema.events.filter((e) => e.tradeStatus);
  lines.push("/** Events that move a trade's status, and where they move it to. */");
  lines.push(
    "export const EVENT_TO_TRADE_STATUS: Readonly<Partial<Record<GeneratedEventType, string>>> = {",
  );
  for (const event of withStatus) {
    lines.push(`  [GeneratedEventType.${event.name}]: "${event.tradeStatus}",`);
  }
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeOrCheck(path, contents) {
  if (!checkOnly) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    console.log(`codegen-events: wrote ${path.replace(`${ROOT}/`, "")}`);
    return true;
  }

  let existing;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    console.error(
      `codegen-events: ${path.replace(`${ROOT}/`, "")} is missing — run: node scripts/codegen-events.mjs`,
    );
    return false;
  }

  if (existing !== contents) {
    console.error(
      `codegen-events: ${path.replace(`${ROOT}/`, "")} is out of date — run: node scripts/codegen-events.mjs`,
    );
    return false;
  }

  return true;
}

const schema = loadSchema();
const contractSource = loadContractSource(CONTRACT_SRC_DIR);

const problems = verifyAgainstContract(schema, contractSource);
if (problems.length > 0) {
  console.error("codegen-events: the schema no longer matches the contract source:\n");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    "\nUpdate schemas/events/amana_escrow.events.json to match, then regenerate.",
  );
  process.exit(1);
}

const ok = [
  writeOrCheck(RUST_OUT, generateRust(schema)),
  writeOrCheck(TS_OUT, generateTypeScript(schema)),
].every(Boolean);

if (!ok) {
  process.exit(1);
}

console.log(
  `codegen-events: ${schema.events.length} events, schema version ${schema.schemaVersion} — OK`,
);
