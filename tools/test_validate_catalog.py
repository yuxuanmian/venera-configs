import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_catalog.py")
SPEC = importlib.util.spec_from_file_location("validate_catalog", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ValidateCatalogTests(unittest.TestCase):
    def write_catalog(self, entries, files=None):
        directory = Path(tempfile.mkdtemp())
        (directory / "index.json").write_text(json.dumps(entries), encoding="utf-8")
        for name, content in (files or {}).items():
            (directory / name).write_text(content, encoding="utf-8")
        return directory

    def test_valid_and_empty_catalog(self):
        entry = {"name": "Example", "key": "example", "fileName": "example.js", "version": "1"}
        root = self.write_catalog([entry], {"example.js": "class Example {}\n"})
        self.assertEqual(MODULE.validate_catalog(root), [])
        empty = self.write_catalog([])
        self.assertEqual(MODULE.validate_catalog(empty), [])

    def test_duplicate_key_case_insensitive_filename_and_missing_file(self):
        entries = [
            {"name": "A", "key": "same", "fileName": "a.js", "version": "1"},
            {"name": "B", "key": "same", "fileName": "A.js", "version": "1"},
            {"name": "C", "key": "third", "fileName": "missing.js", "version": "1"},
        ]
        errors = MODULE.validate_catalog(self.write_catalog(entries, {"a.js": "class A {}"}))
        self.assertTrue(any("duplicate key" in error for error in errors))
        self.assertTrue(any("collides ignoring case" in error for error in errors))
        self.assertTrue(any("does not exist" in error for error in errors))

    def test_unsafe_names_and_syntax_are_reported(self):
        entries = [
            {"name": "A", "key": "1bad", "fileName": "../a.js", "version": "1"},
            {"name": "B", "key": "good", "fileName": "b.js", "version": "1", "description": 1},
        ]
        errors = MODULE.validate_catalog(self.write_catalog(entries, {"b.js": "class =;"}))
        self.assertTrue(any("unsafe key" in error for error in errors))
        self.assertTrue(any("unsafe fileName" in error for error in errors))
        self.assertTrue(any("description" in error for error in errors))
        self.assertTrue(any("node --check failed" in error for error in errors))

    def test_repository_catalog_has_unique_copy_keys_and_no_server_scanner(self):
        root = MODULE_PATH.parents[1]
        errors = MODULE.validate_catalog(root)
        self.assertEqual(errors, [])
        entries = json.loads((root / "index.json").read_text(encoding="utf-8"))
        by_file = {entry["fileName"]: entry["key"] for entry in entries}
        self.assertEqual(by_file["copy_manga.js"], "copy_manga")
        self.assertEqual(by_file["copy_manga_multi_accounts.js"], "copy_manga_multi")
        self.assertNotIn("cloudTracking", (root / "index.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
