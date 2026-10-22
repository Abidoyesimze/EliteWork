/**
 * verify-pii-encryption.ts
 *
 * Verification query for the PII-at-rest encryption control
 * (see docs/pii-encryption.md). Scans every classified PII column and
 * confirms each stored value matches the app-layer ciphertext envelope
 * format (`<keyVersion>:<salt>:<iv>:<ciphertext>:<tag>`, all hex/version
 * segments) produced by `EncryptionService`. Any row that does NOT match
 * is flagged as a plaintext remnant.
 *
 * Usage:
 *   npx ts-node backend/scripts/verify-pii-encryption.ts
 *
 * Exit codes:
 *   0 — no plaintext remnants found
 *   1 — plaintext remnants found (see printed table) or a query error
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Matches EncryptionService's `keyVersion:salt:iv:ciphertext:tag` envelope.
const CIPHERTEXT_PATTERN = /^v\d+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

interface PiiColumnSpec {
  model: "deliveryManifest" | "tradeNote";
  table: string;
  idColumn: string;
  column: string;
}

// Classified PII inventory — keep in sync with docs/pii-encryption.md §1.
const PII_COLUMNS: PiiColumnSpec[] = [
  { model: "deliveryManifest", table: "DeliveryManifest", idColumn: "tradeId", column: "driverName" },
  { model: "deliveryManifest", table: "DeliveryManifest", idColumn: "tradeId", column: "driverIdNumber" },
  { model: "deliveryManifest", table: "DeliveryManifest", idColumn: "tradeId", column: "vehicleRegistration" },
  { model: "deliveryManifest", table: "DeliveryManifest", idColumn: "tradeId", column: "routeDescription" },
  { model: "tradeNote", table: "TradeNote", idColumn: "id", column: "content" },
];

async function verify(): Promise<number> {
  let plaintextRemnants = 0;

  for (const spec of PII_COLUMNS) {
    const rows: Record<string, string>[] = await (prisma as any)[spec.model].findMany({
      select: { [spec.idColumn]: true, [spec.column]: true },
    });

    for (const row of rows) {
      const value = row[spec.column];
      if (typeof value !== "string" || !CIPHERTEXT_PATTERN.test(value)) {
        plaintextRemnants += 1;
        console.error(
          `[PLAINTEXT REMNANT] ${spec.table}.${spec.column} id=${row[spec.idColumn]} does not match ciphertext envelope`,
        );
      }
    }

    console.log(`Checked ${rows.length} row(s) in ${spec.table}.${spec.column}`);
  }

  return plaintextRemnants;
}

verify()
  .then((remnants) => {
    if (remnants > 0) {
      console.error(`\n✗ Verification FAILED: ${remnants} plaintext remnant(s) found.`);
      process.exitCode = 1;
    } else {
      console.log("\n✓ Verification PASSED: all classified PII columns are ciphertext.");
    }
  })
  .catch((err) => {
    console.error("Verification query errored:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
