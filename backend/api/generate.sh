#!/bin/sh
# Regenerate the webrpc code for backend/api/slurp.ridl:
#   TypeScript server + client  backend/src/slurp.gen.ts                (target typescript, pinned webrpc-gen)
#   Rust types + client         crates/slurp-client/src/slurp.gen.rs    (local target backend/api/gen-rust, then rustfmt)
#
#   backend/api/generate.sh               # write both
#   backend/api/generate.sh ts            # only some targets
#   backend/api/generate.sh --check       # regenerate into a temp dir; exit 1 if any committed file is stale
#
# Methods are tagged `+ @public` or `+ @internal` in slurp.ridl (exactly one each, checked below); a client for third parties is generated
# with `-match=@public`, the Worker and the CLI from the whole schema. `--check` also generates that public client and fails if it
# exposes anything but the methods listed in PUBLIC_METHODS.
# webrpc-gen is pinned below and run with `go run`, so Go is needed only to run the generator (no go.mod in this repo).
# The typescript template is embedded in webrpc-gen. Output is deterministic: no timestamps.
set -eu
WEBRPC_GEN_VERSION=v0.49.0
WEBRPC_GEN="${WEBRPC_GEN:-go run github.com/webrpc/webrpc/cmd/webrpc-gen@$WEBRPC_GEN_VERSION}"
API=$(cd "$(dirname "$0")" && pwd)
BACKEND=$(dirname "$API")
ROOT=$(dirname "$BACKEND")
check=0
targets=""
for a in "$@"; do
  case "$a" in
    --check) check=1 ;;
    ts|rust) targets="$targets $a" ;;
    *) echo "usage: $0 [--check] [ts] [rust]" >&2; exit 2 ;;
  esac
done
[ -n "$targets" ] || targets="ts rust"

out_ts="$BACKEND/src/slurp.gen.ts"
out_rust="$ROOT/crates/slurp-client/src/slurp.gen.rs"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# shellcheck disable=SC2086
gen() { (cd "$BACKEND" && $WEBRPC_GEN -schema=api/slurp.ridl "$@" >/dev/null); }

# Every method must say who it is for with exactly one tag, `+ @public` or `+ @internal`: webrpc-gen filters on these tags and silently
# treats an untagged method as neither, so a forgotten tag would leak a control-plane method into a published public-only client, and
# a method tagged both ways is ambiguous.
badtags=$(awk '
  function finish() { if (name != "" && pub + internal != 1) print name " (" pub " @public, " internal " @internal)" }
  /^  - [A-Za-z]+\(/ { finish(); name = $2; pub = 0; internal = 0; next }
  /^    \+ @public$/ { pub++ }
  /^    \+ @internal$/ { internal++ }
  END { finish() }' "$API/slurp.ridl")
if [ -n "$badtags" ]; then echo "slurp.ridl: each method needs exactly one of + @public and + @internal: $badtags" >&2; exit 1; fi

# The methods a client for third parties may call. Adding one here is a decision to support it for people outside this repo.
PUBLIC_METHODS="getCoverage listObjects version whoami"

stale=0
for t in $targets; do
  case "$t" in
    ts)   dest=$out_ts;   rel=./src/slurp.gen.ts
          gen -target=typescript -server -client -enumStyle=union -out="$tmp/ts" ;;
    rust) dest=$out_rust; rel=../crates/slurp-client/src/slurp.gen.rs
          gen -target=./api/gen-rust -out="$tmp/rust" ;;
  esac
  # The generated header repeats the command line; record the canonical output path, not the temp one.
  sed "s|-out=$tmp/$t|-out=$rel|" "$tmp/$t" >"$tmp/$t.canon" && mv "$tmp/$t.canon" "$tmp/$t"
  # `go run pkg@version` reports "unknown" for the generator version; stamp the pinned one so output matches a tagged build.
  sed -e "s/ebrpc-gen@unknown/ebrpc-gen@$WEBRPC_GEN_VERSION/" -e "s/webrpc@unknown/webrpc@$WEBRPC_GEN_VERSION/" -e "s/typescript@unknown/typescript@$WEBRPC_GEN_VERSION/" "$tmp/$t" >"$tmp/$t.ver" && mv "$tmp/$t.ver" "$tmp/$t"
  case "$t" in
    # v0.49 changes WebrpcClientAborted's default to 499; preserve Slurp's HTTP 400 contract.
    ts) sed -e '/export class WebrpcClientAbortedError /,/^}/s/: 499$/: 400/' -e 's/[[:blank:]]*$//' "$tmp/$t" >"$tmp/$t.compat" && mv "$tmp/$t.compat" "$tmp/$t" ;;
    rust) rustfmt --edition 2024 "$tmp/rust" ;;
  esac
  if [ "$check" = 1 ]; then
    if ! cmp -s "$tmp/$t" "$dest"; then echo "stale: ${dest#$ROOT/} (run backend/api/generate.sh)" >&2; stale=1; fi
  else
    mkdir -p "$(dirname "$dest")"; cp "$tmp/$t" "$dest"; echo "wrote ${dest#$ROOT/}"
  fi
done
if [ "$check" = 1 ] && [ -d "$API/gen-rust/testdata" ]; then
  for schema in "$API"/gen-rust/testdata/*.ridl; do
    name=$(basename "$schema" .ridl)
    if [ "$name" = keywords ]; then
      # shellcheck disable=SC2086
      (cd "$BACKEND" && $WEBRPC_GEN -schema="$schema" -target=./api/gen-rust -out="$tmp/keywords.rs" >/dev/null)
      rustfmt --edition 2024 "$tmp/keywords.rs"
    else
      # shellcheck disable=SC2086
      if (cd "$BACKEND" && $WEBRPC_GEN -schema="$schema" -target=./api/gen-rust -out="$tmp/rejected.rs" >"$tmp/stdout" 2>"$tmp/stderr"); then
        echo "gen-rust: expected rejection for $name" >&2; stale=1
      elif ! grep -F -f "$API/gen-rust/testdata/$name.stderr" "$tmp/stderr" >/dev/null; then
        echo "gen-rust: wrong rejection for $name" >&2; cat "$tmp/stderr" >&2; stale=1
      fi
    fi
  done
  # shellcheck disable=SC2086
  if (cd "$BACKEND" && $WEBRPC_GEN -schema=api/slurp.ridl -target=./api/gen-rust -unknown-option -out="$tmp/rejected.rs" >"$tmp/stdout" 2>"$tmp/stderr"); then
    echo "gen-rust: unknown option was accepted" >&2; stale=1
  elif ! grep -F -- '-unknown-option="" is not supported target option' "$tmp/stderr" >/dev/null; then
    cat "$tmp/stderr" >&2; stale=1
  fi
fi
if [ "$check" = 1 ]; then
  gen -target=typescript -client -match=@public -out="$tmp/public.ts"
  exposed=$(grep -oE '^  [a-zA-Z]+ = \(req:' "$tmp/public.ts" | sed -E 's/^  ([a-zA-Z]+) = .*/\1/' | sort | tr '\n' ' ' | sed 's/ $//')
  if [ "$exposed" != "$PUBLIC_METHODS" ]; then
    echo "the public client exposes: $exposed (expected: $PUBLIC_METHODS); check the @public and @internal tags in slurp.ridl" >&2; stale=1
  fi
fi
exit $stale
