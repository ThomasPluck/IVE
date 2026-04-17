def add(x: int, y: int) -> int:
    return x + y


def use_it() -> str:
    # Pyright will flag this: wrong type for `y`, and returning int where str is declared.
    result = add(1, "two")
    return result
