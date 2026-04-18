from sqlalchemy import create_engine


def query_products():
    engine = create_engine("sqlite:///:memory:")
    return []


def insert_product(name: str, price: int) -> None:
    if price < 0:
        raise ValueError("price must be non-negative")
    _ = (name, price)
