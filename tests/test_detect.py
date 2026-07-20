import json
from datetime import datetime, timezone
from decimal import Decimal
import httpx2
from app.sources.detect import clean_url, detect_source
from app.sources.scraper import jsonld_price, ShopifySource, AutoSource

SHOPIFY_HOME = ('<html><head><link rel="icon" href="/f.png">'
                '<script src="https://cdn.shopify.com/x.js"></script></head>'
                '<body>shopify</body></html>')
WOO_PROD = ('<html><head><script type="application/ld+json">'
            '{"@type":"Product","offers":{"price":"18.00"}}</script></head>'
            '<body class="woocommerce"></body></html>')


async def test_detect_shopify_confirms_via_products_json():
    async def fetch(url):
        return json.dumps({"products": [{}]}) if url.endswith("/products.json?limit=1") else SHOPIFY_HOME
    cfg = await detect_source("https://s.example/collections/x", fetch)
    assert cfg["source"] == "shopify"
    assert cfg["favicon_url"] == "https://s.example/f.png"
    assert cfg["site_url"] == "https://s.example"


async def test_detect_woocommerce_is_auto():
    async def fetch(url):
        return WOO_PROD
    cfg = await detect_source("https://w.example/product/x", fetch)
    assert cfg["source"] == "auto" and "WooCommerce" in cfg["method"]


async def test_detect_shopify_mention_without_json_falls_through():
    # A stray "shopify" string but no products.json must not classify as Shopify.
    async def fetch(url):
        if url.endswith("/products.json?limit=1"):
            raise httpx2.HTTPError("404")
        return '<html><body>powered by shopify buy button</body></html>'
    cfg = await detect_source("https://not-shopify.example/", fetch)
    assert cfg["source"] == "auto"


def test_clean_url_strips_tracking_params_and_fragment():
    assert clean_url("https://example.com/p/1?utm_source=fb&ref=abc#reviews") == \
        "https://example.com/p/1"


def test_clean_url_keeps_shopify_variant_param():
    assert clean_url("https://s.example/products/x?variant=99&utm_campaign=y") == \
        "https://s.example/products/x?variant=99"


def test_clean_url_leaves_clean_url_untouched():
    assert clean_url("https://r.example/w") == "https://r.example/w"


def test_jsonld_price_extraction():
    assert jsonld_price(WOO_PROD) == Decimal("18.00")
    assert jsonld_price("<html></html>") is None


def test_shopify_js_url_normalisation():
    assert ShopifySource._js_url("https://s.example/products/abc?variant=9") == \
        "https://s.example/products/abc.js"
    assert ShopifySource._js_url("https://s.example/collections/c/products/abc") == \
        "https://s.example/products/abc.js"
    assert ShopifySource._js_url("https://s.example/pages/about") is None


def test_shopify_price_from_js_prefers_variant():
    now = datetime.now(timezone.utc)
    data = {"price": 1000, "variants": [{"id": 9, "price": 2500},
                                        {"id": 10, "price": 3000, "sku": "V10",
                                         "available": False}]}
    r = ShopifySource._result_from_js(data, "https://x/products/a?variant=10", now)
    assert r.price == Decimal("30.00")
    # Variant metadata rides along: its SKU and availability.
    assert r.sku == "V10" and r.in_stock is False and r.stock_status == "OutOfStock"
    assert ShopifySource._result_from_js(data, "https://x/products/a", now).price == \
        Decimal("10.00")


def _mock(handler):
    return httpx2.AsyncClient(transport=httpx2.MockTransport(handler))


async def test_autosource_prefers_jsonld():
    src = AutoSource(".price", client=_mock(lambda req: httpx2.Response(200, text=WOO_PROD)))
    res = await src.fetch("https://w.example/product/x")
    assert res.status == "ok" and res.price == Decimal("18.00")


async def test_autosource_sold_out_is_not_in_stock():
    # Any of the schema.org "can't buy it" values must clear in_stock, not
    # just the literal OutOfStock.
    page = ('<html><head><script type="application/ld+json">'
            '{"@type":"Product","offers":{"price":"18.00",'
            '"availability":"https://schema.org/SoldOut"}}</script></head></html>')
    src = AutoSource(client=_mock(lambda req: httpx2.Response(200, text=page)))
    res = await src.fetch("https://w.example/product/x")
    assert res.status == "ok" and res.in_stock is False and res.stock_status == "SoldOut"


async def test_shopifysource_reads_js_endpoint():
    def handler(req):
        if req.url.path.endswith(".js"):
            return httpx2.Response(200, json={"price": 94472, "variants": []})
        return httpx2.Response(200, text="<html></html>")
    src = ShopifySource(client=_mock(handler))
    res = await src.fetch("https://s.example/products/abc")
    assert res.price == Decimal("944.72")
