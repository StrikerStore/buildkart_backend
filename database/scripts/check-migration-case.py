import re
from pathlib import Path

root = Path(r"c:\Users\keval\Desktop\App Development\BuildKart\backend\database\prisma\migrations")

# Canonical table names from CREATE TABLE across all migrations
models = set()
for p in root.rglob("migration.sql"):
    models.update(re.findall(r"CREATE TABLE `([^`]+)`", p.read_text(encoding="utf-8")))

# Also pull @@map if any — skip, BuildKart uses model name as table name

# SQL contexts where the identifier is a table (not a column)
TABLE_CONTEXTS = [
    r"ALTER TABLE `([^`]+)`",
    r"DROP TABLE(?: IF EXISTS)? `([^`]+)`",
    r"CREATE TABLE `([^`]+)`",
    r"CREATE INDEX `[^`]+` ON `([^`]+)`",
    r"CREATE UNIQUE INDEX `[^`]+` ON `([^`]+)`",
    r"DROP INDEX `[^`]+` ON `([^`]+)`",
    r"REFERENCES `([^`]+)`",
    r"TRUNCATE TABLE `([^`]+)`",
    r"RENAME TABLE `([^`]+)`",
    r"LOCK TABLES `([^`]+)`",
]

issues = []
for p in sorted(root.rglob("migration.sql")):
    text = p.read_text(encoding="utf-8")
    for pattern in TABLE_CONTEXTS:
        for m in re.finditer(pattern, text, flags=re.IGNORECASE):
            name = m.group(1)
            line = text[: m.start()].count("\n") + 1
            # Wrong if a canonical model exists with different casing
            match = next((model for model in models if model.lower() == name.lower()), None)
            if match and name != match:
                issues.append(
                    {
                        "file": p.parent.name,
                        "line": line,
                        "found": name,
                        "expected": match,
                        "snippet": text.splitlines()[line - 1].strip()[:120],
                    }
                )

# Also flag all-lowercase table refs that look like known models even if CREATE used same case wrongly
print(f"Canonical tables ({len(models)}):")
for m in sorted(models):
    print(f"  {m}")
print()
if not issues:
    print("RESULT: No table-name case mismatches found in any migration.")
else:
    print(f"RESULT: {len(issues)} mismatch(es):\n")
    for i in issues:
        print(f"  {i['file']}:{i['line']}")
        print(f"    found:    `{i['found']}`")
        print(f"    expected: `{i['expected']}`")
        print(f"    line:     {i['snippet']}")
        print()
