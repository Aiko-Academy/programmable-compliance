# -*- encoding: utf-8 -*-
"""
Off-chain vLEI verifier (KERI, ACDC, CESR, TEL), built on the verification classes of keripy.

Importing this package sets libsodium up for pysodium before any import of keri.
"""
from . import environment  # noqa: F401  (sets DYLD_FALLBACK_LIBRARY_PATH)

__version__ = "0.1.0"
