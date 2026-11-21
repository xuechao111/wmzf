"""Resolve only this installation's runtime; reject cross-instance environments."""
import os
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parent
EXPECTED_PORT = 8766

def runtime_root():
    port = str(os.environ.get("HF_DASHBOARD_PORT") or EXPECTED_PORT)
    if port != str(EXPECTED_PORT):
        raise RuntimeError("INSTANCE_PORT_MISMATCH")
    source = SOURCE_ROOT.resolve()
    value = Path(os.environ.get("HF_DASHBOARD_ROOT") or (SOURCE_ROOT if (SOURCE_ROOT / "dashboard-config.json").exists() else SOURCE_ROOT / "instances" / "test"))
    root = value.resolve()
    if root != source and source not in root.parents:
        raise RuntimeError("INSTANCE_ROOT_MISMATCH: 运行目录不属于当前工作台")
    for parent in (value.absolute(), *value.absolute().parents):
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise RuntimeError("INSTANCE_ROOT_REPARSE_POINT")
    return root
