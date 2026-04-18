import hashlib
import requests
import subprocess


# ive-ai-slop/eval-on-untyped-input
def do_eval(payload):
    return eval(payload)


# ive-ai-slop/shell-true-from-format
def run_cmd(name):
    return subprocess.run(f"ls /{name}", shell=True)


# ive-ai-slop/requests-no-verify
def fetch(url):
    return requests.get(url, verify=False)


# ive-ai-slop/weak-hash-for-credentials
def legacy_password_hash(pw):
    return hashlib.md5(pw.encode()).hexdigest()


# ive-ai-slop/silent-except
def swallow_errors():
    try:
        risky()
    except:
        pass


def risky():
    raise RuntimeError("boom")


# ive-ai-slop/hardcoded-secret
API_KEY = "sk-1234567890abcdef1234567890abcdef"
