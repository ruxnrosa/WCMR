const fs = require("fs");
const path = require("path");

function updateLangJsonFromEnglish() {
  try {
    const langsDir = `${__dirname}/../languages`;

    // ── 1. Read master (English.json) ──────────────────────────
    const englishPath = path.join(langsDir, "English.json");

    if (!fs.existsSync(englishPath)) {
      console.warn("⚠️  [LangSync] English.json not found — skipping sync");
      return;
    }

    const englishRaw = fs.readFileSync(englishPath, "utf8");
    const englishJson = JSON.parse(englishRaw);
    const englishKeys = Object.keys(englishJson);

    // ── 2. Get all .json files except English.json & default.json ─
    const allFiles = fs
      .readdirSync(langsDir)
      .filter(
        (f) =>
          f.endsWith(".json") && f !== "English.json" && f !== "default.json",
      );

    if (allFiles.length === 0) {
      console.log(
        "ℹ️  [LangSync] No other language files found — nothing to sync",
      );
      return;
    }

    let totalFilesUpdated = 0;
    let totalKeysAdded = 0;

    // ── 3. Loop each target file ───────────────────────────────
    for (const file of allFiles) {
      const filePath = path.join(langsDir, file);

      let targetJson = {};
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        targetJson = JSON.parse(raw);
      } catch (parseErr) {
        console.error(
          `❌ [LangSync] Failed to parse ${file}:`,
          parseErr.message,
        );
        continue;
      }

      // ── 4. Find missing keys ─────────────────────────────────
      const missingKeys = englishKeys.filter((key) => !(key in targetJson));

      if (missingKeys.length === 0) {
        // console.log(`✅ [LangSync] ${file} — already up to date`);
        continue;
      }

      // ── 5. Append missing keys with English value as fallback ─
      for (const key of missingKeys) {
        targetJson[key] = englishJson[key];
      }

      // ── 6. Write back ────────────────────────────────────────
      try {
        fs.writeFileSync(filePath, JSON.stringify(targetJson, null, 2), "utf8");
        totalFilesUpdated++;
        totalKeysAdded += missingKeys.length;
        console.log(
          `🔧 [LangSync] ${file} — added ${missingKeys.length} missing key(s): ${missingKeys.join(", ")}`,
        );
      } catch (writeErr) {
        console.error(
          `❌ [LangSync] Failed to write ${file}:`,
          writeErr.message,
        );
      }
    }

    // ── 7. Summary ───────────────────────────────────────────
    if (totalFilesUpdated > 0) {
      console.log(
        `\n🌐 [LangSync] Done — ${totalFilesUpdated} file(s) updated, ${totalKeysAdded} key(s) added total\n`,
      );
    } else {
      console.log(
        "🌐 [LangSync] All language files are in sync with English.json",
      );
    }
  } catch (err) {
    console.error(
      "❌ [LangSync] Unexpected error during language sync:",
      err.message,
    );
  }
}

module.exports = { updateLangJsonFromEnglish };
