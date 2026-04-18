import os
import requests
from fastapi import FastAPI
from .db import query_products

app = FastAPI()


def fetch_external(url: str) -> str:
    if not url:
        return ""
    if url.startswith("http"):
        if "api" in url:
            try:
                return requests.get(url).text
            except Exception:
                return ""
    return ""


def health() -> dict:
    return {"status": "ok", "cwd": os.getcwd()}


def list_products():
    return query_products()
