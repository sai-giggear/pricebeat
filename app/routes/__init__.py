"""API routers, one module per resource. app.main includes them all."""
from app.routes import (competitors, discovery, mappings, products, settings,
                        tracking, updates)

all_routers = (products.router, tracking.router, competitors.router,
               mappings.router, discovery.router, settings.router, updates.router)
