#!/usr/bin/python3
"""Fresh-process CLI measurements against temporary typed-row fixture reports."""
import argparse
import json
import os
import pathlib
import statistics
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("before", type=pathlib.Path)
parser.add_argument("after", type=pathlib.Path)
args = parser.parse_args()
before, after = args.before.resolve(), args.after.resolve()
tests = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="slurp-render-bench-", dir="/tmp") as scratch:
    root = pathlib.Path(scratch)
    env = dict(os.environ, SLURP_HOME=str(root / "home"), SLURP_LIBRARY=str(root / "library"), HOME=str(root / "user-home"), SLURP_SERVER="0")
    (root / "user-home").mkdir()
    def run(binary, *command):
        return subprocess.run([str(binary), *map(str, command)], env=env, capture_output=True, check=True)
    run(after, "library", "set", root / "library", "--create")
    subprocess.run(["/usr/bin/python3", str(tests / "materialize-fixtures.py"), str(root / "reports")], check=True)
    for slug in ["customer-growth", "enterprise-survey"]:
        run(after, "apply", "-f", root / "reports" / (slug + ".md"))
    measurements = {name: {"bytes":binary.stat().st_size, "sources_ms":[]} for name, binary in [("before", before), ("after", after)]}
    def elapsed(binary, *command):
        start = time.perf_counter()
        run(binary, *command)
        return (time.perf_counter() - start) * 1000
    for i in range(11):
        binaries = [("before", before), ("after", after)]
        for name, binary in binaries if i % 2 == 0 else reversed(binaries):
            measurements[name]["sources_ms"].append(elapsed(binary, "sources"))
    for data in measurements.values():
        data["sources_p50_ms"] = statistics.median(data["sources_ms"])
    measurements["reports"] = {}
    for slug in ["customer-growth", "enterprise-survey"]:
        checks = [elapsed(after, "check", slug) for _ in range(5)]
        renders = [elapsed(after, "report", "render", slug, "--out", root / "render" / slug) for _ in range(5)]
        pages = [elapsed(after, "report", "render", slug, "--page", "--pdf", "--png", "--out", root / "page" / slug) for _ in range(5)]
        measurements["reports"][slug] = {
            "page_png_pdf_ms":pages, "page_png_pdf_p50_ms":statistics.median(pages),
            "check_ms":checks, "check_p50_ms":statistics.median(checks),
            "render_ms":renders, "render_p50_ms":statistics.median(renders),
        }
    print(json.dumps(measurements, indent=2))
