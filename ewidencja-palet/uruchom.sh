#!/bin/sh
# Ewidencja Palet — uruchamia serwer lokalny (Linux, NAS, Raspberry Pi).
#   ./uruchom.sh                    port 8080, dane w ./dane
#   PORT=8090 ./uruchom.sh          inny port
#   EP_HASLO=tajne ./uruchom.sh     dostęp tylko po podaniu hasła
#   ./uruchom.sh --otworz           dodatkowo otwiera przeglądarkę (komputer z ekranem)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Nie znaleziono programu Node.js — jest potrzebny do uruchomienia serwera."
  echo "Zainstaluj Node.js w wersji 18 lub nowszej (https://nodejs.org albo menedżer pakietów systemu)."
  exit 1
fi
if ! node -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)'; then
  echo "Zainstalowany Node.js ($(node -v)) jest za stary — potrzebna jest wersja 18 lub nowsza."
  exit 1
fi
if [ ! -f index.html ]; then
  node narzedzia/zbuduj.js || exit 1
fi

exec node server.js "$@"
