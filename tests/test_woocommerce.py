from decimal import Decimal
import httpx2
from app.woocommerce import WooCommerceConnector

PAGE1 = [{"id": 10, "name": "Widget", "sku": "W1", "price": "19.99"},
         {"id": 11, "name": "NoPrice", "sku": "N1", "price": ""}]


def _client(routes: dict[str, list[httpx2.Response]]) -> httpx2.AsyncClient:
    """Mock client: the longest matching URL prefix wins, and its queued
    responses are served in order (pages, then the empty terminator)."""
    def handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        prefix = max((p for p in routes if url.startswith(p)), key=len)
        return routes[prefix].pop(0)
    return httpx2.AsyncClient(transport=httpx2.MockTransport(handler))


async def test_fetch_products_paginates_and_filters():
    base = "https://shop.example/wp-json/wc/v3/products"
    conn = WooCommerceConnector("https://shop.example", "ck", "cs",
                                client=_client({base: [
                                    httpx2.Response(200, json=PAGE1),
                                    httpx2.Response(200, json=[])]}))
    products = await conn.fetch_products()
    assert len(products) == 1
    assert products[0].woo_id == 10 and products[0].price == Decimal("19.99")


async def test_fetch_products_parses_brand_and_category():
    base = "https://shop.example/wp-json/wc/v3/products"
    page = [{"id": 12, "name": "Boxed", "sku": "B1", "price": "5.00",
             "brands": [{"id": 3, "name": "Acme"}],
             "categories": [{"id": 7, "name": "Cases"}, {"id": 8, "name": "Extra"}]},
            {"id": 13, "name": "Bare", "sku": "B2", "price": "6.00",
             "brands": [], "categories": []}]
    conn = WooCommerceConnector("https://shop.example", "ck", "cs",
                                client=_client({base: [
                                    httpx2.Response(200, json=page),
                                    httpx2.Response(200, json=[])]}))
    products = await conn.fetch_products()
    assert products[0].brand == "Acme" and products[0].category == "Cases"
    assert products[1].brand is None and products[1].category is None


async def test_fetch_products_expands_variations_as_simple_products():
    base = "https://shop.example/wp-json/wc/v3/products"
    parent = [{"id": 20, "name": "Rack Case", "sku": "RC", "type": "variable",
               "variations": [201, 202], "price": "",
               "brands": [{"name": "GigGear"}], "categories": [{"name": "Cases"}]}]
    variations = [
        {"id": 201, "sku": "RC-6U", "price": "199.00", "regular_price": "249.00",
         "attributes": [{"name": "Size", "option": "6U"}]},
        {"id": 202, "sku": "RC-12U", "price": "299.00",
         "attributes": [{"name": "Size", "option": "12U"}]},
    ]
    conn = WooCommerceConnector("https://shop.example", "ck", "cs",
                                client=_client({
                                    base: [httpx2.Response(200, json=parent),
                                           httpx2.Response(200, json=[])],
                                    base + "/20/variations": [
                                        httpx2.Response(200, json=variations),
                                        httpx2.Response(200, json=[])]}))
    products = await conn.fetch_products()
    assert len(products) == 2
    assert products[0].woo_id == 201 and products[0].name == "Rack Case - 6U"
    assert products[0].price == Decimal("199.00") and products[0].regular_price == Decimal("249.00")
    assert products[1].name == "Rack Case - 12U" and products[1].regular_price is None
    assert products[0].brand == "GigGear" and products[0].category == "Cases"
