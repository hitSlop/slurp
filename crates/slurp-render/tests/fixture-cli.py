#!/usr/bin/python3
"""Read-only replay of captured packaged-CLI responses for Node parity references."""
import pathlib
import sys

args = sys.argv[1:]
if args[:2] == ["get", "report"]:
    name, slug = "definition", args[2]
elif args[:2] == ["report", "run"]:
    name, slug = "run", args[2]
else:
    raise SystemExit("fixture CLI supports only get report and report run")
if slug not in ["customer-growth", "enterprise-survey", "chart-cases", "page-formats"]:
    raise SystemExit("unknown fixture")
print((pathlib.Path(__file__).parent / "fixtures" / slug / (name + ".json")).read_text())
