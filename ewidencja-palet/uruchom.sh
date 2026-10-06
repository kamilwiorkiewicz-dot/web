#!/bin/sh
# Ewidencja Palet — uruchamia serwer lokalny (Linux, NAS, Raspberry Pi).
#   ./uruchom.sh                    port 8080, dane w ./dane
#   PORT=8090 ./uruchom.sh          inny port
#   EP_HASLO=tajne ./uruchom.sh     dostęp tylko po podaniu hasła
#   EP_HOSTY=palety.example.pl ./uruchom.sh   własna domena (np. za odwrotnym serwerem proxy)
#   EP_ZAUFANE_PROXY=127.0.0.1 ./uruchom.sh  za odwrotnym proxy (jego adres): błędne hasła osobno dla każdego klienta
#   ./uruchom.sh --otworz           dodatkowo otwiera przeglądarkę (komputer z ekranem)
cd "$(dirname "$0")" || exit 1

# skrypt skopiowany albo uruchomiony bez reszty folderu (np. archiwum rozpakowane tylko częściowo)
brak_plikow() {
  echo "Brakuje plików aplikacji obok tego skryptu (nie ma: $1)."
  echo "Rozpakuj CAŁE archiwum z aplikacją (np. unzip ewidencja-palet.zip) i uruchom ./uruchom.sh z rozpakowanego folderu."
  exit 1
}
for plik in server.js runtime-lokalny.js fonts/fonts.css; do
  [ -f "$plik" ] || brak_plikow "$plik"
done
if [ ! -f index.html ] && { [ ! -f narzedzia/zbuduj.js ] || [ ! -f zrodlo/aplikacja.html ]; }; then
  brak_plikow "index.html"
fi

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
