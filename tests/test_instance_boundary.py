import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("isolated_runtime", SOURCE / "runtime_paths.py")
paths = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paths)

class InstanceBoundaryTests(unittest.TestCase):
    def test_own_root_and_child_are_allowed(self):
        for root in (SOURCE, SOURCE / "instances" / "fixture"):
            with patch.dict(os.environ, {"HF_DASHBOARD_ROOT": str(root), "HF_DASHBOARD_PORT": str(paths.EXPECTED_PORT)}):
                self.assertEqual(paths.runtime_root(), root.resolve())

    def test_peer_root_is_rejected_without_touching_files(self):
        peer = SOURCE.parent / ("hyperframes-dashboard" if paths.EXPECTED_PORT == 8766 else "hyperframes-dashboard-replica")
        with patch.dict(os.environ, {"HF_DASHBOARD_ROOT": str(peer), "HF_DASHBOARD_PORT": str(paths.EXPECTED_PORT)}):
            with self.assertRaisesRegex(RuntimeError, "INSTANCE_ROOT_MISMATCH"):
                paths.runtime_root()

    def test_wrong_port_is_rejected(self):
        with patch.dict(os.environ, {"HF_DASHBOARD_ROOT": str(SOURCE), "HF_DASHBOARD_PORT": str(8765 if paths.EXPECTED_PORT == 8766 else 8766)}):
            with self.assertRaisesRegex(RuntimeError, "INSTANCE_PORT_MISMATCH"):
                paths.runtime_root()

    def test_parent_and_prefix_collision_cannot_escape(self):
        for root in (SOURCE.parent, SOURCE.parent / (SOURCE.name + "-other")):
            with patch.dict(os.environ, {"HF_DASHBOARD_ROOT": str(root), "HF_DASHBOARD_PORT": str(paths.EXPECTED_PORT)}):
                with self.assertRaisesRegex(RuntimeError, "INSTANCE_ROOT_MISMATCH"):
                    paths.runtime_root()
