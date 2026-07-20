"""API routers, one module per resource. app.main includes them all."""
from app.routes import competitors, mappings, products, settings, tracking, updates

all_routers = (products.router, tracking.router, competitors.router,
               mappings.router, settings.router, updates.router)
