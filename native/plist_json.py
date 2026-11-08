#!/usr/bin/env python3
"""Print a property list as JSON. Data values become {"$data": byte length}; their bytes are not printed."""
import json
import plistlib
import sys


def plain(value):
    if isinstance(value, (bytes, bytearray)):
        return {'$data': len(value)}
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [plain(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


with open(sys.argv[1], 'rb') as source:
    print(json.dumps(plain(plistlib.load(source))))
