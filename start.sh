#!/bin/sh
# Запуск на Linux/macOS: ./start.sh   (порт можно сменить: PORT=9000 ./start.sh)
cd "$(dirname "$0")" && exec node server.js
