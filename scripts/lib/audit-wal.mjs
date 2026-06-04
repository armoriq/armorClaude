/**
 * Audit Write-Ahead Log (WAL) — file-based fallback when daemon is unavailable.
 * Appends audit entries to a JSONL file; a background flush sends them to the backend.
 */

import fs from "node:fs";
import path from "node:path";

export function createAuditWal(walPath) {
  // Ensure parent directory exists
  try {
    fs.mkdirSync(path.dirname(walPath), { recursive: true });
  } catch {
    // already exists
  }

  return {
    /**
     * Append one audit entry to the WAL file.
     */
    append(entry) {
      try {
        fs.appendFileSync(walPath, JSON.stringify(entry) + "\n", "utf-8");
        return true;
      } catch {
        // WAL unavailable — caller falls back to direct HTTP
        return false;
      }
    },

    /**
     * Read all pending entries and delete the WAL file atomically.
     * Returns an empty array if the file doesn't exist or is unreadable.
     */
    drain() {
      try {
        if (!fs.existsSync(walPath)) return [];
        const raw = fs.readFileSync(walPath, "utf-8");
        fs.unlinkSync(walPath);
        return raw
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
