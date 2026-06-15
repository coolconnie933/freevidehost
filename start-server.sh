#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  python3 app.py
elif command -v python >/dev/null 2>&1; then
  python app.py
else
  echo "Python 3 was not found."
  exit 1
fi
