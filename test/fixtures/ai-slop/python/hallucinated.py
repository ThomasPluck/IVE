import os
import requests
import huggingface_utils  # not a real package
from fastapi import FastAPI

app = FastAPI()


def fetch(url):
    if not url:
        return None
    if url.startswith("http"):
        if "api" in url:
            try:
                return requests.get(url).text
            except Exception:
                return None
    return None


def save_cwd():
    return os.getcwd()
