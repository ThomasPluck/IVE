from lib import compute, log_event


def main():
    # LLM called `compute` with two args — definition takes three.
    total = compute(1, 2)
    log_event("start")
    return total
