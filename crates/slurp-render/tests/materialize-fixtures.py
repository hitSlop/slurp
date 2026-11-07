#!/usr/bin/python3
"""Write reports whose SQL replays the captured typed rows, for isolated CLI checks/renders."""
import json
import pathlib
import sys

out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
for slug in ["customer-growth", "enterprise-survey", "chart-cases", "page-formats"]:
    fixture = pathlib.Path(__file__).parent / "fixtures" / slug
    definition = json.loads((fixture / "definition.json").read_text())
    run = json.loads((fixture / "run.json").read_text())
    for key in ["id", "revision", "updated_at", "updated_by", "project"]:
        definition.pop(key, None)
    for name, query in definition["queries"].items():
        result = run["queries"][name]
        columns = result["columns"]
        def cell(value, column):
            if value is None:
                literal = "NULL"
            elif isinstance(value, bool):
                literal = "true" if value else "false"
            elif isinstance(value, (int, float)):
                literal = str(value)
            else:
                literal = "'" + str(value).replace("'", "''") + "'"
            return "CAST(" + literal + " AS " + column["type"] + ")"
        aliases = ",".join('"' + c["name"].replace('"', '""') + '"' for c in columns)
        rows = result["rows"]
        if rows:
            values = ",".join("(" + ",".join(cell(v, c) for v, c in zip(row, columns)) + ")" for row in rows)
            query["sql"] = "SELECT * FROM (VALUES " + values + ") AS fixture(" + aliases + ")"
        else:
            query["sql"] = "SELECT " + ",".join(cell(None, c) + ' AS "' + c["name"].replace('"', '""') + '"' for c in columns) + " WHERE false"
    front = {k: definition[k] for k in ["title", "description", "params"] if k in definition}
    text = "---\n" + json.dumps(front) + "\n---\n"
    for name, query in definition["queries"].items():
        text += "\n```sql " + name + "\n" + query["sql"] + "\n```\n"
    for block in definition.get("blocks", []):
        kind = block["kind"]
        body = block["text"] if kind == "markdown" else json.dumps({k: v for k, v in block.items() if k != "kind"})
        text += "\n" + (body if kind == "markdown" else "```" + kind + "\n" + body + "\n```") + "\n"
    (out / (slug + ".md")).write_text(text)
