#!/bin/bash
# Ewidencja Palet — uruchamia serwer lokalny na Macu (dwuklik w Finderze).
# Okno Terminala musi zostać otwarte, dopóki korzystasz z aplikacji. Ctrl+C albo zamknięcie okna zatrzymuje serwer.

cd "$(dirname "$0")" || exit 1

# Node.js zainstalowany przez Homebrew / nvm / Volta bywa poza domyślną ścieżką okna Terminala
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$HOME/.local/bin"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

zakoncz() {
  echo
  read -r -p "Naciśnij Enter, aby zamknąć to okno… " _
  exit "${1:-0}"
}

# Skrypt skopiowany albo uruchomiony bez reszty folderu (np. prosto z archiwum ZIP)
brak_plikow() {
  echo
  echo "Brakuje plików aplikacji obok tego skryptu (nie ma: $1)."
  echo "Najczęściej znaczy to, że archiwum ZIP nie zostało rozpakowane w całości"
  echo "albo ten plik skopiowano bez reszty folderu."
  echo "Co zrobić: rozpakuj CAŁE archiwum (dwuklik na pliku .zip w Finderze),"
  echo "otwórz rozpakowany folder i uruchom „Uruchom serwer (Mac).command” z niego."
  zakoncz 1
}
for plik in server.js runtime-lokalny.js fonts/fonts.css; do
  [ -f "$plik" ] || brak_plikow "$plik"
done
if [ ! -f index.html ] && { [ ! -f narzedzia/zbuduj.js ] || [ ! -f zrodlo/aplikacja.html ]; }; then
  brak_plikow "index.html"
fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Nie znaleziono programu Node.js — jest potrzebny do uruchomienia serwera."
  echo "Zainstaluj go ze strony https://nodejs.org (wersja LTS), a potem uruchom ten plik ponownie."
  open "https://nodejs.org/" >/dev/null 2>&1
  zakoncz 1
fi

if ! node -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)'; then
  echo
  echo "Zainstalowany Node.js ($(node -v)) jest za stary — potrzebna jest wersja 18 lub nowsza."
  echo "Pobierz aktualną wersję LTS ze strony https://nodejs.org"
  zakoncz 1
fi

if [ ! -f index.html ]; then
  node narzedzia/zbuduj.js || zakoncz 1
fi

export PORT="${PORT:-8080}"
node server.js --otworz
kod=$?
if [ "$kod" -ne 0 ]; then zakoncz "$kod"; fi
