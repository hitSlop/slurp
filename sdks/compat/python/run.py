"""Drive the real Segment and Sentry Python SDKs against a Slurp Worker, the way docs/sdks.md tells people to.

    BASE=http://127.0.0.1:8787 KEY=slurp_pk_... python run.py segment|segment-gzip|segment-wrong-key|sentry

Prints one JSON line describing what the SDK itself saw (errors it reported); what the Worker stored is checked by the test.
"""
import json
import os
import sys

BASE = os.environ["BASE"].rstrip("/")
KEY = os.environ["KEY"]
scenario = sys.argv[1]


def segment(gzip: bool, key: str) -> dict:
    import segment.analytics as analytics

    errors = []
    analytics.write_key = key
    analytics.host = BASE  # the SDK adds /v1/batch
    analytics.gzip = gzip
    analytics.on_error = lambda error, items: errors.append({"error": str(error), "items": len(items)})
    analytics.identify("user_42", {"plan": "pro", "email": "ada@example.com"})
    analytics.track("user_42", "signed_up", {"plan": "pro", "total": 49, "wide": 12345678901234567890})
    analytics.track("user_42", "exported", {"format": "csv"}, anonymous_id="anon-1")
    analytics.page("user_42", "Docs", "Getting started", {"path": "/docs/start"})
    analytics.flush()
    analytics.shutdown()
    return {"errors": errors}


def sentry() -> dict:
    import sentry_sdk

    host = BASE.split("://", 1)[1]
    scheme = BASE.split("://", 1)[0]
    # The DSN is the Worker's address with the publishable key as its public key.
    sentry_sdk.init(dsn=f"{scheme}://{KEY}@{host}/1", release="shop@1.4.0", environment="test", traces_sample_rate=0.0)
    sentry_sdk.set_user({"id": "user_42"})
    sentry_sdk.set_tag("feature", "checkout")

    def charge(amount: int) -> float:
        return 100 / amount

    try:
        charge(0)
    except ZeroDivisionError:
        sentry_sdk.capture_exception()  # a real exception with a real traceback
    sentry_sdk.capture_message("checkout is slow", level="warning")
    sentry_sdk.flush(timeout=10)
    return {"ok": True}


if scenario == "segment":
    result = segment(False, KEY)
elif scenario == "segment-gzip":
    result = segment(True, KEY)
elif scenario == "segment-wrong-key":
    result = segment(False, "slurp_pk_" + "0" * 16 + "_" + "0" * 48)
elif scenario == "sentry":
    result = sentry()
else:
    sys.exit(f"unknown scenario {scenario}")
print(json.dumps(result))
