"""Skill pack registry — install, list, search packs."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore


@dataclass
class SkillPackManifest:
    name: str
    version: str
    description: str
    author: str
    license: str = "MIT"
    runtime_type: str = "local"
    instructions: str | None = None


@dataclass
class SkillPack:
    manifest: SkillPackManifest
    instructions: str | None = None
    installed_at: str | None = None
    source: str | None = None


def load_pack_from_dir(path: str | Path) -> SkillPack:
    """Load a skill pack from a directory containing pack.yaml."""
    p = Path(path)
    yaml_path = p / "pack.yaml"
    if not yaml_path.exists():
        raise FileNotFoundError(f"pack.yaml not found in {p}")

    if yaml is None:
        raise ImportError("PyYAML is required to load pack.yaml. Install: pip install pyyaml")

    with open(yaml_path) as f:
        data = yaml.safe_load(f)

    manifest = SkillPackManifest(
        name=data["name"],
        version=data["version"],
        description=data["description"],
        author=data.get("author", "unknown"),
        license=data.get("license", "MIT"),
        runtime_type=data.get("runtime", {}).get("type", "local") if isinstance(data.get("runtime"), dict) else "local",
    )

    instructions = None
    instr_ref = data.get("instructions")
    if instr_ref and instr_ref.endswith(".md"):
        instr_path = p / instr_ref
        if instr_path.exists():
            instructions = instr_path.read_text()

    return SkillPack(manifest=manifest, instructions=instructions)


class SkillPackRegistry:
    """SQLite-backed local registry for installed skill packs."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db
        self._init_schema()

    def _init_schema(self) -> None:
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS packs (
                name TEXT PRIMARY KEY,
                version TEXT NOT NULL,
                manifest TEXT NOT NULL,
                instructions TEXT,
                installed_at TEXT NOT NULL,
                source TEXT
            );
        """)

    def install(self, pack: SkillPack) -> None:
        """Install or update a skill pack."""
        now = datetime.now(tz=__import__('datetime').timezone.utc).isoformat()
        manifest_json = json.dumps({
            "name": pack.manifest.name,
            "version": pack.manifest.version,
            "description": pack.manifest.description,
            "author": pack.manifest.author,
            "license": pack.manifest.license,
            "runtime": {"type": pack.manifest.runtime_type},
        })
        self._db.execute(
            """INSERT INTO packs (name, version, manifest, instructions, installed_at, source)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
                 version = excluded.version,
                 manifest = excluded.manifest,
                 instructions = excluded.instructions,
                 installed_at = excluded.installed_at,
                 source = excluded.source""",
            (pack.manifest.name, pack.manifest.version, manifest_json,
             pack.instructions, pack.installed_at or now, pack.source),
        )
        self._db.commit()

    def uninstall(self, name: str) -> bool:
        """Remove a pack by name."""
        cur = self._db.execute("DELETE FROM packs WHERE name = ?", (name,))
        self._db.commit()
        return cur.rowcount > 0

    def get(self, name: str) -> SkillPack | None:
        """Get a single pack by name."""
        row = self._db.execute("SELECT * FROM packs WHERE name = ?", (name,)).fetchone()
        if not row:
            return None
        return self._row_to_pack(row)

    def list(self, namespace: str | None = None) -> list[SkillPack]:
        """List installed packs."""
        if namespace:
            rows = self._db.execute(
                "SELECT * FROM packs WHERE name LIKE ? ORDER BY name",
                (f"{namespace}/%",),
            ).fetchall()
        else:
            rows = self._db.execute("SELECT * FROM packs ORDER BY name").fetchall()
        return [self._row_to_pack(r) for r in rows]

    def _row_to_pack(self, row: tuple) -> SkillPack:
        manifest_data = json.loads(row[2])
        runtime = manifest_data.get("runtime", {})
        manifest = SkillPackManifest(
            name=manifest_data["name"],
            version=manifest_data["version"],
            description=manifest_data["description"],
            author=manifest_data.get("author", "unknown"),
            license=manifest_data.get("license", "MIT"),
            runtime_type=runtime.get("type", "local") if isinstance(runtime, dict) else "local",
        )
        return SkillPack(
            manifest=manifest,
            instructions=row[3],
            installed_at=row[4],
            source=row[5],
        )
