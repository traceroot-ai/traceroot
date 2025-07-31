import importlib
from typing import TypeVar

T = TypeVar("T")


def import_with_ee_fallback(ee_path: str, standard_path: str) -> T:
    """
    Attempt to import from an enterprise (`ee`) module path, with a fallback
    to a standard path.

    Args:
        ee_path (str): The full import path for the enterprise version of the
                       module/class.
        standard_path (str): The full import path for the standard version of
                             the module/class.

    Returns:
        The imported class or module.
    """
    try:
        ee_module, ee_class = ee_path.rsplit(".", 1)
        return getattr(importlib.import_module(ee_module), ee_class)
    except ImportError:
        standard_module, standard_class = standard_path.rsplit(".", 1)
        return getattr(importlib.import_module(standard_module), standard_class) 