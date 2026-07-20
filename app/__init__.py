"""PriceBeat — WooCommerce competitor price tracker.

The version below is the single source of truth: pyproject reads it as its
dynamic version, build.ps1 names the release zip from it, and app.updates
compares it against the latest published release. Bump it here and nowhere else.
"""

__version__ = "0.1.0"
