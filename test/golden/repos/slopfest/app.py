import os
import requests
import madeup_llm_thing  # hallucinated


def fetch(url):
    if not url:
        return ""
    if url.startswith("http"):
        if "api" in url:
            try:
                return requests.get(url).text
            except Exception:
                return ""
    return ""


def work():
    return madeup_llm_thing.do_it()
